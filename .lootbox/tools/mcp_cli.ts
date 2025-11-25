/**
 * MCP CLI Tool - Wrapper for @wong2/mcp-cli to investigate and call MCP servers
 *
 * This tool provides functions to:
 * - Call tools on MCP servers (SSE or HTTP endpoints)
 * - Read resources from MCP servers
 * - Get prompts from MCP servers
 *
 * Useful for investigating how MCP servers work and what tools they expose.
 */

import { $ } from "bun";

/**
 * Call a tool on an MCP server via SSE endpoint
 * @param args.endpoint - The SSE endpoint URL (e.g., "https://mcp.deepwiki.com/sse")
 * @param args.tool_name - The name of the tool to call
 * @param args.tool_args - JSON object of arguments to pass to the tool
 */
export async function call_tool_sse(args: {
  endpoint: string;
  tool_name: string;
  tool_args?: Record<string, unknown>;
}): Promise<{ success: boolean; result?: string; error?: string }> {
  const { endpoint, tool_name, tool_args = {} } = args;

  try {
    const argsJson = JSON.stringify(tool_args);
    // Use a fake server name since we're connecting directly via SSE
    const result = await $`bunx @wong2/mcp-cli --sse ${endpoint} call-tool sse:${tool_name} --args ${argsJson}`.quiet();
    return { success: true, result: result.text() };
  } catch (error) {
    const err = error as { stderr?: { toString(): string }; message?: string };
    return {
      success: false,
      error: err.stderr?.toString() || err.message || String(error)
    };
  }
}

/**
 * Call a tool on an MCP server via HTTP endpoint
 * @param args.endpoint - The HTTP endpoint URL (e.g., "https://mcp.example.com/mcp")
 * @param args.tool_name - The name of the tool to call
 * @param args.tool_args - JSON object of arguments to pass to the tool
 */
export async function call_tool_http(args: {
  endpoint: string;
  tool_name: string;
  tool_args?: Record<string, unknown>;
}): Promise<{ success: boolean; result?: string; error?: string }> {
  const { endpoint, tool_name, tool_args = {} } = args;

  try {
    const argsJson = JSON.stringify(tool_args);
    const result = await $`bunx @wong2/mcp-cli --url ${endpoint} call-tool http:${tool_name} --args ${argsJson}`.quiet();
    return { success: true, result: result.text() };
  } catch (error) {
    const err = error as { stderr?: { toString(): string }; message?: string };
    return {
      success: false,
      error: err.stderr?.toString() || err.message || String(error)
    };
  }
}

/**
 * Read a resource from an MCP server via SSE endpoint
 * @param args.endpoint - The SSE endpoint URL
 * @param args.resource_uri - The URI of the resource to read
 */
export async function read_resource_sse(args: {
  endpoint: string;
  resource_uri: string;
}): Promise<{ success: boolean; result?: string; error?: string }> {
  const { endpoint, resource_uri } = args;

  try {
    const result = await $`bunx @wong2/mcp-cli --sse ${endpoint} read-resource sse:${resource_uri}`.quiet();
    return { success: true, result: result.text() };
  } catch (error) {
    const err = error as { stderr?: { toString(): string }; message?: string };
    return {
      success: false,
      error: err.stderr?.toString() || err.message || String(error)
    };
  }
}

/**
 * Get a prompt from an MCP server via SSE endpoint
 * @param args.endpoint - The SSE endpoint URL
 * @param args.prompt_name - The name of the prompt to get
 * @param args.prompt_args - JSON object of arguments for the prompt
 */
export async function get_prompt_sse(args: {
  endpoint: string;
  prompt_name: string;
  prompt_args?: Record<string, unknown>;
}): Promise<{ success: boolean; result?: string; error?: string }> {
  const { endpoint, prompt_name, prompt_args = {} } = args;

  try {
    const argsJson = JSON.stringify(prompt_args);
    const result = await $`bunx @wong2/mcp-cli --sse ${endpoint} get-prompt sse:${prompt_name} --args ${argsJson}`.quiet();
    return { success: true, result: result.text() };
  } catch (error) {
    const err = error as { stderr?: { toString(): string }; message?: string };
    return {
      success: false,
      error: err.stderr?.toString() || err.message || String(error)
    };
  }
}
