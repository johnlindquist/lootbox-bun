#!/usr/bin/env bun
/**
 * MCP Bridge Server
 *
 * This MCP server bridges Claude Code to the lootbox RPC server.
 * It discovers tools from the lootbox server and exposes them as MCP tools.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const LOOTBOX_URL = process.env.LOOTBOX_URL || "ws://localhost:3456/ws";
const LOOTBOX_HTTP = LOOTBOX_URL.replace("ws://", "http://").replace("wss://", "https://").replace("/ws", "");

interface RpcFunction {
  name: string;
  namespace: string;
  properties: Record<string, { type: string; items?: { type: string } }>;
  required: string[];
}

interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface ServerStatus {
  healthy: boolean;
  hasTypes: boolean;
  error?: string;
}

/**
 * Check if the lootbox server is healthy and has the expected endpoints
 */
async function checkServerHealth(): Promise<ServerStatus> {
  try {
    // Check health endpoint
    const healthResponse = await fetch(`${LOOTBOX_HTTP}/health`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!healthResponse.ok) {
      return {
        healthy: false,
        hasTypes: false,
        error: `Health check failed: HTTP ${healthResponse.status}`,
      };
    }

    // Check types endpoint
    const typesResponse = await fetch(`${LOOTBOX_HTTP}/types`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!typesResponse.ok) {
      const errorText = await typesResponse.text().catch(() => "");
      const isNotFound = typesResponse.status === 404;

      return {
        healthy: true,
        hasTypes: false,
        error: isNotFound
          ? `Server at ${LOOTBOX_HTTP} is running but missing /types endpoint. This may be a stale or incompatible lootbox server. Try restarting: pkill -f "lootbox-cli.ts server" && cd ~/dev/lootbox-bun && bun run src/lootbox-cli.ts server --port 3456`
          : `Types endpoint failed: HTTP ${typesResponse.status} - ${errorText}`,
      };
    }

    const typesText = await typesResponse.text();
    if (!typesText.includes("export interface RpcClient")) {
      return {
        healthy: true,
        hasTypes: false,
        error: `Server returned unexpected types format. Expected TypeScript interface definitions.`,
      };
    }

    return { healthy: true, hasTypes: true };
  } catch (error) {
    const err = error as Error;
    const isTimeout = err.name === "TimeoutError" || err.message?.includes("timeout");
    const isConnectionRefused = err.message?.includes("ECONNREFUSED") || err.message?.includes("fetch failed");

    if (isConnectionRefused) {
      return {
        healthy: false,
        hasTypes: false,
        error: `Cannot connect to lootbox server at ${LOOTBOX_HTTP}. Is the server running? Start it with: cd ~/dev/lootbox-bun && bun run src/lootbox-cli.ts server --port 3456`,
      };
    }

    if (isTimeout) {
      return {
        healthy: false,
        hasTypes: false,
        error: `Connection to ${LOOTBOX_HTTP} timed out. Server may be overloaded or unresponsive.`,
      };
    }

    return {
      healthy: false,
      hasTypes: false,
      error: `Health check error: ${err.message || String(error)}`,
    };
  }
}

