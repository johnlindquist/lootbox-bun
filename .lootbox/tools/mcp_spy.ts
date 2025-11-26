/**
 * MCP Spy Tool - Debug and inspect MCP protocol traffic
 *
 * Provides capabilities to:
 * - Capture and store MCP JSON-RPC messages
 * - View traffic history with filtering
 * - Replay past requests to MCP servers
 * - Analyze latency and performance
 * - Export traffic logs for debugging
 *
 * Useful for debugging MCP tool development and understanding protocol behavior.
 */

import { createLogger, extractErrorMessage } from "./shared/index.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const log = createLogger("mcp_spy");

// Storage directory for captured traffic
const TRAFFIC_DIR = join(process.env.HOME || "/tmp", ".lootbox-logs", "mcp-traffic");

// In-memory message store (for fast queries)
interface McpMessage {
  id: string;
  timestamp: number;
  direction: "request" | "response";
  server: string;
  method?: string;
  tool_name?: string;
  params?: unknown;
  result?: unknown;
  error?: string;
  latency_ms?: number;
  request_id?: string | number;
}

// In-memory store
let messageStore: McpMessage[] = [];
let requestStartTimes: Map<string, number> = new Map();

// Ensure traffic directory exists
function ensureTrafficDir(): void {
  if (!existsSync(TRAFFIC_DIR)) {
    mkdirSync(TRAFFIC_DIR, { recursive: true });
  }
}

// Generate unique message ID
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ============================================================================
// TRAFFIC CAPTURE
// ============================================================================

/**
 * Record an outgoing MCP request
 * Call this when sending a request to an MCP server
 *
 * @param args.server - Name/identifier of the MCP server
 * @param args.method - JSON-RPC method (e.g., "tools/call", "initialize")
 * @param args.tool_name - Name of the tool being called (for tools/call)
 * @param args.params - Request parameters
 * @param args.request_id - JSON-RPC request ID
 */
export async function record_request(args: {
  server: string;
  method: string;
  tool_name?: string;
  params?: unknown;
  request_id?: string | number;
}): Promise<{ success: boolean; message_id?: string; error?: string }> {
  log.call("record_request", args);
  const { server, method, tool_name, params, request_id } = args;

  try {
    const id = generateId();
    const timestamp = Date.now();

    const message: McpMessage = {
      id,
      timestamp,
      direction: "request",
      server,
      method,
      tool_name,
      params,
      request_id,
    };

    // Store start time for latency calculation
    const trackingKey = `${server}:${request_id}`;
    requestStartTimes.set(trackingKey, timestamp);

    // Add to in-memory store
    messageStore.push(message);

    // Append to file for persistence
    ensureTrafficDir();
    const logFile = join(TRAFFIC_DIR, `${server.replace(/[^a-zA-Z0-9-_]/g, "_")}.jsonl`);
    appendFileSync(logFile, JSON.stringify(message) + "\n");

    log.success("record_request", { id, server, method, tool_name });
    return { success: true, message_id: id };
  } catch (error) {
    const err = extractErrorMessage(error);
    log.error("record_request", err);
    return { success: false, error: err };
  }
}

/**
 * Record an incoming MCP response
 * Call this when receiving a response from an MCP server
 *
 * @param args.server - Name/identifier of the MCP server
 * @param args.request_id - JSON-RPC request ID (to match with request)
 * @param args.result - Response result (if successful)
 * @param args.error - Error message (if failed)
 */
export async function record_response(args: {
  server: string;
  request_id?: string | number;
  result?: unknown;
  error?: string;
}): Promise<{ success: boolean; message_id?: string; latency_ms?: number; error?: string }> {
  log.call("record_response", args);
  const { server, request_id, result, error: responseError } = args;

  try {
    const id = generateId();
    const timestamp = Date.now();

    // Calculate latency
    const trackingKey = `${server}:${request_id}`;
    const startTime = requestStartTimes.get(trackingKey);
    const latency_ms = startTime ? timestamp - startTime : undefined;
    requestStartTimes.delete(trackingKey);

    const message: McpMessage = {
      id,
      timestamp,
      direction: "response",
      server,
      request_id,
      result,
      error: responseError,
      latency_ms,
    };

    // Add to in-memory store
    messageStore.push(message);

    // Append to file for persistence
    ensureTrafficDir();
    const logFile = join(TRAFFIC_DIR, `${server.replace(/[^a-zA-Z0-9-_]/g, "_")}.jsonl`);
    appendFileSync(logFile, JSON.stringify(message) + "\n");

    log.success("record_response", { id, server, latency_ms });
    return { success: true, message_id: id, latency_ms };
  } catch (error) {
    const err = extractErrorMessage(error);
    log.error("record_response", err);
    return { success: false, error: err };
  }
}

