import fs from "fs-extra";
import path from "path";
import { Mutex } from "async-mutex";
import { logger } from "../utils/logger.js";
import { getProjectDirForWorkspace, getProjectRootDir } from "../utils/env.js";

export type WorkspaceState = {
  workspacePath: string;
  codebaseId?: string;
  pathKey?: string;
  pathKeyHash?: string;
  orthogonalTransformSeed?: number;
  repoName?: string;
  repoOwner?: string;
  // Ephemeral (not persisted):
  pendingChanges?: boolean;
};

// Per-workspace mutex to serialize state reads/writes
const workspaceMutexes = new Map<string, Mutex>();
function getWorkspaceMutex(workspacePath: string): Mutex {
  let m = workspaceMutexes.get(workspacePath);
  if (!m) {
    m = new Mutex();
    workspaceMutexes.set(workspacePath, m);
  }
  return m;
}

function getWorkspaceStateFile(workspacePath: string): string {
  const dir = getProjectDirForWorkspace(workspacePath);
  return path.join(dir, "state.json");
}

export async function loadWorkspaceState(workspacePath: string): Promise<WorkspaceState> {
  const file = getWorkspaceStateFile(workspacePath);
  await fs.ensureDir(path.dirname(file));
  const lock = getWorkspaceMutex(workspacePath);
  return await lock.runExclusive(async () => {
    try {
      const st = (await fs.readJSON(file)) as WorkspaceState;
      if (!st || !st.workspacePath) {
        logger.warn(`[state] Loaded invalid or incomplete state; returning minimal state`, { file, workspacePath });
        return { workspacePath };
      }
      return st;
    } catch (err) {
      logger.warn(`[state] Failed to read state.json, returning minimal state`, { file, workspacePath, error: err instanceof Error ? err.message : String(err) });
      return { workspacePath };
    }
  });
}

export async function saveWorkspaceState(st: WorkspaceState): Promise<void> {
  const file = getWorkspaceStateFile(st.workspacePath);
  await fs.ensureDir(path.dirname(file));
  const lock = getWorkspaceMutex(st.workspacePath);
  await lock.runExclusive(async () => {
    const toPersist: WorkspaceState = {
      workspacePath: st.workspacePath,
      codebaseId: st.codebaseId,
      pathKey: st.pathKey,
      pathKeyHash: st.pathKeyHash,
      orthogonalTransformSeed: st.orthogonalTransformSeed,
      repoName: st.repoName,
      repoOwner: st.repoOwner,
    };
    const tmp = file + ".tmp";
    try {
      try { await fs.remove(tmp); } catch {}
      await fs.writeJSON(tmp, toPersist, { spaces: 2 });
      await fs.move(tmp, file, { overwrite: true });
    } catch (err) {
      logger.logError(`[state] Failed to persist state.json`, err, { file, workspacePath: st.workspacePath });
      try { await fs.remove(tmp); } catch {}
      throw err;
    }
  });
}

export function getWorkspaceProjectDir(workspacePath: string): string {
  return getProjectDirForWorkspace(workspacePath);
}

export async function listIndexedWorkspaces(): Promise<string[]> {
  const root = getProjectRootDir();
  await fs.ensureDir(root);
  const out = new Set<string>();
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      const stFile = path.join(dir, "state.json");
      try {
        const st = (await fs.readJSON(stFile)) as WorkspaceState;
        if (st && st.workspacePath) out.add(st.workspacePath);
      } catch {
        // ignore invalid state files
      }
    }
  } catch {
    // noop
  }
  return Array.from(out);
}

// Runtime-only cache for codebaseId mapping; persisted copy lives in state.json.
const runtimeCodebaseIds = new Map<string, string>();

export function setRuntimeCodebaseId(workspacePath: string, codebaseId: string): void {
  runtimeCodebaseIds.set(workspacePath, codebaseId);
}

export function getRuntimeCodebaseId(workspacePath: string): string | undefined {
  return runtimeCodebaseIds.get(workspacePath);
}

export function clearRuntimeCodebaseId(workspacePath: string): void {
  runtimeCodebaseIds.delete(workspacePath);
}

// Active workspace tracking
export type ActiveWorkspaceState = {
  activeWorkspacePath: string | null;
};

function getActiveWorkspaceFile(): string {
  const root = getProjectRootDir();
  return path.join(root, "active.json");
}

export async function loadActiveWorkspace(): Promise<string | null> {
  const file = getActiveWorkspaceFile();
  try {
    const data = (await fs.readJSON(file)) as ActiveWorkspaceState;
    return data.activeWorkspacePath || null;
  } catch {
    return null;
  }
}

export async function saveActiveWorkspace(workspacePath: string | null): Promise<void> {
  const file = getActiveWorkspaceFile();
  await fs.ensureDir(path.dirname(file));
  const data: ActiveWorkspaceState = { activeWorkspacePath: workspacePath };
  await fs.writeJSON(file, data, { spaces: 2 });
}

export async function getActiveWorkspace(): Promise<string | null> {
  return await loadActiveWorkspace();
}

export async function setActiveWorkspace(workspacePath: string): Promise<void> {
  await saveActiveWorkspace(workspacePath);
}

export async function clearActiveWorkspace(): Promise<void> {
  await saveActiveWorkspace(null);
}

