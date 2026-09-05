import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { LocalConfig } from "../cli/config.js";
/** Transport-only bridge. Application state remains in the independent daemon. */
export async function bridge(config: LocalConfig) {
  const local = new StdioServerTransport();
  const remote = new StreamableHTTPClientTransport(
    new URL(`${config.url}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${config.token}` } } },
  );
  remote.onmessage = (message) => {
    void local.send(message);
  };
  local.onmessage = (message) => {
    void remote.send(message).catch((error: unknown) => {
      process.stderr.write(
        `MCP aktarım hatası: ${error instanceof Error ? error.message : "transport_error"}\n`,
      );
      if ("id" in message && message.id !== undefined)
        void local.send({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32603,
            message: "Skill Forge servisine ulaşılamadı.",
          },
        });
    });
  };
  local.onclose = () => {
    void remote.close();
  };
  remote.onerror = () => {
    process.stderr.write("MCP uzak transport hatası\n");
  };
  await remote.start();
  await local.start();
  process.stdin.once("end", () => {
    void remote.close();
  });
  return {
    close: async () => {
      await local.close();
      await remote.close();
    },
  };
}
