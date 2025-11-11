import fs from "fs-extra";
import path from "path";
import { getProjectRootDir } from "./env.js";

export type LogLevel = "debug" | "info" | "warning" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warning: 2, error: 3 };
const LEVEL_LABEL: Record<LogLevel, string> = { debug: "DEBUG", info: "INFO", warning: "WARN", error: "ERROR" };

class RollingFileAppender {
  private filePath: string;
  private maxSizeBytes: number;
  private maxBackups: number;
  private size: number = 0;

  constructor(filePath: string, maxSizeBytes: number, maxBackups: number) {
    this.filePath = filePath;
    this.maxSizeBytes = maxSizeBytes;
    this.maxBackups = Math.max(0, maxBackups);

    const dir = path.dirname(this.filePath);
    try {
      fs.ensureDirSync(dir, { mode: process.platform === "win32" ? undefined : 0o700 });
    } catch {
      // Fall through: if directory creation fails, file writes will throw and be caught later
    }

    try {
      if (fs.pathExistsSync(this.filePath)) {
        this.size = fs.statSync(this.filePath).size;
      }
    } catch {
      this.size = 0;
    }
  }

  private rotateIfNeeded(extraBytes: number) {
    if (this.maxSizeBytes <= 0) return;
    if (this.size + extraBytes < this.maxSizeBytes) return;

    // Simple numeric rotation: file.log -> file.log.1 -> ...
    for (let i = this.maxBackups; i >= 1; i--) {
      const src = i === 1 ? this.filePath : `${this.filePath}.${i - 1}`;
      const dst = `${this.filePath}.${i}`;
      try {
        if (fs.pathExistsSync(src)) {
          try { fs.removeSync(dst); } catch { /* ignore */ }
          fs.moveSync(src, dst, { overwrite: true });
        }
      } catch { /* ignore rotation errors */ }
    }
    this.size = 0;
  }

  append(line: string) {
    try {
      const bytes = Buffer.byteLength(line + "\n", "utf8");
      this.rotateIfNeeded(bytes);
      fs.appendFileSync(this.filePath, line + "\n", { encoding: "utf8" });
      this.size += bytes;
    } catch {
      // Swallow file logging errors to avoid affecting main flow
    }
  }
}

class Logger {
  private currentLevel: LogLevel;
  private appenders: Map<string, RollingFileAppender> = new Map();
  private logsDir: string;
  private fileLoggingEnabled: boolean = true;
  private maxSizeBytes: number;
  private maxBackups: number;

  constructor() {
    const envLevel = (process.env.LOG_LEVEL as LogLevel) || "info";
    this.currentLevel = ("debug info warning error".split(" ") as LogLevel[]).includes(envLevel)
      ? envLevel
      : "info";

    // Compute logs directory under user home .mcp-cursearch/logs
    const baseDir = getProjectRootDir();
    this.logsDir = path.join(baseDir, "logs");
    try {
      fs.ensureDirSync(this.logsDir, { mode: process.platform === "win32" ? undefined : 0o700 });
    } catch {
      this.fileLoggingEnabled = false;
    }

    const maxSizeMb = parseInt(process.env.LOG_MAX_SIZE_MB || "5", 10);
    this.maxSizeBytes = Math.max(0, maxSizeMb) * 1024 * 1024;
    this.maxBackups = parseInt(process.env.LOG_MAX_BACKUPS || "3", 10);
  }

  setLevel(level: LogLevel): void { this.currentLevel = level; }
  getLevel(): LogLevel { return this.currentLevel; }
  private shouldLog(level: LogLevel): boolean { return LEVEL_ORDER[level] >= LEVEL_ORDER[this.currentLevel]; }

  private getAppenderFor(component: string): RollingFileAppender | null {
    if (!this.fileLoggingEnabled) return null;
    const slug = component.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const fileName = component.toLowerCase() === "filewatcher" ? "filewatcher.log"
      : component.toLowerCase() === "indexer" ? "index.log"
      : `${slug || "app"}.log`;
    const fp = path.join(this.logsDir, fileName);
    if (!this.appenders.has(fp)) {
      this.appenders.set(fp, new RollingFileAppender(fp, this.maxSizeBytes, this.maxBackups));
    }
    return this.appenders.get(fp)!;
  }

  private formatLine(level: LogLevel, component: string | null, message: string, context?: Record<string, any>): string {
    const ts = new Date().toISOString();
    const lvl = LEVEL_LABEL[level];
    const comp = component ? ` [${component}]` : "";
    const base = `[${ts}] [${lvl}]${comp} ${message}`;
    if (!context) return base;
    try { return `${base} ${JSON.stringify(context)}`; } catch { return base; }
  }

  private emit(level: LogLevel, component: string | null, message: string, context?: Record<string, any>) {
    if (!this.shouldLog(level)) return;
    const line = this.formatLine(level, component, message, context);
    // Console
    if (level === "error") console.error(line);
    else if (level === "warning") console.warn(line);
    else console.log(line);
    // File per component
    if (component) this.getAppenderFor(component)?.append(line);
  }

  debug(message: string, ...args: any[]): void { this.emit("debug", null, this.stringifyMsg(message, args)); }
  info(message: string, ...args: any[]): void { this.emit("info", null, this.stringifyMsg(message, args)); }
  warn(message: string, ...args: any[]): void { this.emit("warning", null, this.stringifyMsg(message, args)); }
  error(message: string, ...args: any[]): void { this.emit("error", null, this.stringifyMsg(message, args)); }

  logError(message: string, error: unknown, context?: Record<string, any>): void {
    const ctx: Record<string, any> = context ? { ...context } : {};
    if (error instanceof Error) ctx.error = { name: error.name, message: error.message, stack: error.stack };
    else ctx.error = String(error);
    this.emit("error", null, message, ctx);
  }

  logDebug(message: string, context?: Record<string, any>): void {
    this.emit("debug", null, message, context);
  }

  private stringifyMsg(message: string, args: any[]): string {
    if (!args || args.length === 0) return message;
    const rest = args.map(a => {
      if (typeof a === "string") return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(" ");
    return `${message} ${rest}`.trim();
  }
}

class ScopedLogger {
  constructor(private root: Logger, private component: string) {}
  setLevel(level: LogLevel) { this.root.setLevel(level); }
  debug(message: string, context?: Record<string, any>) { this.root["emit"]("debug", this.component, message, context); }
  info(message: string, context?: Record<string, any>) { this.root["emit"]("info", this.component, message, context); }
  warn(message: string, context?: Record<string, any>) { this.root["emit"]("warning", this.component, message, context); }
  error(message: string, context?: Record<string, any>) { this.root["emit"]("error", this.component, message, context); }
}

export const logger = new Logger();
export function getLogger(component: string): ScopedLogger { return new ScopedLogger(logger, component); }
