import { searchRepositoryV2 } from "../client/cursorApi.js";
import path from "path";
import fs from "fs-extra";
import crypto from "crypto";
import { loadWorkspaceState, getActiveWorkspace } from "./stateManager.js";
import { V1MasterKeyedEncryptionScheme, decryptPathToRelPosix } from "../crypto/pathEncryption.js";
import picomatch from "picomatch";

export type SearchParams = {
  query: string;
  pathsIncludeGlob?: string;
  pathsExcludeGlob?: string;
  maxResults: number;
};

export type SearchHit = {
  path: string;
  score: number;
  startLine: number | null;
  endLine: number | null;
  signatures: Array<{ line: number; text: string }>;
  codePreview: string;
};

// Helper function to read file lines and extract code preview
async function readCodeFromFile(workspacePath: string, filePath: string, startLine: number, endLine: number): Promise<string> {
  try {
    const fullPath = path.join(workspacePath, filePath);
    const content = await fs.readFile(fullPath, "utf-8");
    const lines = content.split("\n");
    
    // Adjust for 0-based indexing if needed
    const start = Math.max(0, startLine - 1);
    const end = Math.min(lines.length, endLine);
    const codeLines = lines.slice(start, end);
    
    // If 6 or fewer lines, show all
    if (codeLines.length <= 6) {
      return codeLines.join("\n");
    }
    
    // Otherwise, show first 4 and last 2
    const firstFour = codeLines.slice(0, 4);
    const lastTwo = codeLines.slice(-2);
    
    return [...firstFour, "<Omitted>...</Omitted>", ...lastTwo].join("\n");
  } catch (error) {
    return "";
  }
}

