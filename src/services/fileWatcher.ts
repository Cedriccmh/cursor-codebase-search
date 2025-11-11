import chokidar from "chokidar";
import path from "path";
import { saveWorkspaceState, loadWorkspaceState } from "./stateManager.js";
import { clearIgnoreCache } from "../utils/fs.js";
import { getLogger } from "../utils/logger.js";

export function startFileWatcher(workspacePath: string): void {
  const log = getLogger("FileWatcher");

  const ignored = [/(^|[\\/])\../, /node_modules/, /dist/, /build/, /.nyc_output/, /coverage/];
  const watcher = chokidar.watch(workspacePath, {
    ignored,
    persistent: true,
    ignoreInitial: true,
  });

  log.info("Watch initialization", { workspacePath, ignored: ignored.map((r) => String(r)) });

  const debounceMs = parseInt(process.env.WATCHER_DEBOUNCE_MS || "200", 10);
  let timer: NodeJS.Timeout | null = null;
  const pending = new Set<string>();

  const flush = async () => {
    const count = pending.size;
    if (count > 0) {
      log.debug("Debounce flush", { count, sample: Array.from(pending).slice(0, 5) });
      pending.clear();
      await markChanged();
    }
  };

  const schedule = (filePath: string) => {
    pending.add(filePath);
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      await flush();
    }, debounceMs);
  };

  const markChanged = async () => {
    try {
      const st = await loadWorkspaceState(workspacePath);
      if (!st.codebaseId || !st.pathKey) {
        log.warn("Incomplete state; skip marking pendingChanges", { workspacePath });
        return;
      }
      st.pendingChanges = true;
      await saveWorkspaceState(st);
      log.debug("Marked workspace as changed", { workspacePath });
    } catch (err) {
      const e = err as Error;
      log.error("Failed to mark workspace as changed", { workspacePath, error: e?.message });
    }
  };

  const onFsEvent = (evt: string) => (filePath: string) => {
    const rel = path.relative(workspacePath, filePath);
    log.debug("FS event", { event: evt, path: rel });

    const name = path.basename(filePath);
    if (name === ".gitignore" || name === ".cursorignore") {
      clearIgnoreCache(workspacePath);
      log.info("Ignore patterns changed; cleared cache", { file: name });
    }

    schedule(filePath);
  };

  watcher.on("add", onFsEvent("add"));
  watcher.on("change", onFsEvent("change"));
  watcher.on("unlink", onFsEvent("unlink"));
  watcher.on("addDir", onFsEvent("addDir"));
  watcher.on("unlinkDir", onFsEvent("unlinkDir"));
  watcher.on("raw", (event, rawPath, details) => {
    try { log.debug("Raw event", { event, path: rawPath, details }); } catch { /* ignore */ }
  });
  watcher.on("ready", () => log.info("Watcher ready", { workspacePath }));
  watcher.on("error", (err) => {
    const e = err as Error;
    log.error("Watcher error", { workspacePath, error: e?.message });
  });

  const onExit = () => log.info("Watcher shutdown", { workspacePath });
  process.once("SIGINT", onExit);
  process.once("SIGTERM", onExit);
  process.once("exit", onExit);
}
