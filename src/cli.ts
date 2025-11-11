#!/usr/bin/env node
import path from "path";
import { resolveAuthAndBaseUrlFromCliAndEnv } from "./utils/env.js";
import { createRepositoryIndexer } from "./services/repositoryIndexer.js";
import { logger } from "./utils/logger.js";
import {
  loadWorkspaceState,
  listIndexedWorkspaces,
  getActiveWorkspace,
  setActiveWorkspace,
  clearActiveWorkspace
} from "./services/stateManager.js";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  const { authToken, baseUrl, logLevel } = resolveAuthAndBaseUrlFromCliAndEnv(args.slice(1));
  if (logLevel) logger.setLevel(logLevel);

  try {
    switch (command) {
      case "index-activate":
        await handleIndexActivate(args.slice(1), authToken, baseUrl);
        break;
      case "list":
        await handleList();
        break;
      case "deactivate":
        await handleDeactivate();
        break;
      case "status":
        await handleStatus(args.slice(1));
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.error('Run "mcp-cursearch help" for usage information.');
        process.exit(1);
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
MCP CurSearch CLI - Manage codebase indexing for semantic search

USAGE:
  mcp-cursearch <command> [options]

COMMANDS:
  index-activate <workspace-path>   Index (if needed) and activate a workspace
  list                              List all indexed workspaces and show active
  deactivate                        Clear the active workspace
  status [workspace-path]           Show status of workspace (or active if none specified)
  help                              Show this help message

OPTIONS:
  --auth-token <token>              Cursor API authentication token (or use CURSOR_AUTH_TOKEN env)
  --base-url <url>                  Cursor API base URL (default: https://api2.cursor.sh)

EXAMPLES:
  # Index and activate a project
  mcp-cursearch index-activate C:/MyProject

  # List all indexed projects
  mcp-cursearch list

  # Show status of active project
  mcp-cursearch status

  # Deactivate current workspace
  mcp-cursearch deactivate

ENVIRONMENT VARIABLES:
  CURSOR_AUTH_TOKEN    Authentication token for Cursor API
  CURSOR_BASE_URL      Base URL for Cursor API
`);
}

async function handleIndexActivate(args: string[], authToken: string, baseUrl: string) {
  // Extract workspace path (first non-option arg)
  const workspacePath = args.find(arg => !arg.startsWith("--"));

  if (!workspacePath) {
    console.error("Error: workspace-path is required");
    console.error("Usage: mcp-cursearch index-activate <workspace-path>");
    process.exit(1);
  }

  if (!authToken) {
    console.error("Error: Missing CURSOR_AUTH_TOKEN");
    console.error("Set CURSOR_AUTH_TOKEN environment variable or use --auth-token");
    process.exit(1);
  }

  const resolvedPath = path.resolve(workspacePath);
  console.log(`📦 Processing workspace: ${resolvedPath}`);

  // Check if already indexed
  const state = await loadWorkspaceState(resolvedPath);
  const isIndexed = !!(state.codebaseId && state.pathKey);

  if (isIndexed) {
    console.log(`✅ Workspace already indexed (codebaseId: ${state.codebaseId})`);
  } else {
    console.log("📤 Indexing workspace...");
    const indexer = createRepositoryIndexer({ authToken, baseUrl });
    const result = await indexer.indexProject({ workspacePath: resolvedPath, verbose: false });
    console.log(`✅ Indexing complete!`);
    console.log(`   - Files uploaded: ${result.uploaded}`);
    console.log(`   - Batches: ${result.batches}`);
    console.log(`   - CodebaseId: ${result.codebaseId}`);
  }

  // Activate the workspace
  await setActiveWorkspace(resolvedPath);
  console.log(`✅ Activated workspace: ${resolvedPath}`);
}

async function handleList() {
  const indexed = await listIndexedWorkspaces();
  const active = await getActiveWorkspace();

  if (indexed.length === 0) {
    console.log("No indexed workspaces found.");
    console.log('Run "mcp-cursearch index-activate <path>" to index a workspace.');
    return;
  }

  console.log("Indexed workspaces:\n");

  for (const workspacePath of indexed) {
    const state = await loadWorkspaceState(workspacePath);
    const isActive = workspacePath === active;
    const marker = isActive ? "* " : "  ";
    const activeLabel = isActive ? " (active)" : "";
    const codebaseId = state.codebaseId || "unknown";
    console.log(`${marker}${workspacePath}`);
    console.log(`  [codebaseId: ${codebaseId}]${activeLabel}`);
  }
}

async function handleDeactivate() {
  const active = await getActiveWorkspace();

  if (!active) {
    console.log("No active workspace.");
    return;
  }

  await clearActiveWorkspace();
  console.log(`✅ Deactivated workspace: ${active}`);
}

async function handleStatus(args: string[]) {
  // Extract workspace path or use active
  const workspacePath = args.find(arg => !arg.startsWith("--"));

  let targetPath: string | null;

  if (workspacePath) {
    targetPath = path.resolve(workspacePath);
  } else {
    targetPath = await getActiveWorkspace();
    if (!targetPath) {
      console.error("Error: No active workspace and no path specified");
      console.error("Usage: mcp-cursearch status [workspace-path]");
      process.exit(1);
    }
  }

  const state = await loadWorkspaceState(targetPath);
  const active = await getActiveWorkspace();
  const isActive = targetPath === active;

  console.log(`Workspace: ${targetPath}`);
  console.log(`Status: ${isActive ? "Active" : "Inactive"}`);

  if (state.codebaseId) {
    console.log(`CodebaseId: ${state.codebaseId}`);
    console.log(`Indexed: Yes`);
    if (state.repoName) console.log(`Repo Name: ${state.repoName}`);
    if (state.repoOwner) console.log(`Repo Owner: ${state.repoOwner}`);
  } else {
    console.log(`Indexed: No`);
    console.log('Run "mcp-cursearch index-activate <path>" to index this workspace.');
  }
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();