// ============================================================================
// TRAFFIC VIEWING
// ============================================================================

/**
 * Get recent MCP traffic history
 *
 * @param args.server - Filter by server name (optional)
 * @param args.tool_name - Filter by tool name (optional)
 * @param args.method - Filter by method (optional)
 * @param args.direction - Filter by direction: "request" or "response" (optional)
 * @param args.limit - Maximum number of messages to return (default: 50)
 * @param args.errors_only - Only show failed responses (optional)
 */
export async function get_traffic(args: {
  server?: string;
  tool_name?: string;
  method?: string;
  direction?: "request" | "response";
  limit?: number;
  errors_only?: boolean;
}): Promise<{
  success: boolean;
  messages?: McpMessage[];
  count?: number;
  error?: string;
}> {
  log.call("get_traffic", args);
  const { server, tool_name, method, direction, limit = 50, errors_only = false } = args;

  try {
    let filtered = [...messageStore];

    // Apply filters
    if (server) {
      filtered = filtered.filter((m) => m.server.toLowerCase().includes(server.toLowerCase()));
    }
    if (tool_name) {
      filtered = filtered.filter((m) => m.tool_name?.toLowerCase().includes(tool_name.toLowerCase()));
    }
    if (method) {
      filtered = filtered.filter((m) => m.method?.toLowerCase().includes(method.toLowerCase()));
    }
    if (direction) {
      filtered = filtered.filter((m) => m.direction === direction);
    }
    if (errors_only) {
      filtered = filtered.filter((m) => m.error);
    }

    // Sort by timestamp descending (most recent first) and limit
    filtered.sort((a, b) => b.timestamp - a.timestamp);
    const messages = filtered.slice(0, limit);

    log.success("get_traffic", { count: messages.length, total: filtered.length });
    return { success: true, messages, count: messages.length };
  } catch (error) {
    const err = extractErrorMessage(error);
    log.error("get_traffic", err);
    return { success: false, error: err };
  }
}

/**
 * Get a specific message by ID
 *
 * @param args.message_id - The message ID to retrieve
 */
export async function get_message(args: {
  message_id: string;
}): Promise<{ success: boolean; message?: McpMessage; error?: string }> {
  log.call("get_message", args);
  const { message_id } = args;

  try {
    const message = messageStore.find((m) => m.id === message_id);

    if (!message) {
      const err = `Message not found: ${message_id}`;
      log.error("get_message", err);
      return { success: false, error: err };
    }

    log.success("get_message", { id: message_id });
    return { success: true, message };
  } catch (error) {
    const err = extractErrorMessage(error);
    log.error("get_message", err);
    return { success: false, error: err };
  }
}

/**
 * Get a request-response pair by request ID
 *
 * @param args.server - Server name
 * @param args.request_id - JSON-RPC request ID
 */
export async function get_request_pair(args: {
  server: string;
  request_id: string | number;
}): Promise<{
  success: boolean;
  request?: McpMessage;
  response?: McpMessage;
  latency_ms?: number;
  error?: string;
}> {
  log.call("get_request_pair", args);
  const { server, request_id } = args;

  try {
    const request = messageStore.find(
      (m) => m.server === server && m.request_id === request_id && m.direction === "request"
    );
    const response = messageStore.find(
      (m) => m.server === server && m.request_id === request_id && m.direction === "response"
    );

    log.success("get_request_pair", { found_request: !!request, found_response: !!response });
    return {
      success: true,
      request,
      response,
      latency_ms: response?.latency_ms,
    };
  } catch (error) {
    const err = extractErrorMessage(error);
    log.error("get_request_pair", err);
    return { success: false, error: err };
  }
}

