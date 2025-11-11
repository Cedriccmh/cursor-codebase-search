import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createMcpServer } from "./server.js";
import { resolveAuthAndBaseUrlFromCliAndEnv } from "./utils/env.js";
import { logger } from "./utils/logger.js";

async function main() {
  const { authToken, baseUrl, logLevel } = resolveAuthAndBaseUrlFromCliAndEnv(process.argv.slice(2));
  if (logLevel) logger.setLevel(logLevel);

  const server = new Server({ name: "mcp-cursearch", version: "0.0.1" }, {
    capabilities: {
      prompts: {},
      tools: {},
      resources: {},
      sampling: {},
    },
  });

  await createMcpServer(server, { authToken, baseUrl });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();


