import minimist from "minimist";
import ora from "ora";
import { get_config, setArgsOverride, clearArgsOverride } from "../get_config.ts";
import { WebSocketRpcServer } from "../rpc/websocket_server.ts";

/**
 * Sanitize server name to be a valid identifier
 * Replaces hyphens and other invalid characters with underscores
 */
function sanitizeServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

export async function startServer(args: string[]): Promise<void> {
  const parsedArgs = minimist(args, {
    string: ["port", "lootbox-root", "lootbox-data-dir"],
    alias: {
      p: "port",
      r: "lootbox-root",
      d: "lootbox-data-dir",
    },
  });

  // Override config with CLI args if provided
  if (
    parsedArgs.port ||
    parsedArgs["lootbox-root"] ||
    parsedArgs["lootbox-data-dir"]
  ) {
    const customArgs: string[] = [];
    if (parsedArgs.port) {
      customArgs.push("--port", String(parsedArgs.port));
    }
    if (parsedArgs["lootbox-root"]) {
      customArgs.push("--lootbox-root", parsedArgs["lootbox-root"] as string);
    }
    if (parsedArgs["lootbox-data-dir"]) {
      customArgs.push(
        "--lootbox-data-dir",
        parsedArgs["lootbox-data-dir"] as string
      );
    }
    // Set args override for get_config
    setArgsOverride(customArgs);
  }

  try {
    const spinner = ora({
      text: "Starting lootbox 🎁",
      color: "cyan",
    }).start();

    const config = await get_config();

    // Process MCP servers from config
    let mcpConfig: { mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> } | null = null;
    if (config.mcp_servers && Object.keys(config.mcp_servers).length > 0) {
      // Sanitize server names and filter out mcp-rpc-bridge
      const sanitizedServers: Record<
        string,
        (typeof config.mcp_servers)[string]
      > = {};

      for (const [serverName, serverConfig] of Object.entries(
        config.mcp_servers
      )) {
        const sanitizedName = sanitizeServerName(serverName);
        sanitizedServers[sanitizedName] = serverConfig;
      }
      mcpConfig = { mcpServers: sanitizedServers };
    }
    const server = new WebSocketRpcServer();
    await server.start(config.port, mcpConfig, spinner);
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  } finally {
    // Clear args override
    clearArgsOverride();
  }
}