// ============================================================================
// ANALYTICS
// ============================================================================

/**
 * Get latency statistics for MCP calls
 *
 * @param args.server - Filter by server name (optional)
 * @param args.tool_name - Filter by tool name (optional)
 */
export async function get_latency_stats(args: {
  server?: string;
  tool_name?: string;
}): Promise<{
  success: boolean;
  stats?: {
    total_calls: number;
    avg_latency_ms: number;
    min_latency_ms: number;
    max_latency_ms: number;
    p50_latency_ms: number;
    p95_latency_ms: number;
    error_rate: number;
  };
  by_tool?: Record<string, { count: number; avg_latency_ms: number; error_count: number }>;
  error?: string;
}> {
  log.call("get_latency_stats", args);
  const { server, tool_name } = args;

  try {
    // Get responses with latency data
    let responses = messageStore.filter((m) => m.direction === "response");

    if (server) {
      responses = responses.filter((m) => m.server.toLowerCase().includes(server.toLowerCase()));
    }

    // Match responses with their requests to get tool names
    const requestsByKey = new Map<string, McpMessage>();
    for (const m of messageStore.filter((m) => m.direction === "request")) {
      requestsByKey.set(`${m.server}:${m.request_id}`, m);
    }

    // Enrich responses with tool_name from requests
    const enrichedResponses = responses.map((r) => {
      const req = requestsByKey.get(`${r.server}:${r.request_id}`);
      return { ...r, tool_name: req?.tool_name };
    });

    let filtered = enrichedResponses;
    if (tool_name) {
      filtered = filtered.filter((m) => m.tool_name?.toLowerCase().includes(tool_name.toLowerCase()));
    }

    const latencies = filtered.filter((m) => m.latency_ms !== undefined).map((m) => m.latency_ms!);
    const errorCount = filtered.filter((m) => m.error).length;

    if (latencies.length === 0) {
      log.success("get_latency_stats", { total_calls: 0 });
      return {
        success: true,
        stats: {
          total_calls: 0,
          avg_latency_ms: 0,
          min_latency_ms: 0,
          max_latency_ms: 0,
          p50_latency_ms: 0,
          p95_latency_ms: 0,
          error_rate: 0,
        },
      };
    }

    latencies.sort((a, b) => a - b);

    const stats = {
      total_calls: filtered.length,
      avg_latency_ms: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
      min_latency_ms: latencies[0],
      max_latency_ms: latencies[latencies.length - 1],
      p50_latency_ms: latencies[Math.floor(latencies.length * 0.5)],
      p95_latency_ms: latencies[Math.floor(latencies.length * 0.95)],
      error_rate: Math.round((errorCount / filtered.length) * 100) / 100,
    };

    // Group by tool
    const byTool: Record<string, { count: number; total_latency: number; error_count: number }> = {};
    for (const m of filtered) {
      const name = m.tool_name || "unknown";
      if (!byTool[name]) {
        byTool[name] = { count: 0, total_latency: 0, error_count: 0 };
      }
      byTool[name].count++;
      byTool[name].total_latency += m.latency_ms || 0;
      if (m.error) byTool[name].error_count++;
    }

    const by_tool: Record<string, { count: number; avg_latency_ms: number; error_count: number }> = {};
    for (const [name, data] of Object.entries(byTool)) {
      by_tool[name] = {
        count: data.count,
        avg_latency_ms: Math.round(data.total_latency / data.count),
        error_count: data.error_count,
      };
    }

    log.success("get_latency_stats", stats);
    return { success: true, stats, by_tool };
  } catch (error) {
    const err = extractErrorMessage(error);
    log.error("get_latency_stats", err);
    return { success: false, error: err };
  }
}

/**
 * Get summary of all servers and their traffic
 */
