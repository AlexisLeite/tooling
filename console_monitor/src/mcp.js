import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_HOST, readPort, resolvePortFile, resolveWorkspace, sendConsoleRequest } from "./tcp-client.js";

const workspaceSchema = {
  cwd: z.string().optional().describe("Workspace directory that contains dev_current_port. Defaults to CONSOLE_MONITOR_WORKSPACE or the MCP process cwd."),
  portFile: z.string().optional().describe("Explicit path to the port file. Overrides cwd/dev_current_port.")
};

function text(content) {
  return {
    content: [
      {
        type: "text",
        text: content
      }
    ]
  };
}

export function createServer() {
  const server = new McpServer({
    name: "console-monitor",
    version: "0.1.0"
  });

  server.registerTool(
    "console_port",
    {
      description: "Read the active console monitor TCP port for a workspace.",
      inputSchema: workspaceSchema
    },
    async ({ cwd, portFile }) => {
      const resolvedWorkspace = resolveWorkspace(cwd);
      const resolvedPortFile = resolvePortFile({ cwd, portFile });
      const result = await readPort({ cwd, portFile });

      return text(JSON.stringify(
        {
          cwd: resolvedWorkspace,
          portFile: resolvedPortFile,
          port: result.port
        },
        null,
        2
      ));
    }
  );

  server.registerTool(
    "console_read",
    {
      description: "Read recent output from the active console monitor for a workspace.",
      inputSchema: {
        ...workspaceSchema,
        host: z.string().default(DEFAULT_HOST).describe("TCP host for the console monitor."),
        port: z.number().int().min(0).max(65535).optional().describe("Explicit TCP port. If omitted, dev_current_port is read."),
        lines: z.number().int().min(0).max(100).default(25).describe("Number of recent lines to read.")
      }
    },
    async ({ cwd, portFile, host, port, lines }) => {
      const result = await sendConsoleRequest({
        cwd,
        portFile,
        host,
        port,
        request: `read(${lines})`
      });

      return text(result.response || "");
    }
  );

  server.registerTool(
    "console_restart",
    {
      description: "Restart the command wrapped by the active console monitor for a workspace.",
      inputSchema: {
        ...workspaceSchema,
        host: z.string().default(DEFAULT_HOST).describe("TCP host for the console monitor."),
        port: z.number().int().min(0).max(65535).optional().describe("Explicit TCP port. If omitted, dev_current_port is read.")
      }
    },
    async ({ cwd, portFile, host, port }) => {
      const result = await sendConsoleRequest({
        cwd,
        portFile,
        host,
        port,
        request: "restart()"
      });

      return text(result.response || "Restart requested");
    }
  );

  return server;
}

export async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