// Fetch available functions from lootbox
async function fetchFunctions(): Promise<RpcFunction[]> {
  // First check server health
  const status = await checkServerHealth();

  if (!status.healthy || !status.hasTypes) {
    console.error(`[MCP Bridge] Server health check failed: ${status.error}`);
    throw new Error(status.error || "Lootbox server is not available");
  }

  try {
    const response = await fetch(`${LOOTBOX_HTTP}/types`, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const errorMsg = `Failed to fetch types: HTTP ${response.status}`;
      console.error(`[MCP Bridge] ${errorMsg}`);
      throw new Error(errorMsg);
    }

    const typesText = await response.text();
    const lines = typesText.split("\n");
    const functions: RpcFunction[] = [];

    let currentNs = "";
    let currentFunc = "";
    let collectingArgs = false;
    let argsContent = "";

    for (const line of lines) {
      // Match namespace start: "  basic_memory: {"
      const nsMatch = line.match(/^\s+(\w+):\s*\{$/);
      if (nsMatch) {
        currentNs = nsMatch[1];
        continue;
      }

      // Match function start: "    write_memory(args: {"
      const funcMatch = line.match(/^\s+(\w+)\(args:\s*(\{|Record)/);
      if (funcMatch && currentNs) {
        currentFunc = funcMatch[1];
        if (funcMatch[2] === "Record") {
          // No args function
          functions.push({
            name: currentFunc,
            namespace: currentNs,
            properties: {},
            required: [],
          });
          currentFunc = "";
        } else {
          collectingArgs = true;
          argsContent = "";
        }
        continue;
      }

      // Collecting arg properties
      if (collectingArgs) {
        argsContent += line + "\n";

        // Check if we hit the closing brace of args
        if (line.includes("})")) {
          // Parse the collected args
          const properties: Record<string, { type: string; items?: { type: string } }> = {};
          const required: string[] = [];

          // Updated regex to capture array types like string[] or number[]
          const propRegex = /(\w+)(\?)?:\s*(\w+)(\[\])?/g;
          let propMatch;

          while ((propMatch = propRegex.exec(argsContent)) !== null) {
            const propName = propMatch[1];
            const isOptional = propMatch[2] === "?";
            const propType = propMatch[3];
            const isArray = propMatch[4] === "[]";

            let jsonType = "string";
            if (propType === "number") jsonType = "number";
            else if (propType === "boolean") jsonType = "boolean";

            // Handle array types properly for JSON Schema
            if (isArray) {
              properties[propName] = { type: "array", items: { type: jsonType } };
            } else {
              properties[propName] = { type: jsonType };
            }

            if (!isOptional) {
              required.push(propName);
            }
          }

          functions.push({
            name: currentFunc,
            namespace: currentNs,
            properties,
            required,
          });

          collectingArgs = false;
          currentFunc = "";
          argsContent = "";
        }
      }
    }

    if (functions.length === 0) {
      console.error("[MCP Bridge] Warning: No functions discovered from lootbox server. Check that tools are properly configured in .lootbox/tools/");
    } else {
      console.error(`[MCP Bridge] Discovered ${functions.length} functions from lootbox server`);
    }

    return functions;
  } catch (error) {
    const err = error as Error;
    console.error(`[MCP Bridge] Error fetching functions: ${err.message}`);
    throw error;
  }
}

// Call a function via WebSocket with progress support
async function callFunction(
  namespace: string,
  funcName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;

    try {
      ws = new WebSocket(LOOTBOX_URL);
    } catch (error) {
      reject(new Error(`Failed to create WebSocket connection to ${LOOTBOX_URL}: ${error}`));
      return;
    }

    const callId = `call_${Date.now()}`;
    let timeout: ReturnType<typeof setTimeout>;
    let connectionTimeout: ReturnType<typeof setTimeout>;

    // Helper to reset the timeout - called when progress is received
    const resetTimeout = (timeoutMs: number = 60000) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`RPC call timeout for ${namespace}.${funcName} (no progress for ${timeoutMs / 1000}s)`));
      }, timeoutMs);
    };

    // Connection timeout - if we don't connect within 5 seconds, fail
    connectionTimeout = setTimeout(() => {
      ws.close();
      reject(new Error(`WebSocket connection timeout. Cannot connect to ${LOOTBOX_URL}. Is the lootbox server running on port 3456?`));
    }, 5000);

    ws.onopen = () => {
      clearTimeout(connectionTimeout);

      ws.send(
        JSON.stringify({
          method: `${namespace}.${funcName}`,
          args: args,
          id: callId,
        })
      );

      // Initial timeout of 30s, will be reset on progress
      resetTimeout(30000);
    };

    ws.onmessage = (event) => {
      try {
        const response = JSON.parse(event.data);
        if (response.type === "welcome") return;

        // Handle progress messages - reset timeout to allow more time
        if (response.type === "progress" && response.id === callId) {
          console.error(`[MCP Bridge] Progress for ${namespace}.${funcName}: ${response.message}`);
          resetTimeout(60000); // Reset to 60s on each progress update
          return;
        }

        if (response.id === callId) {
          clearTimeout(timeout);
          ws.close();

          if (response.error) {
            reject(new Error(`RPC error from ${namespace}.${funcName}: ${response.error}`));
          } else {
            resolve(response.result);
          }
        }
      } catch (error) {
        clearTimeout(timeout);
        ws.close();
        reject(new Error(`Failed to parse response from ${namespace}.${funcName}: ${error}`));
      }
    };

    ws.onerror = (error) => {
      clearTimeout(connectionTimeout);
      clearTimeout(timeout);

      // Provide helpful error message
      const errorMsg = `WebSocket error connecting to ${LOOTBOX_URL}. ` +
        `Possible causes:\n` +
        `  1. Lootbox server is not running (start with: bun run src/lootbox-cli.ts server --port 3456)\n` +
        `  2. Server is running on a different port\n` +
        `  3. A stale server process is blocking the port (kill with: pkill -f "lootbox-cli.ts server")`;

      reject(new Error(errorMsg));
    };

    ws.onclose = (event) => {
      clearTimeout(connectionTimeout);
      clearTimeout(timeout);

      if (!event.wasClean && event.code !== 1000) {
        reject(new Error(`WebSocket closed unexpectedly (code: ${event.code}, reason: ${event.reason || "none"})`));
      }
    };
  });
}