export async function get_server_summary(args: Record<string, never> = {}): Promise<{
  success: boolean;
  servers?: Array<{
    name: string;
    request_count: number;
    response_count: number;
    error_count: number;
    last_activity: string;
  }>;
  error?: string;
}> {
  log.call("get_server_summary", {});

  try {
    const serverMap = new Map<
      string,
      { request_count: number; response_count: number; error_count: number; last_timestamp: number }
    >();

    for (const m of messageStore) {
      if (!serverMap.has(m.server)) {
        serverMap.set(m.server, {
          request_count: 0,
          response_count: 0,
          error_count: 0,
          last_timestamp: 0,
        });
      }
      const data = serverMap.get(m.server)!;
      if (m.direction === "request") data.request_count++;
      if (m.direction === "response") data.response_count++;
      if (m.error) data.error_count++;
      if (m.timestamp > data.last_timestamp) data.last_timestamp = m.timestamp;
    }

    const servers = Array.from(serverMap.entries())
      .map(([name, data]) => ({
        name,
        request_count: data.request_count,
        response_count: data.response_count,
        error_count: data.error_count,
        last_activity: new Date(data.last_timestamp).toISOString(),
      }))
      .sort((a, b) => b.request_count - a.request_count);

    log.success("get_server_summary", { server_count: servers.length });
    return { success: true, servers };
  } catch (error) {
    const err = extractErrorMessage(error);
    log.error("get_server_summary", err);
    return { success: false, error: err };
  }
}

// ============================================================================
// MANAGEMENT
// ============================================================================

/**
 * Clear traffic history (in-memory and optionally files)
 *
 * @param args.clear_files - Also delete persisted log files (default: false)
 * @param args.server - Only clear traffic for specific server (optional)
 */
export async function clear_traffic(args: {
  clear_files?: boolean;
  server?: string;
}): Promise<{ success: boolean; cleared_count?: number; error?: string }> {
  log.call("clear_traffic", args);
  const { clear_files = false, server } = args;

  try {
    let cleared_count: number;

    if (server) {
      const before = messageStore.length;
      messageStore = messageStore.filter((m) => m.server !== server);
      cleared_count = before - messageStore.length;

      if (clear_files) {
        const logFile = join(TRAFFIC_DIR, `${server.replace(/[^a-zA-Z0-9-_]/g, "_")}.jsonl`);
        if (existsSync(logFile)) {
          writeFileSync(logFile, "");
        }
      }
    } else {
      cleared_count = messageStore.length;
      messageStore = [];
      requestStartTimes.clear();

      if (clear_files && existsSync(TRAFFIC_DIR)) {
        const { readdirSync, unlinkSync } = await import("node:fs");
        for (const file of readdirSync(TRAFFIC_DIR)) {
          if (file.endsWith(".jsonl")) {
            unlinkSync(join(TRAFFIC_DIR, file));
          }
        }
      }
    }

    log.success("clear_traffic", { cleared_count });
    return { success: true, cleared_count };
  } catch (error) {
    const err = extractErrorMessage(error);
    log.error("clear_traffic", err);
    return { success: false, error: err };
  }
}

/**
 * Load traffic history from persisted log files
 *
 * @param args.server - Only load from specific server log (optional)
 */
export async function load_traffic(args: {
  server?: string;
}): Promise<{ success: boolean; loaded_count?: number; error?: string }> {
  log.call("load_traffic", args);
  const { server } = args;

  try {
    ensureTrafficDir();

    const { readdirSync } = await import("node:fs");
    let files = readdirSync(TRAFFIC_DIR).filter((f) => f.endsWith(".jsonl"));

    if (server) {
      const serverFile = `${server.replace(/[^a-zA-Z0-9-_]/g, "_")}.jsonl`;
      files = files.filter((f) => f === serverFile);
    }

    let loaded_count = 0;
    const existingIds = new Set(messageStore.map((m) => m.id));

    for (const file of files) {
      const content = readFileSync(join(TRAFFIC_DIR, file), "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      for (const line of lines) {
        try {
          const message = JSON.parse(line) as McpMessage;
          if (!existingIds.has(message.id)) {
            messageStore.push(message);
            existingIds.add(message.id);
            loaded_count++;
          }
        } catch {
          // Skip malformed lines
        }
      }
    }

    log.success("load_traffic", { loaded_count });
    return { success: true, loaded_count };
  } catch (error) {
    const err = extractErrorMessage(error);
    log.error("load_traffic", err);
    return { success: false, error: err };
  }
}

