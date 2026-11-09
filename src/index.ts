import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

function createServer(): McpServer {
  const server = new McpServer({ name: "flex-mcp", version: "0.0.0" });
  server.registerTool(
    "ping",
    {
      description: "Scaffold gate probe tool",
      inputSchema: z.object({}),
    },
    async () => ({ content: [{ type: "text", text: "pong" }] }),
  );
  return server;
}

const handler = createMcpHandler(createServer);

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp") {
      return new Response("Not Found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    return handler.fetch(request);
  },
} satisfies ExportedHandler;