// Create and start the MCP server
async function main() {
  console.error(`[MCP Bridge] Starting, will connect to: ${LOOTBOX_URL}`);

  // Perform initial health check
  const initialStatus = await checkServerHealth();
  if (!initialStatus.healthy) {
    console.error(`[MCP Bridge] WARNING: ${initialStatus.error}`);
    console.error(`[MCP Bridge] The bridge will start but tool calls may fail until the server is available.`);
  } else if (!initialStatus.hasTypes) {
    console.error(`[MCP Bridge] WARNING: ${initialStatus.error}`);
  } else {
    console.error(`[MCP Bridge] Successfully connected to lootbox server at ${LOOTBOX_HTTP}`);
  }

  const server = new Server(
    {
      name: "lootbox-bridge",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Cache functions
  let cachedFunctions: RpcFunction[] = [];
  let lastFetchError: string | null = null;

  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      // Refresh functions
      cachedFunctions = await fetchFunctions();
      lastFetchError = null;

      const tools: ToolSchema[] = cachedFunctions.map((func) => ({
        name: `${func.namespace}__${func.name}`,
        description: `Call ${func.namespace}.${func.name}() on the lootbox RPC server`,
        inputSchema: {
          type: "object" as const,
          properties: func.properties,
          required: func.required.length > 0 ? func.required : undefined,
        },
      }));

      return { tools };
    } catch (error) {
      const err = error as Error;
      lastFetchError = err.message;
      console.error(`[MCP Bridge] Failed to list tools: ${err.message}`);

      // Return empty tools list but log the error
      return { tools: [] };
    }
  });

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Parse namespace and function name from tool name (format: namespace__funcname)
    const [namespace, ...funcParts] = name.split("__");
    const funcName = funcParts.join("__");

    if (!namespace || !funcName) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Invalid tool name format "${name}". Expected format: namespace__functionname`,
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await callFunction(namespace, funcName, args || {});
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const err = error as Error;
      console.error(`[MCP Bridge] Tool call failed: ${err.message}`);

      return {
        content: [
          {
            type: "text",
            text: `Error: ${err.message}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[MCP Bridge] Server started and ready for connections");
}

main().catch((error) => {
  console.error(`[MCP Bridge] Fatal error: ${error.message || error}`);
  process.exit(1);
});