/**
 * Export traffic to a JSON file for external analysis
 *
 * @param args.output_path - Path to write the export file
 * @param args.server - Only export traffic for specific server (optional)
 * @param args.format - Export format: "json" or "jsonl" (default: "json")
 */
export async function export_traffic(args: {
  output_path: string;
  server?: string;
  format?: "json" | "jsonl";
}): Promise<{ success: boolean; exported_count?: number; error?: string }> {
  log.call("export_traffic", args);
  const { output_path, server, format = "json" } = args;

  try {
    let messages = [...messageStore];

    if (server) {
      messages = messages.filter((m) => m.server === server);
    }

    messages.sort((a, b) => a.timestamp - b.timestamp);

    const content =
      format === "json"
        ? JSON.stringify(messages, null, 2)
        : messages.map((m) => JSON.stringify(m)).join("\n");

    writeFileSync(output_path, content);

    log.success("export_traffic", { exported_count: messages.length, output_path });
    return { success: true, exported_count: messages.length };
  } catch (error) {
    const err = extractErrorMessage(error);
    log.error("export_traffic", err);
    return { success: false, error: err };
  }
}

// ============================================================================
// REPLAY
// ============================================================================

/**
 * Get a request formatted for replay
 * Returns the original request parameters so you can modify and resend
 *
 * @param args.message_id - The message ID of the request to get
 */
export async function get_replay_request(args: {
  message_id: string;
}): Promise<{
  success: boolean;
  replay_data?: {
    server: string;
    method: string;
    tool_name?: string;
    params: unknown;
  };
  error?: string;
}> {
  log.call("get_replay_request", args);
  const { message_id } = args;

  try {
    const message = messageStore.find((m) => m.id === message_id && m.direction === "request");

    if (!message) {
      const err = `Request not found: ${message_id}`;
      log.error("get_replay_request", err);
      return { success: false, error: err };
    }

    const replay_data = {
      server: message.server,
      method: message.method!,
      tool_name: message.tool_name,
      params: message.params,
    };

    log.success("get_replay_request", { server: message.server, tool_name: message.tool_name });
    return { success: true, replay_data };
  } catch (error) {
    const err = extractErrorMessage(error);
    log.error("get_replay_request", err);
    return { success: false, error: err };
  }
}

/**
 * Find failed requests that can be retried
 *
 * @param args.server - Filter by server (optional)
 * @param args.limit - Maximum number of results (default: 20)
 */
export async function find_failed_requests(args: {
  server?: string;
  limit?: number;
}): Promise<{
  success: boolean;
  failed_requests?: Array<{
    request_id: string;
    server: string;
    tool_name?: string;
    error: string;
    timestamp: string;
  }>;
  error?: string;
}> {
  log.call("find_failed_requests", args);
  const { server, limit = 20 } = args;

  try {
    // Find responses with errors
    let failedResponses = messageStore.filter((m) => m.direction === "response" && m.error);

    if (server) {
      failedResponses = failedResponses.filter((m) =>
        m.server.toLowerCase().includes(server.toLowerCase())
      );
    }

    // Match with their requests
    const requestMap = new Map<string, McpMessage>();
    for (const m of messageStore.filter((m) => m.direction === "request")) {
      requestMap.set(`${m.server}:${m.request_id}`, m);
    }

    const failed_requests = failedResponses
      .map((resp) => {
        const req = requestMap.get(`${resp.server}:${resp.request_id}`);
        return {
          request_id: req?.id || "unknown",
          server: resp.server,
          tool_name: req?.tool_name,
          error: resp.error!,
          timestamp: new Date(resp.timestamp).toISOString(),
        };
      })
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);

    log.success("find_failed_requests", { count: failed_requests.length });
    return { success: true, failed_requests };
  } catch (error) {
    const err = extractErrorMessage(error);
    log.error("find_failed_requests", err);
    return { success: false, error: err };
  }
}
