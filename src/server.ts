import { ListToolsRequestSchema, ListToolsResultSchema, CallToolRequestSchema, CompatibilityCallToolResultSchema, ListPromptsRequestSchema, ListPromptsResultSchema, ListResourcesRequestSchema, ListResourcesResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createRepositoryIndexer } from "./services/repositoryIndexer.js";
import { createCodeSearcher } from "./services/codeSearcher.js";

export type ServerContext = { authToken: string; baseUrl: string };

export async function createMcpServer(server: any, ctx: ServerContext): Promise<void> {
  const indexer = createRepositoryIndexer(ctx);
  const searcher = createCodeSearcher(ctx, indexer);

  // Zod schema for tool arguments
  const codebaseSearchArgsSchema = z.object({
    query: z.string(),
    paths_include_glob: z.string().optional(),
    paths_exclude_glob: z.string().optional(),
    max_results: z.number().int().positive().optional(),
  });

  // Minimal JSON Schema for MCP tool inputSchema (top-level must be type: "object")
  const codebaseSearchInputJsonSchema = {
    type: "object",
    properties: {
      query: { type: "string" },
      paths_include_glob: { type: "string" },
      paths_exclude_glob: { type: "string" },
      max_results: { type: "integer", minimum: 1 },
    },
    required: ["query"],
  } as const;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return ListToolsResultSchema.parse({
      tools: [
        {
          name: "codebase_search",
          description: "Searches the active workspace's indexed codebase to find code snippets most relevant to a natural language query. This is a semantic search tool, so the query should describe the desired functionality or concept. For best results, use the user's exact phrasing for the `query`, as their specific wording often contains valuable semantic cues. If the search should be limited to specific files or directories, use the `paths_include_glob` and `paths_exclude_glob` parameters to scope the search. NOTE: The user must first activate a workspace using the CLI command 'mcp-cursearch index-activate <workspace-path>' before this tool can be used.",
          inputSchema: codebaseSearchInputJsonSchema,
        },
      ],
    });
  });

  // No-op prompt/resources handlers to satisfy advertised capabilities
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return ListPromptsResultSchema.parse({ prompts: [] });
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return ListResourcesResultSchema.parse({ resources: [] });
  });

  server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
    const { name, arguments: args } = req.params as { name: string; arguments?: Record<string, unknown> };
    // Friendly guard: ensure auth token is present at call time
    const missingTokenError = () => CompatibilityCallToolResultSchema.parse({
      content: [{ type: "text", text: "Missing CURSOR_AUTH_TOKEN. Pass --auth-token or set env CURSOR_AUTH_TOKEN before using this tool." }],
      isError: true,
    });
    if (!ctx.authToken) {
      return missingTokenError();
    }
    if (name === "codebase_search") {
      const { query, paths_include_glob, paths_exclude_glob, max_results } = codebaseSearchArgsSchema.parse(args || {});
      const result = await searcher.search({
        query,
        pathsIncludeGlob: paths_include_glob,
        pathsExcludeGlob: paths_exclude_glob,
        maxResults: (typeof max_results === "number" && max_results > 0) ? max_results : 10,
      });
      return CompatibilityCallToolResultSchema.parse({
        content: [{ type: "text", text: JSON.stringify(result) }],
      });
    }
    return CompatibilityCallToolResultSchema.parse({ content: [{ type: "text", text: "Unknown tool" }], isError: true });
  });
}


