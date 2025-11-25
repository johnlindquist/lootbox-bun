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
  properties: Record<string, { type: string }>;
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

// Fetch available functions from lootbox
async function fetchFunctions(): Promise<RpcFunction[]> {
  try {
    const response = await fetch(`${LOOTBOX_HTTP}/types`);
    if (!response.ok) {
      console.error(`Failed to fetch types: ${response.status}`);
      return [];
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
          const properties: Record<string, { type: string }> = {};
          const required: string[] = [];

          const propRegex = /(\w+)(\?)?:\s*(\w+)/g;
          let propMatch;

          while ((propMatch = propRegex.exec(argsContent)) !== null) {
            const propName = propMatch[1];
            const isOptional = propMatch[2] === "?";
            const propType = propMatch[3];

            let jsonType = "string";
            if (propType === "number") jsonType = "number";
            else if (propType === "boolean") jsonType = "boolean";

            properties[propName] = { type: jsonType };

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

    return functions;
  } catch (error) {
    console.error("Error fetching functions:", error);
    return [];
  }
}

// Call a function via WebSocket
async function callFunction(
  namespace: string,
  funcName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(LOOTBOX_URL);
    const callId = `call_${Date.now()}`;
    let timeout: ReturnType<typeof setTimeout>;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          method: `${namespace}.${funcName}`,
          args: [args],
          id: callId,
        })
      );

      timeout = setTimeout(() => {
        ws.close();
        reject(new Error("RPC call timeout"));
      }, 30000);
    };

    ws.onmessage = (event) => {
      try {
        const response = JSON.parse(event.data);
        if (response.type === "welcome") return;

        if (response.id === callId) {
          clearTimeout(timeout);
          ws.close();

          if (response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response.result);
          }
        }
      } catch (error) {
        clearTimeout(timeout);
        ws.close();
        reject(error);
      }
    };

    ws.onerror = (error) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket error: ${error}`));
    };
  });
}

// Create and start the MCP server
async function main() {
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

  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Refresh functions
    cachedFunctions = await fetchFunctions();

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
  });

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Parse namespace and function name from tool name (format: namespace__funcname)
    const [namespace, ...funcParts] = name.split("__");
    const funcName = funcParts.join("__");

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
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("MCP Bridge server started, connected to:", LOOTBOX_URL);
}

main().catch(console.error);