// Get file extension for pattern matching
function getFileExtension(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

// File extension-specific signature patterns
function getSignaturePatterns(fileExt: string): RegExp[] {
  switch (fileExt) {
    case '.py':
      return [
        /^\s*(?:async\s+)?def\s+\w+\s*\(/,  // function/method definitions
        /^\s*class\s+\w+/,  // class definitions
        /^\s*@\w+/,  // decorators
      ];

    case '.js':
    case '.jsx':
    case '.ts':
    case '.tsx':
      return [
        /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+/,  // function declarations
        /^\s*(?:export\s+)?(?:abstract\s+)?class\s+\w+/,  // class declarations
        /^\s*(?:export\s+)?interface\s+\w+/,  // interface declarations
        /^\s*(?:export\s+)?type\s+\w+\s*=/,  // type declarations
        /^\s*(?:export\s+)?enum\s+\w+/,  // enum declarations
        /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(/,  // arrow functions
        /^\s*(?:public|private|protected|static|async)\s+\w+\s*\(/,  // method declarations
        /^\s*(?:get|set)\s+\w+\s*\(/,  // getter/setter
      ];

    case '.cpp':
    case '.cc':
    case '.cxx':
    case '.c':
    case '.h':
    case '.hpp':
    case '.hxx':
    case '.hh':
      return [
        // Standard C++ patterns - only extract actual definitions, not macros
        /^\s*class\s+(?:\w+_API\s+)?\w+/,  // class (with optional API macro)
        /^\s*struct\s+(?:\w+_API\s+)?\w+/,  // struct (with optional API macro)
        /^\s*namespace\s+\w+/,  // namespace
        /^\s*template\s*<.*?>/,  // template
        /^\s*enum\s+(?:class\s+)?\w+/,  // enum

        // Function/method signatures - more restrictive pattern
        // Must have return type or be a constructor/destructor
        // Excludes control flow and function calls by requiring specific patterns
        /^\s*(?:virtual\s+)?(?:static\s+)?(?:inline\s+)?(?:FORCEINLINE\s+)?(?:explicit\s+)?(?:const\s+)?(?:unsigned\s+)?(?:signed\s+)?(?:void|bool|int|float|double|char|long|short|auto|[\w:]+\*?)\s+(?:\*+\s*)?[\w:]+\s*\([^)]*\)\s*(?:const\s*)?(?:override\s*)?(?:final\s*)?(?:\{|;|$)/,  // function/method with return type
        /^\s*(?:virtual\s+)?(?:explicit\s+)?~?[a-z_][\w:]*\s*\([^)]*\)\s*(?:\{|;|:|$)/,  // constructor/destructor (no return type) - must start with lowercase or underscore to exclude macros
      ];

    case '.lua':
      return [
        /^\s*function\s+[\w.:]+\s*\(/,  // global function: function name(...)
        /^\s*local\s+function\s+\w+\s*\(/,  // local function: local function name(...)
        /^\s*function\s+\w+:\w+\s*\(/,  // method with colon: function Class:method(...)
        /^\s*function\s+\w+\.\w+\s*\(/,  // method with dot: function Class.method(...)
        /^\s*local\s+\w+\s*=\s*\{/,  // local table: local tableName = {}
        /^\s*\w+\s*=\s*\{/,  // global table: TableName = {}
      ];

    default:
      // Fallback to JavaScript/TypeScript patterns for unknown file types
      return [
        /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+/,
        /^\s*(?:export\s+)?class\s+\w+/,
        /^\s*(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(/,
      ];
  }
}

// Check if a line is a comment
function isCommentLine(line: string, fileExt: string): boolean {
  const trimmed = line.trim();

  switch (fileExt) {
    case '.py':
      return trimmed.startsWith('#');

    case '.js':
    case '.jsx':
    case '.ts':
    case '.tsx':
      return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');

    case '.cpp':
    case '.cc':
    case '.cxx':
    case '.c':
    case '.h':
    case '.hpp':
    case '.hxx':
    case '.hh':
      return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');

    case '.lua':
      return trimmed.startsWith('--');

    default:
      return false;
  }
}

// Check if a line should be excluded from signature extraction
function shouldExcludeLine(line: string, fileExt: string): boolean {
  const trimmed = line.trim();

  // Exclude empty lines and comments
  if (!trimmed || isCommentLine(line, fileExt)) {
    return true;
  }

  // Exclude uninformative standalone macros (C++/Unreal Engine)
  // These are macros that appear alone without actual code definitions
  const uninformativeMacroPatterns = [
    /^\s*UFUNCTION\s*\([^)]*\)\s*$/,  // UFUNCTION(...) alone on a line
    /^\s*UPROPERTY\s*\([^)]*\)\s*$/,  // UPROPERTY(...) alone on a line
    /^\s*GENERATED_BODY\s*\(\s*\)\s*$/,  // GENERATED_BODY() alone
    /^\s*GENERATED_UCLASS_BODY\s*\(\s*\)\s*$/,  // GENERATED_UCLASS_BODY() alone
    /^\s*GENERATED_USTRUCT_BODY\s*\(\s*\)\s*$/,  // GENERATED_USTRUCT_BODY() alone
  ];

  if (uninformativeMacroPatterns.some(pattern => pattern.test(line))) {
    return true;
  }

  // Exclude control flow statements (if, for, while, switch, etc.)
  const controlFlowPatterns = [
    /^\s*if\s*\(/,
    /^\s*else\s*if\s*\(/,
    /^\s*else\s*\{/,
    /^\s*for\s*\(/,
    /^\s*while\s*\(/,
    /^\s*switch\s*\(/,
    /^\s*catch\s*\(/,
    /^\s*do\s*\{/,
  ];

  if (controlFlowPatterns.some(pattern => pattern.test(line))) {
    return true;
  }

  // Exclude function calls (lines ending with semicolon after parentheses)
  // But NOT function declarations which have return types
  // Function declarations typically start with: type name(...); or modifiers type name(...);
  // Function calls typically start with: name(...); or object.method(...);
  if (/\)\s*;[\s]*$/.test(trimmed)) {
    // Check if it looks like a function declaration (has return type keywords or modifiers)
    const isFunctionDeclaration = /^\s*(?:virtual\s+|static\s+|inline\s+|FORCEINLINE\s+|explicit\s+|const\s+|unsigned\s+|signed\s+|extern\s+)?(?:void|bool|int|float|double|char|long|short|auto|[\w:]+\*?)\s+(?:\*+\s*)?[\w:~]+\s*\([^)]*\)\s*(?:const\s*)?(?:override\s*)?(?:final\s*)?;/.test(trimmed);

    if (!isFunctionDeclaration) {
      return true;  // It's a function call, exclude it
    }
  }

  // Exclude assignment statements with function calls
  // This catches patterns like: variable = value; or Bool("MediaEnd") = true;
  if (/=\s*[^=].*;\s*$/.test(trimmed) && !/^\s*(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(/.test(trimmed)) {
    return true;
  }

  // Exclude return statements
  if (/^\s*return\s+/.test(trimmed)) {
    return true;
  }

  return false;
}

// Helper function to extract signatures from code lines
async function extractSignaturesFromFile(workspacePath: string, filePath: string, startLine: number, endLine: number): Promise<Array<{ line: number; text: string }>> {
  try {
    const fullPath = path.join(workspacePath, filePath);
    const content = await fs.readFile(fullPath, "utf-8");
    const lines = content.split("\n");

    const signatures: Array<{ line: number; text: string }> = [];
    const start = Math.max(0, startLine - 1);
    const end = Math.min(lines.length, endLine);

    // Get file extension and appropriate patterns
    const fileExt = getFileExtension(filePath);
    const signaturePatterns = getSignaturePatterns(fileExt);

    // Extract signatures from the specified line range
    const seenLines = new Set<number>();  // Avoid duplicates

    for (let i = start; i < end; i++) {
      const line = lines[i];

      // Use the new shouldExcludeLine function to filter out non-signatures
      if (shouldExcludeLine(line, fileExt)) {
        continue;
      }

      // Check if line matches any signature pattern
      if (signaturePatterns.some(pattern => pattern.test(line))) {
        const lineNum = i + 1;
        if (!seenLines.has(lineNum)) {
          signatures.push({ line: lineNum, text: line.trim() });
          seenLines.add(lineNum);
        }
      }
    }

    return signatures;
  } catch (error) {
    return [];
  }
}

export function createCodeSearcher(ctx: { authToken: string; baseUrl: string }, indexer: { autoSyncIfNeeded: (workspacePath: string) => Promise<void> }) {
  async function search(params: SearchParams) {
    // Get the active workspace
    const workspacePath = await getActiveWorkspace();
    if (!workspacePath) {
      throw new Error(
        "No active workspace. Please run:\n" +
        "  mcp-cursearch index-activate <workspace-path>\n" +
        "to activate a workspace first."
      );
    }

    // pre-search sync if pending changes
    await indexer.autoSyncIfNeeded(workspacePath);

    const st = await loadWorkspaceState(workspacePath);
    console.log(`🔍 [SEARCH DEBUG] Loaded state for search:`);
    console.log(`   - codebaseId: ${st.codebaseId || 'NONE'}`);
    console.log(`   - pathKey: ${st.pathKey ? st.pathKey.substring(0, 20) + '...' : 'NONE'}`);
    console.log(`   - pathKeyHash: ${st.pathKeyHash || 'NONE'}`);
    if (!st.codebaseId || !st.pathKey) {
      throw new Error(
        "Active workspace not indexed yet. Please run:\n" +
        "  mcp-cursearch index-activate " + workspacePath
      );
    }
    const repositoryPb = {
      relativeWorkspacePath: ".",
      isTracked: false,
      isLocal: true,
      numFiles: 0,
      orthogonalTransformSeed: st.orthogonalTransformSeed || 0,
      preferredEmbeddingModel: "EMBEDDING_MODEL_UNSPECIFIED",
      workspaceUri: "",
      // Reuse stable identity from state; fall back to deterministic default
      repoName: st.repoName || `local-${crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 12)}`,
      repoOwner: st.repoOwner || "local-user",
      remoteUrls: [],
      remoteNames: [],
    } as any;
    const res = await searchRepositoryV2(ctx.baseUrl, ctx.authToken, {
      query: params.query,
      repository: repositoryPb,
      topK: params.maxResults,
    });
    const codeResults = (res?.code_results || res?.codeResults || []) as any[];
    const scheme = new V1MasterKeyedEncryptionScheme(st.pathKey);
    console.log(`🔓 [SEARCH DEBUG] Created decryption scheme with pathKey: ${st.pathKey.substring(0, 20)}...`);

    // Map results and read actual file content for each hit
    const hits: SearchHit[] = await Promise.all(codeResults.map(async (r, index) => {
      const block = r?.code_block || r?.codeBlock || {};
      const encPath = block.relative_workspace_path || block.relativeWorkspacePath || "unknown";

      if (index === 0) {
        console.log(`🔓 [SEARCH DEBUG] First encrypted path: ${encPath.substring(0, 50)}...`);
      }

      let decPath: string;
      try {
        decPath = decryptPathToRelPosix(scheme, encPath);
        if (index === 0) {
          console.log(`🔓 [SEARCH DEBUG] First decrypted path: ${decPath}`);
        }
      } catch (error) {
        // If decryption fails, log the error and use a placeholder
        console.warn(`Failed to decrypt path: ${error instanceof Error ? error.message : 'Unknown error'}`);
        console.warn(`Encrypted path was: "${encPath.substring(0, 100)}..."`);
        decPath = "<decryption-failed>";
      }
      const range = block.range || {};
      const sp = range.start_position || range.startPosition || {};
      const ep = range.end_position || range.endPosition || {};
      const score = r?.score ?? 0;

      const startLine = sp.line ?? 1;
      const endLine = ep.line ?? startLine;

      // Read code content and signatures from the actual file
      const codePreview = await readCodeFromFile(workspacePath, decPath, startLine, endLine);
      const signatures = await extractSignaturesFromFile(workspacePath, decPath, startLine, endLine);

      return {
        path: decPath,
        score,
        startLine: startLine,
        endLine: endLine,
        signatures,
        codePreview,
      };
    }));
    // Apply include/exclude globs if provided
    const includeMatcher = params.pathsIncludeGlob ? picomatch(params.pathsIncludeGlob) : null;
    const excludeMatcher = params.pathsExcludeGlob ? picomatch(params.pathsExcludeGlob) : null;
    const filtered = hits.filter((h) => {
      const p = h.path.startsWith("./") ? h.path.slice(2) : h.path;
      if (includeMatcher && !includeMatcher(p)) return false;
      if (excludeMatcher && excludeMatcher(p)) return false;
      return true;
    });
    return { total: filtered.length, hits: filtered.slice(0, params.maxResults) };
  }
  return { search };
}

