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

// Timeout configuration (in milliseconds)
const WS_CONFIG = {
  CONNECT_TIMEOUT_MS: 5000,   // Time to establish connection
  REQUEST_TIMEOUT_MS: 30000,  // Initial timeout for RPC calls
  PROGRESS_TIMEOUT_MS: 60000, // Extended timeout when progress is received
};

/**
 * Persistent WebSocket Connection
 *
 * Maintains a single persistent WebSocket connection to avoid the overhead
 * of creating a new connection for every RPC call. Reconnects lazily on
 * next call if the connection drops.
 *
 * This was added to address CPU/performance issues from connection churn.
 * See council recommendations from CPU investigation.
 */
class PersistentWebSocket {
  private ws: WebSocket | null = null;
  private pendingCalls = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
    method: string;
  }>();
  private connectionPromise: Promise<WebSocket> | null = null;
  private connectionReject: ((reason: Error) => void) | null = null;
  private callCounter = 0;

  /**
   * Get or create a WebSocket connection
   */
  private async getConnection(): Promise<WebSocket> {
    // If we have an open connection, reuse it
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.ws;
    }

    // If a connection is in progress, wait for it
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    // Create a new connection
    this.connectionPromise = new Promise<WebSocket>((resolve, reject) => {
      // Store reject so onclose/onerror can use it if connection fails before onopen
      this.connectionReject = reject;

      const ws = new WebSocket(LOOTBOX_URL);

      const connectionTimeout = setTimeout(() => {
        ws.close();
        this.connectionPromise = null;
        this.connectionReject = null;
        reject(new Error(`WebSocket connection timeout. Cannot connect to ${LOOTBOX_URL}. Is the lootbox server running?`));
      }, WS_CONFIG.CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        clearTimeout(connectionTimeout);
        this.ws = ws;
        this.connectionPromise = null;
        this.connectionReject = null;
        console.error(`[MCP Bridge] WebSocket connected to ${LOOTBOX_URL}`);
        resolve(ws);
      };

      ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      ws.onerror = () => {
        clearTimeout(connectionTimeout);
        // Don't clear connectionPromise here - let onclose handle it
        // Error details will be in onclose
      };

      ws.onclose = (event) => {
        clearTimeout(connectionTimeout);
        this.ws = null;

        // If connection failed before onopen, reject the connection promise
        if (this.connectionReject) {
          this.connectionPromise = null;
          const rejectFn = this.connectionReject;
          this.connectionReject = null;
          rejectFn(new Error(`WebSocket connection failed (code: ${event.code})`));
          return;
        }

        this.connectionPromise = null;

        // Reject all pending calls
        for (const [, pending] of this.pendingCalls) {
          clearTimeout(pending.timeout);
          pending.reject(new Error(`WebSocket closed during ${pending.method} (code: ${event.code})`));
        }
        this.pendingCalls.clear();

        if (!event.wasClean) {
          console.error(`[MCP Bridge] WebSocket disconnected (code: ${event.code})`);
        }
      };
    });

    return this.connectionPromise;
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(data: string): void {
    try {
      const response = JSON.parse(data);

      // Ignore welcome messages
      if (response.type === "welcome") return;

      // Handle progress messages
      if (response.type === "progress" && response.id) {
        const pending = this.pendingCalls.get(response.id);
        if (pending) {
          console.error(`[MCP Bridge] Progress for ${pending.method}: ${response.message}`);
          // Clear old timeout BEFORE setting new one to prevent leak
          clearTimeout(pending.timeout);
          pending.timeout = setTimeout(() => {
            this.pendingCalls.delete(response.id);
            pending.reject(new Error(`RPC call timeout for ${pending.method} (no progress for ${WS_CONFIG.PROGRESS_TIMEOUT_MS / 1000}s)`));
          }, WS_CONFIG.PROGRESS_TIMEOUT_MS);
        }
        return;
      }

      // Handle response messages
      if (response.id) {
        const pending = this.pendingCalls.get(response.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingCalls.delete(response.id);

          if (response.error) {
            pending.reject(new Error(`RPC error from ${pending.method}: ${response.error}`));
          } else {
            pending.resolve(response.result);
          }
        }
      }
    } catch (error) {
      console.error(`[MCP Bridge] Failed to parse message: ${error}`);
    }
  }

  /**
   * Call an RPC function
   */
  async call(
    namespace: string,
    funcName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const method = `${namespace}.${funcName}`;
    const callId = `call_${Date.now()}_${++this.callCounter}`;

    // Get or create connection
    const ws = await this.getConnection();

    return new Promise((resolve, reject) => {
      // Check readyState before sending to avoid TOCTOU race
      // Connection could have closed between getConnection() and now
      if (ws.readyState !== WebSocket.OPEN) {
        this.ws = null; // Force reconnection on next call
        reject(new Error(`WebSocket not open (state: ${ws.readyState}), will reconnect on next call`));
        return;
      }

      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingCalls.delete(callId);
        reject(new Error(`RPC call timeout for ${method} (no response for ${WS_CONFIG.REQUEST_TIMEOUT_MS / 1000}s)`));
      }, WS_CONFIG.REQUEST_TIMEOUT_MS);

      // Register pending call
      this.pendingCalls.set(callId, { resolve, reject, timeout, method });

      // Send the request with error handling for stale connections
      const enrichedArgs = {
        ...args,
        _client_cwd: process.cwd(),
      };

      try {
        ws.send(JSON.stringify({
          method,
          args: enrichedArgs,
          id: callId,
        }));
      } catch (sendError) {
        // Send failed - connection is stale
        clearTimeout(timeout);
        this.pendingCalls.delete(callId);
        this.ws = null; // Force reconnection on next call
        reject(new Error(`Failed to send RPC call: ${sendError}`));
      }
    });
  }

  /**
   * Close the connection
   */
  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    for (const [, pending] of this.pendingCalls) {
      clearTimeout(pending.timeout);
    }
    this.pendingCalls.clear();
  }
}

// Singleton persistent connection
const wsConnection = new PersistentWebSocket();

// Graceful shutdown handlers
process.on('SIGINT', () => {
  wsConnection.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  wsConnection.close();
  process.exit(0);
});

// Call a function via WebSocket with persistent connection
async function callFunction(
  namespace: string,
  funcName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  return wsConnection.call(namespace, funcName, args);
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
        name: `lootbox__${func.namespace}__${func.name}`,
        description: `[Lootbox System Tool] ${func.namespace}.${func.name} - Internal helper tool for AI workflows. Not related to project code.`,
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

    // Parse namespace and function name from tool name (format: lootbox__namespace__funcname)
    // Strip "lootbox__" prefix if present for backwards compatibility
    const normalizedName = name.startsWith("lootbox__") ? name.slice(9) : name;
    const [namespace, ...funcParts] = normalizedName.split("__");
    const funcName = funcParts.join("__");

    if (!namespace || !funcName) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Invalid tool name format "${name}". Expected format: lootbox__namespace__functionname`,
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
