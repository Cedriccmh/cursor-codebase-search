import path from "path";
import fs from "fs-extra";
import crypto from "crypto";
import cliProgress from "cli-progress";
import { MerkleClient } from "@anysphere/file-service";
import { DEFAULTS } from "../utils/env.js";
import { listFiles, readEmbeddableFilesList, shouldIgnore } from "../utils/fs.js";
import { Semaphore } from "../utils/semaphore.js";
import { V1MasterKeyedEncryptionScheme, decryptPathToRelPosix, encryptPathWindows, genPathKey, sha256Hex } from "../crypto/pathEncryption.js";
import { ensureIndexCreated, fastRepoInitHandshakeV2, fastRepoSyncComplete, fastUpdateFileV2, syncMerkleSubtreeV2 } from "../client/cursorApi.js";
import { loadWorkspaceState, saveWorkspaceState, WorkspaceState, setRuntimeCodebaseId, getRuntimeCodebaseId } from "./stateManager.js";
import { startFileWatcher } from "./fileWatcher.js";
import { getLogger } from "../utils/logger.js";

export type IndexerContext = { authToken: string; baseUrl: string };

const indexLogger = getLogger("Indexer");

export function createRepositoryIndexer(ctx: IndexerContext) {
  async function buildAncestorSpline(relPath: string) {
    const parts = relPath.split(path.sep);
    const spline: { relativeWorkspacePath: string }[] = [];
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current = path.join(current, parts[i]);
      const rp = current || ".";
      spline.push({ relativeWorkspacePath: rp });
    }
    if (spline.length === 0) spline.push({ relativeWorkspacePath: "." });
    return spline;
  }

  async function merkleBuild(workspacePath: string) {
    const merkle = new MerkleClient({ "": workspacePath });
    const walkCfg = { maxNumFiles: DEFAULTS.SYNC_LIST_LIMIT } as any;
    await merkle.build(true, walkCfg);
    return merkle;
  }

  function createRepositoryPb(workspacePath: string, seed: number, repoName: string) {
    return {
      relativeWorkspacePath: ".",
      isTracked: false,
      isLocal: true,
      numFiles: 0,
      orthogonalTransformSeed: seed,
      preferredEmbeddingModel: "EMBEDDING_MODEL_UNSPECIFIED",
      workspaceUri: "",
      repoName,
      repoOwner: "local-user",
      remoteUrls: [],
      remoteNames: [],
    };
  }

  async function initialHandshake(merkle: MerkleClient, st: WorkspaceState, pathKey: string, baseUrl: string, authToken: string, repoName: string) {
    indexLogger.debug("initialHandshake called", { pathKeyPrefix: pathKey.substring(0, 20) });
    const rootHash = await merkle.getSubtreeHash("");
    const simhash = Array.from(await merkle.getSimhash());
    const pathKeyHash = sha256Hex(pathKey);
    indexLogger.debug("Computed pathKeyHash", { pathKeyHash });
    const repositoryPb = createRepositoryPb(st.workspacePath, st.orthogonalTransformSeed!, repoName);
    const req = {
      repository: repositoryPb,
      rootHash,
      similarityMetricType: "SIMILARITY_METRIC_TYPE_SIMHASH",
      similarityMetric: simhash.map((n) => Number(n)),
      pathKeyHash,
      pathKeyHashType: "PATH_KEY_HASH_TYPE_SHA256",
      pathKey,
    };
    const res = await fastRepoInitHandshakeV2(baseUrl, authToken, req);
    const codebaseId = res?.codebases?.[0]?.codebase_id || res?.codebases?.[0]?.codebaseId;
    if (!codebaseId) throw new Error("No codebase_id in handshake response");

    // Extract codebase status from server response
    const codebaseStatus = res?.codebases?.[0]?.status;

    // Check if this is an existing codebase on the server
    // STATUS_UP_TO_DATE = 1, STATUS_OUT_OF_SYNC = 2
    const isExistingCodebase =
      codebaseStatus === "STATUS_UP_TO_DATE" ||
      codebaseStatus === 1 ||
      codebaseStatus === "STATUS_OUT_OF_SYNC" ||
      codebaseStatus === 2;

    // Check if local state has pathKey stored
    const hasLocalPathKey = !!(st.pathKey && st.pathKeyHash);
    indexLogger.debug("Handshake state", { isExistingCodebase, hasLocalPathKey });
    indexLogger.debug("Local pathKey", { prefix: st.pathKey ? st.pathKey.substring(0, 20) : null });
    indexLogger.debug("Local pathKeyHash", { pathKeyHash: st.pathKeyHash || null });

    // If server returned an existing codebase but we don't have a local pathKey,
    // this indicates a pathKey mismatch risk (e.g., after deleting state file).
    // Force creation of a new codebaseId to avoid decryption errors.
    if (isExistingCodebase && !hasLocalPathKey) {
      indexLogger.warn("Server returned existing codebase but local pathKey is missing");
      indexLogger.warn("Potential pathKey mismatch; local state missing", { reason: "state file deleted?" });
      indexLogger.warn("Forcing creation of new codebaseId to avoid path decryption errors");
      indexLogger.debug("Current pathKey prefix", { prefix: pathKey.substring(0, 20) });

      // Modify repoName with timestamp and random suffix to force new codebaseId
      const timestamp = Date.now();
      const randomSuffix = Math.random().toString(36).slice(2, 8);
      const newRepoName = `${repoName}-${timestamp}-${randomSuffix}`;

      indexLogger.debug("Original repoName", { repoName });
      indexLogger.debug("Modified repoName", { newRepoName });

      // Create new repository object with modified repoName
      const newRepositoryPb = createRepositoryPb(st.workspacePath, st.orthogonalTransformSeed!, newRepoName);

      // Create new request with modified repository
      const newReq = {
        repository: newRepositoryPb,
        rootHash,
        similarityMetricType: "SIMILARITY_METRIC_TYPE_SIMHASH",
        similarityMetric: simhash.map((n) => Number(n)),
        pathKeyHash,
        pathKeyHashType: "PATH_KEY_HASH_TYPE_SHA256",
        pathKey,
      };

      // Make second handshake request with modified repoName
      const newRes = await fastRepoInitHandshakeV2(baseUrl, authToken, newReq);
      const newCodebaseId = newRes?.codebases?.[0]?.codebase_id || newRes?.codebases?.[0]?.codebaseId;

      if (!newCodebaseId) {
        throw new Error("Failed to create new codebase_id with modified repoName");
      }

      indexLogger.info("Created new codebase", { codebaseId: newCodebaseId });
      indexLogger.info("New codebase will use current pathKey for all files");

      // Return the new codebaseId, modified repositoryPb, and modified repoName
      return {
        codebaseId: newCodebaseId,
        repositoryPb: newRepositoryPb,
        simhash: simhash.map((n) => Number(n)),
        pathKeyHash,
        repoName: newRepoName  // Return the modified repoName
      };
    }

    // Normal case: either new codebase or existing codebase with matching pathKey
    return { codebaseId, repositoryPb, simhash: simhash.map((n) => Number(n)), pathKeyHash, repoName };
  }

  /**
   * Validates that the pathKey matches the stored pathKeyHash for a given codebaseId.
   * This prevents path decryption errors when the server returns a codebaseId that was
   * indexed with a different pathKey.
   *
   * @param codebaseId - The codebaseId returned from the server
   * @param pathKey - The current pathKey being used
   * @param st - The workspace state containing stored pathKeyHash
   * @returns Object with validation result and optional warning message
   */
  function validateCodebasePathKey(
    codebaseId: string,
    pathKey: string,
    st: WorkspaceState
  ): { isValid: boolean; warning?: string; action?: string } {
    const currentPathKeyHash = sha256Hex(pathKey);

    // If this is a new codebaseId (different from stored), accept it
    if (!st.codebaseId || st.codebaseId !== codebaseId) {
      return { isValid: true };
    }

    // If we have a stored pathKeyHash for this codebaseId, verify it matches
    if (st.pathKeyHash && st.pathKeyHash !== currentPathKeyHash) {
      const warning = [
        "⚠️  PathKey Mismatch Detected!",
        `   CodebaseId: ${codebaseId}`,
        `   Stored pathKeyHash:  ${st.pathKeyHash}`,
        `   Current pathKeyHash: ${currentPathKeyHash}`,
        "",
        "   This means the server returned a codebaseId that was indexed with a different pathKey.",
        "   Search results will show garbled/corrupted paths because decryption will fail.",
        "",
        "   Recommended actions:",
        "   1. Use the stored pathKey to maintain consistency",
        "   2. Or delete the state file and re-index to create a fresh codebase",
        "   3. Or use --force-new flag (if available) to force a new codebaseId",
      ].join("\n");

      return {
        isValid: false,
        warning,
        action: "pathkey_mismatch"
      };
    }

    // If no stored pathKeyHash, this is the first time - accept it
    return { isValid: true };
  }

  async function uploadFilesChunk(
    filesAbs: string[],
    workspacePath: string,
    scheme: V1MasterKeyedEncryptionScheme,
    orthogonalTransformSeed: number,
    codebaseId: string,
    baseUrl: string,
    authToken: string,
    encryptedToPlainPath: Record<string, string>,
  ) {
    const sem = new Semaphore(DEFAULTS.SYNC_CONCURRENCY);
    let uploaded = 0;
    await Promise.all(
      filesAbs.map((abs) => sem.withRetrySemaphore(async () => {
        const relPosix = path.relative(workspacePath, abs).replace(/\\/g, "/");
        const relDisplay = (relPosix.startsWith(".") ? relPosix : "./" + relPosix).replace(/\//g, "\\");
        let contents = "";
        try {
          const buf = await fs.readFile(abs);
          if (buf.length > DEFAULTS.FILE_SIZE_LIMIT_BYTES) return; // skip large
          contents = buf.toString("utf8");
        } catch {
          return; // skip unreadable
        }
        const enc = encryptPathWindows(scheme, relPosix);
        const localFilePb = {
          file: { relativeWorkspacePath: enc, contents },
          hash: sha256Hex(contents),
          unencryptedRelativeWorkspacePath: relDisplay,
        };
        try {
          const encWin = localFilePb.file.relativeWorkspacePath as string;
          const encFwd = encWin.replace(/\\/g, "/");
          const encNoDot = encWin.startsWith(".\\") ? encWin.slice(2) : encWin;
          const encNoDotFwd = encNoDot.replace(/\\/g, "/");
          encryptedToPlainPath[encWin] = relDisplay;
          encryptedToPlainPath[encFwd] = relDisplay;
          encryptedToPlainPath[encNoDot] = relDisplay;
          encryptedToPlainPath[encNoDotFwd] = relDisplay;
        } catch { /* noop */ }
        const ancestorSplinePb = (await buildAncestorSpline(relPosix)).map((x) => ({
          relativeWorkspacePath: encryptPathWindows(scheme, x.relativeWorkspacePath).replace(/\//g, "\\\\"),
        }));
        const payload = {
          clientRepositoryInfo: { orthogonalTransformSeed },
          codebaseId,
          localFile: localFilePb,
          ancestorSpline: ancestorSplinePb,
          updateType: 1,
        };

        // This will throw if it fails, allowing withRetrySemaphore to retry
        await fastUpdateFileV2(baseUrl, authToken, payload);
        uploaded++;
      }, undefined, DEFAULTS.SEMAPHORE_RETRY_COUNT, {
        retries: DEFAULTS.SEMAPHORE_RETRY_COUNT,
        delayMs: DEFAULTS.SEMAPHORE_RETRY_DELAY_MS,
        logRetries: true,
        operationName: `File upload: ${path.basename(abs)}`
      }).catch(() => {
        // Additional context logging after all retries failed
        // The detailed error has already been logged by withRetrySemaphore
        indexLogger.error(
          `Skipping file and continuing with next file: ${path.basename(abs)}`
        );
        // Continue processing other files despite this failure
      }))
    );
    return uploaded;
  }

  async function runEnsureAndSyncComplete(baseUrl: string, authToken: string, repositoryPb: any, codebaseId: string, simhash: number[], pathKeyHash: string) {
    indexLogger.debug("Ensure index & sync", { codebaseId });

    await ensureIndexCreated(baseUrl, authToken, repositoryPb);
    await fastRepoSyncComplete(baseUrl, authToken, {
      codebases: [
        {
          codebaseId,
          status: "STATUS_SUCCESS",
          similarityMetricType: "SIMILARITY_METRIC_TYPE_SIMHASH",
          similarityMetric: simhash,
          pathKeyHash,
          pathKeyHashType: "PATH_KEY_HASH_TYPE_SHA256",
        },
      ],
    });
    indexLogger.debug("Sync complete recorded", { codebaseId });

  }


  async function incrementalSync(
    workspacePath: string,
    merkle: MerkleClient,
    codebaseId: string,
    scheme: V1MasterKeyedEncryptionScheme,
    baseUrl: string,
    authToken: string,
    orthogonalTransformSeed: number,
  ) {
    indexLogger.info("Incremental sync started", { workspacePath, codebaseId });

    const queue: string[] = ["."];
    const visited = new Set<string>();
    const r = new Set<string>();
    const n = new Set<string>();
    const s = new Set<string>();
    const abortController = new AbortController();
    const sem = new Semaphore(DEFAULTS.SYNC_CONCURRENCY, abortController.signal);

    async function listDirectChildren(relPosix: string) {
      const absDir = relPosix === "." ? workspacePath : path.join(workspacePath, relPosix);
      const out: { relPosix: string; isDir: boolean; isFile: boolean }[] = [];
      try {
        const entries = await fs.readdir(absDir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(absDir, e.name);
          if (shouldIgnore(full, workspacePath)) continue;
          const rel = path.relative(workspacePath, full).replace(/\\/g, "/");
          out.push({ relPosix: rel === "" ? "." : rel, isDir: e.isDirectory(), isFile: e.isFile() });
        }
      } catch { /* noop */ }
      return out;
    }

    async function processNode(relPosix: string) {
      if (!relPosix || visited.has(relPosix)) return;
      visited.add(relPosix);
      let hash = "";
      try {
        hash = await merkle.getSubtreeHash(relPosix === "." ? "" : relPosix);
      } catch {
        return;
      }
      const encPath = encryptPathWindows(scheme, relPosix === "." ? "" : relPosix);
      let syncRes: any;
      try {
        syncRes = await syncMerkleSubtreeV2(ctx.baseUrl, ctx.authToken, {
          clientRepositoryInfo: { orthogonalTransformSeed },
          codebaseId,
          localPartialPath: { relativeWorkspacePath: encPath, hashOfNode: hash },
        });
      } catch {
        return;
      }
      const match = !!(syncRes && syncRes.match);
      if (match) return;
      const childrenHint = (syncRes && syncRes.mismatch && syncRes.mismatch.children) || [];
      if (childrenHint && childrenHint.length > 0) {
        const localChildren = await listDirectChildren(relPosix);
        const decryptedChildren: { enc: string; plain: string; isDir?: boolean; isFile?: boolean }[] = [];
        for (const child of childrenHint) {
          const encChild = child.relative_workspace_path || child.relativeWorkspacePath;
          let plain: string | undefined;
          try { plain = decryptPathToRelPosix(scheme, encChild); } catch { /* noop */ }
          if (!plain) continue;
          const mapping = localChildren.find((c) => c.relPosix === plain);
          decryptedChildren.push({ enc: encChild, plain, isDir: mapping?.isDir, isFile: mapping?.isFile });
        }
        const localHashMap = new Map<string, string>();
        for (const c of decryptedChildren) {
          try { localHashMap.set(c.plain, await merkle.getSubtreeHash(c.plain)); } catch { localHashMap.set(c.plain, "-1"); }
        }
        const misMatched: { plain: string; isDir?: boolean; isFile?: boolean }[] = [];
        for (const c of childrenHint) {
          const enc = c.relative_workspace_path || c.relativeWorkspacePath;
          const dec = decryptedChildren.find((x) => x.enc === enc);
          if (!dec) continue;
          const serverH = c.hashOfNode || c.hash_of_node || "";
          const localH = localHashMap.get(dec.plain) || "";
          if (!(serverH === localH || localH === "-1" || localH === "")) {
            misMatched.push({ plain: dec.plain, isDir: dec.isDir, isFile: dec.isFile });
          }
        }
        const entries = await listDirectChildren(relPosix);
        const trueFiles = entries.filter((e) => e.isFile).map((e) => e.relPosix);
        const trueDirs = entries.filter((e) => e.isDir).map((e) => e.relPosix);
        misMatched.filter((x) => trueFiles.includes(x.plain)).forEach((x) => r.add(x.plain));
        misMatched.filter((x) => trueDirs.includes(x.plain)).forEach((x) => queue.push(x.plain));
        const resolvedPlain = decryptedChildren.map((x) => x.plain);
        const newDirs = trueDirs.filter((p) => !resolvedPlain.includes(p));
        const newFiles = trueFiles.filter((p) => !resolvedPlain.includes(p));
        newDirs.forEach((p) => n.add(p));
        newFiles.forEach((p) => s.add(p));
        return;
      }
      const kids = await listDirectChildren(relPosix);
      if (kids.length === 0) {
        if (relPosix !== ".") s.add(relPosix);
      } else {
        for (const k of kids) {
          if (k.isDir) queue.push(k.relPosix);
          if (k.isFile) r.add(k.relPosix);
        }
      }
    }

    const running = new Set<Promise<void>>();
    let iterations = 0;
    while ((queue.length > 0 && iterations < DEFAULTS.SYNC_MAX_ITERATIONS) || running.size > 0) {
      while (queue.length > 0 && iterations < DEFAULTS.SYNC_MAX_ITERATIONS) {
        const relPosix = queue.shift();
        if (!relPosix) break;
        if (visited.has(relPosix)) continue;
        iterations++;
        const task = sem.withRetrySemaphore(() => processNode(relPosix), undefined, DEFAULTS.SEMAPHORE_RETRY_COUNT, {
          retries: DEFAULTS.SEMAPHORE_RETRY_COUNT,
          delayMs: DEFAULTS.SEMAPHORE_RETRY_DELAY_MS,
          logRetries: true,
          operationName: `Sync node: ${relPosix}`
        })
          .catch(() => {})
          .finally(() => running.delete(task as any));
        running.add(task as any);
      }
      if (running.size > 0) await Promise.race(running);
    }

    const changed = Array.from(new Set<string>([...Array.from(r), ...Array.from(s)]));
    indexLogger.info("Incremental sync result", { changed: changed.length });
    return changed;
  }


  function chunkArray<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  const startedWatchers = new Set<string>();
  const scheduled = new Set<string>();


  async function indexProject(params: { workspacePath: string; verbose?: boolean }) {
    const workspacePath = path.resolve(params.workspacePath);
    let st = await loadWorkspaceState(workspacePath);
    indexLogger.info("Indexing started", { workspacePath });

    if (!st.orthogonalTransformSeed) {
      st.orthogonalTransformSeed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    }
    let pathKey = st.pathKey;
    indexLogger.debug("Loaded pathKey from state", { prefix: pathKey ? pathKey.substring(0, 20) : null });
    if (!pathKey) {
      pathKey = genPathKey();
      indexLogger.info("Generated new pathKey", { prefix: pathKey.substring(0, 20) });
    }
    indexLogger.debug("PathKey hash", { pathKeyHash: sha256Hex(pathKey) });
    const scheme = new V1MasterKeyedEncryptionScheme(pathKey);
    // embeddableFilesPath is fixed under per-project directory
    const projectDir = (await import("./stateManager.js" as any)).getWorkspaceProjectDir(workspacePath);
    const defaultListPath = path.join(projectDir, "embeddable_files.txt");
    await fs.ensureDir(path.dirname(defaultListPath));
    if (!(await fs.pathExists(defaultListPath))) {
      const discovered = await listFiles(workspacePath, DEFAULTS.SYNC_LIST_LIMIT);
      await fs.writeFile(defaultListPath, discovered.map((p) => path.relative(workspacePath, p).replace(/\\/g, "/")).join("\n"), "utf8");
    }
    const merkle = await merkleBuild(workspacePath);
    const allFilesAbs = await readEmbeddableFilesList(workspacePath, defaultListPath);
    if (allFilesAbs.length === 0) {
      throw new Error("embeddableFilesPath yielded empty file list");
    }
    const filtered = allFilesAbs.filter((abs) => {
      try { const s = fs.statSync(abs); return s.isFile() && s.size <= DEFAULTS.FILE_SIZE_LIMIT_BYTES; } catch { return false; }
    });
    const batches = chunkArray(filtered, DEFAULTS.INITIAL_UPLOAD_MAX_FILES);
    indexLogger.info("Discovered files", { discovered: allFilesAbs.length, filtered: filtered.length });
    indexLogger.debug("Prepared upload batches", { batches: batches.length, batchSizeMax: DEFAULTS.INITIAL_UPLOAD_MAX_FILES });

    // Use stable repoName for consistent server mapping; persist it in state
    const repoName = st.repoName || `local-${crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 12)}`;

    // Perform initial handshake ONCE before processing batches

    // This ensures all batches use the same codebaseId
    const { codebaseId, repositoryPb, simhash, pathKeyHash, repoName: finalRepoName } = await initialHandshake(
      merkle,
      { ...st, workspacePath, orthogonalTransformSeed: st.orthogonalTransformSeed },
      pathKey!,
      ctx.baseUrl,
      ctx.authToken,
      repoName,
    );

    indexLogger.info("Handshake complete", { codebaseId, repoName: finalRepoName });

    // Validate pathKey matches for this codebaseId
    const validation = validateCodebasePathKey(codebaseId, pathKey!, st);
    if (!validation.isValid) {
      indexLogger.error(validation.warning ?? "PathKey mismatch detected.");
      throw new Error("PathKey mismatch detected. Cannot proceed with indexing.");
    }

    // CRITICAL FIX: Save pathKey immediately after handshake to ensure it's persisted
    // This prevents pathKey mismatch on subsequent indexing operations
    indexLogger.info("Saving pathKey immediately after handshake");
    st = {
      ...st,
      workspacePath,
      pathKey,
      pathKeyHash,
      codebaseId,
      repoName: finalRepoName,  // Use the repoName returned from initialHandshake (may be modified)
      orthogonalTransformSeed: st.orthogonalTransformSeed,
      repoOwner: st.repoOwner || "local-user",
    };
    await saveWorkspaceState(st);
    indexLogger.info("PathKey saved successfully after handshake");

    // Now process all batches using the same codebaseId
    const encryptedToPlainPath: Record<string, string> = {};
    let totalUploaded = 0;
    const uploadedFilesVerbose: string[] = [];

    // Create progress bar
    const totalFiles = filtered.length;
    const totalBatches = batches.length;
    indexLogger.info("Starting upload", { totalFiles, totalBatches });

    const progressBar = new cliProgress.SingleBar({
      format: '📤 Uploading |{bar}| {percentage}% | {value}/{total} files | Batch {batch}/{totalBatches} | ETA: {eta}s',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
      stopOnComplete: true,
      clearOnComplete: false,
    });

    progressBar.start(totalFiles, 0, { batch: 0, totalBatches });

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      indexLogger.debug("Uploading batch", { batchNum: i + 1, batchSize: batch.length });

      const batchNum = i + 1;

      // Update progress bar with current batch
      progressBar.update(totalUploaded, { batch: batchNum, totalBatches });

      // upload chunk
      const uploadedCount = await uploadFilesChunk(batch, workspacePath, scheme, st.orthogonalTransformSeed!, codebaseId, ctx.baseUrl, ctx.authToken, encryptedToPlainPath);
      totalUploaded += uploadedCount;

      // Update progress bar after upload
      progressBar.update(totalUploaded, { batch: batchNum, totalBatches });

      if (params.verbose) {
        for (const abs of batch) {
          const rel = path.relative(workspacePath, abs).replace(/\\/g, "/");
          uploadedFilesVerbose.push(rel === "" ? "." : rel);
        }
      }

      // ensure + sync complete for this chunk
      await runEnsureAndSyncComplete(ctx.baseUrl, ctx.authToken, repositoryPb, codebaseId, simhash, pathKeyHash);
      setRuntimeCodebaseId(workspacePath, codebaseId);
    }

    progressBar.stop();

    indexLogger.info("Upload complete", { uploaded: totalUploaded, batches: batches.length });


    // Calculate final pathKeyHash for storage
    const finalPathKeyHash = sha256Hex(pathKey!);
    indexLogger.debug("Saving state", { pathKeyPrefix: pathKey!.substring(0, 20) });
    indexLogger.debug("Saving state pathKeyHash", { pathKeyHash: finalPathKeyHash });
    indexLogger.debug("Saving state codebaseId", { codebaseId });
    indexLogger.debug("Saving state repoName", { repoName: finalRepoName });

    st = {
      ...st,
      workspacePath,
      pathKey,
      pathKeyHash: finalPathKeyHash,
      codebaseId: codebaseId,
      repoName: finalRepoName,  // Use the repoName returned from initialHandshake (may be modified)
      repoOwner: st.repoOwner || "local-user",
      pendingChanges: false,
    };
    await saveWorkspaceState(st);
    indexLogger.info("State saved successfully");
    // start watcher and schedule auto-sync
    if (!startedWatchers.has(workspacePath)) {
    indexLogger.debug("State saved", { codebaseId, repoName: finalRepoName });

      startFileWatcher(workspacePath);
      startedWatchers.add(workspacePath);
    }
    if (!scheduled.has(workspacePath)) {
      scheduleAutoSync(workspacePath);
      scheduled.add(workspacePath);
    }
    const base = { codebaseId: codebaseId, uploaded: totalUploaded, batches: batches.length, nextSyncAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() } as any;
    if (params.verbose) base.files = uploadedFilesVerbose;
    return base;
  }

  async function autoSyncIfNeeded(workspacePath: string) {
    const st = await loadWorkspaceState(workspacePath);
    const runtimeId = getRuntimeCodebaseId(workspacePath) || st.codebaseId;
    if (!runtimeId || !st.pathKey || !st.orthogonalTransformSeed) return;
    // Prime runtime cache if needed
    if (!getRuntimeCodebaseId(workspacePath) && runtimeId) setRuntimeCodebaseId(workspacePath, runtimeId);
    indexLogger.debug("Auto-sync check", { workspacePath, pendingChanges: st.pendingChanges, runtimeIdPresent: !!runtimeId });

    const merkle = await merkleBuild(workspacePath);
    if (!st.pendingChanges) return;
    const scheme = new V1MasterKeyedEncryptionScheme(st.pathKey);
    const changed = await incrementalSync(workspacePath, merkle, runtimeId, scheme, ctx.baseUrl, ctx.authToken, st.orthogonalTransformSeed);
    if (changed.length === 0) return;
    // upload changed files
    indexLogger.debug("Auto-sync changed files", { count: changed.length });

    await uploadFilesChunk(
      changed.map((rp) => path.join(workspacePath, rp)),
      workspacePath,
      scheme,
      st.orthogonalTransformSeed,
      runtimeId,
      ctx.baseUrl,
      ctx.authToken,
      {},
    );
    const pathKeyHash = sha256Hex(st.pathKey);
    const simhash = Array.from(await merkle.getSimhash()).map((n) => Number(n));
    const repositoryPb = createRepositoryPb(workspacePath, st.orthogonalTransformSeed, st.repoName || `local-${crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 12)}`);
    await runEnsureAndSyncComplete(ctx.baseUrl, ctx.authToken, repositoryPb, runtimeId, simhash, pathKeyHash);
    st.pendingChanges = false;
    await saveWorkspaceState(st);
  }

  function scheduleAutoSync(workspacePath: string) {
    setInterval(() => { void autoSyncIfNeeded(workspacePath); }, DEFAULTS.AUTO_SYNC_INTERVAL_MS);
  }

  return { indexProject, autoSyncIfNeeded, scheduleAutoSync };
}

