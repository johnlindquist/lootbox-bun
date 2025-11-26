/**
 * Chrome DevTools Tool - Bridge to Chrome DevTools MCP for browser automation
 *
 * This tool provides browser automation and debugging capabilities via Chrome DevTools Protocol.
 * It bridges to an external chrome-devtools-mcp server running on stdio.
 */

import { spawn, ChildProcess } from "node:child_process";
import { createLogger, extractErrorMessage } from "./shared/index.ts";

// Create logger for this tool
const log = createLogger("chrome_devtools");

// MCP Server management
let mcpProcess: ChildProcess | null = null;
let requestId = 0;
let pendingRequests: Map<
  number,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }
> = new Map();
let serverInitialized = false;
let initializationPromise: Promise<boolean> | null = null;
let responseBuffer = "";

/**
 * Start the Chrome DevTools MCP server process
 */
async function ensureMcpServer(): Promise<boolean> {
  if (serverInitialized && mcpProcess && !mcpProcess.killed) {
    return true;
  }

  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = new Promise(async (resolve) => {
    try {
      log.info("Starting Chrome DevTools MCP server...");

      mcpProcess = spawn("npx", ["chrome-devtools-mcp@latest"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      responseBuffer = "";

      mcpProcess.stdout?.on("data", (data: Buffer) => {
        responseBuffer += data.toString();
        processResponseBuffer();
      });

      mcpProcess.stderr?.on("data", (data: Buffer) => {
        log.info(`MCP stderr: ${data.toString()}`);
      });

      mcpProcess.on("error", (error) => {
        log.error("mcp_process", error.message);
        serverInitialized = false;
        initializationPromise = null;
      });

      mcpProcess.on("exit", (code) => {
        log.info(`MCP server exited with code ${code}`);
        serverInitialized = false;
        initializationPromise = null;
        mcpProcess = null;
      });

      // Send initialize request
      const initRequest = {
        jsonrpc: "2.0",
        id: ++requestId,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "lootbox", version: "1.0" },
        },
      };

      await sendRequest(initRequest);

      // Wait a bit for initialization
      await new Promise((r) => setTimeout(r, 2000));

      serverInitialized = true;
      log.info("Chrome DevTools MCP server initialized");
      resolve(true);
    } catch (error) {
      log.error("ensureMcpServer", extractErrorMessage(error));
      initializationPromise = null;
      resolve(false);
    }
  });

  return initializationPromise;
}

/**
 * Process buffered responses from MCP server
 */
function processResponseBuffer() {
  const lines = responseBuffer.split("\n");
  responseBuffer = lines.pop() || "";

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const response = JSON.parse(line);
      if (response.id && pendingRequests.has(response.id)) {
        const { resolve, reject } = pendingRequests.get(response.id)!;
        pendingRequests.delete(response.id);
        if (response.error) {
          reject(new Error(response.error.message || JSON.stringify(response.error)));
        } else {
          resolve(response.result);
        }
      }
    } catch (e) {
      // Not valid JSON, skip
    }
  }
}

/**
 * Send a request to the MCP server
 */
async function sendRequest(request: object): Promise<void> {
  if (!mcpProcess || !mcpProcess.stdin) {
    throw new Error("MCP server not running");
  }
  const message = JSON.stringify(request) + "\n";
  mcpProcess.stdin.write(message);
}

/**
 * Call a Chrome DevTools MCP tool
 */
async function callTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.info(`Calling Chrome DevTools tool: ${toolName}`);

  const serverReady = await ensureMcpServer();
  if (!serverReady) {
    return { success: false, error: "Failed to start MCP server" };
  }

  return new Promise(async (resolve) => {
    const id = ++requestId;
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      resolve({ success: false, error: "Request timed out" });
    }, 30000);

    pendingRequests.set(id, {
      resolve: (result) => {
        clearTimeout(timeout);
        resolve({ success: true, result });
      },
      reject: (error) => {
        clearTimeout(timeout);
        resolve({ success: false, error: error.message });
      },
    });

    try {
      await sendRequest({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: toolName,
          arguments: args,
        },
      });
    } catch (error) {
      clearTimeout(timeout);
      pendingRequests.delete(id);
      resolve({ success: false, error: extractErrorMessage(error) });
    }
  });
}

// ==================== Navigation Tools ====================

/**
 * Navigate the browser to a specific URL
 * @param args.url - The URL to navigate to
 * @param args.pageId - Optional specific page/tab ID to navigate
 */
export async function navigate_page(args: {
  url: string;
  pageId?: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("navigate_page", args);
  const result = await callTool("navigate_page", args);
  if (result.success) {
    log.success("navigate_page", result.result);
  } else {
    log.error("navigate_page", result.error || "Unknown error");
  }
  return result;
}

/**
 * Create a new browser tab
 * @param args.url - Optional URL to open in the new tab
 */
export async function new_page(args: {
  url?: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("new_page", args);
  const result = await callTool("new_page", args);
  if (result.success) {
    log.success("new_page", result.result);
  } else {
    log.error("new_page", result.error || "Unknown error");
  }
  return result;
}

/**
 * Close a browser tab
 * @param args.pageId - The ID of the page/tab to close
 */
export async function close_page(args: {
  pageId: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("close_page", args);
  const result = await callTool("close_page", args);
  if (result.success) {
    log.success("close_page", result.result);
  } else {
    log.error("close_page", result.error || "Unknown error");
  }
  return result;
}

/**
 * List all open browser tabs/pages
 */
export async function list_pages(args: Record<string, never> = {}): Promise<{
  success: boolean;
  result?: unknown;
  error?: string;
}> {
  log.call("list_pages", args);
  const result = await callTool("list_pages", {});
  if (result.success) {
    log.success("list_pages", result.result);
  } else {
    log.error("list_pages", result.error || "Unknown error");
  }
  return result;
}

/**
 * Switch focus to a specific tab
 * @param args.pageId - The ID of the page/tab to select
 */
export async function select_page(args: {
  pageId: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("select_page", args);
  const result = await callTool("select_page", args);
  if (result.success) {
    log.success("select_page", result.result);
  } else {
    log.error("select_page", result.error || "Unknown error");
  }
  return result;
}

/**
 * Wait for specific conditions before proceeding
 * @param args.condition - What to wait for (e.g., "networkidle", "load", selector)
 * @param args.timeout - Optional max wait time in milliseconds
 * @param args.pageId - Optional specific page to wait on
 */
export async function wait_for(args: {
  condition: string;
  timeout?: number;
  pageId?: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("wait_for", args);
  const result = await callTool("wait_for", args);
  if (result.success) {
    log.success("wait_for", result.result);
  } else {
    log.error("wait_for", result.error || "Unknown error");
  }
  return result;
}

// ==================== Interaction Tools ====================

/**
 * Click on page elements
 * @param args.selector - CSS selector for the element to click
 * @param args.button - Optional mouse button ("left", "right", "middle")
 * @param args.clickCount - Optional number of clicks
 * @param args.pageId - Optional specific page to operate on
 */
export async function click(args: {
  selector: string;
  button?: string;
  clickCount?: number;
  pageId?: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("click", args);
  const result = await callTool("click", args);
  if (result.success) {
    log.success("click", result.result);
  } else {
    log.error("click", result.error || "Unknown error");
  }
  return result;
}

/**
 * Enter text into form fields
 * @param args.selector - CSS selector for the input field
 * @param args.value - Text to enter
 * @param args.pageId - Optional specific page to operate on
 */
export async function fill(args: {
  selector: string;
  value: string;
  pageId?: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("fill", args);
  const result = await callTool("fill", args);
  if (result.success) {
    log.success("fill", result.result);
  } else {
    log.error("fill", result.error || "Unknown error");
  }
  return result;
}

/**
 * Fill multiple form fields at once
 * @param args.fields - Object mapping selectors to values
 * @param args.pageId - Optional specific page to operate on
 */
export async function fill_form(args: {
  fields: Record<string, string>;
  pageId?: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("fill_form", args);
  const result = await callTool("fill_form", args);
  if (result.success) {
    log.success("fill_form", result.result);
  } else {
    log.error("fill_form", result.error || "Unknown error");
  }
  return result;
}

/**
 * Simulate keyboard input
 * @param args.key - Key to press (e.g., "Enter", "Tab", "Escape")
 * @param args.modifiers - Optional array of modifier keys
 * @param args.pageId - Optional specific page to operate on
 */
export async function press_key(args: {
  key: string;
  modifiers?: string[];
  pageId?: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("press_key", args);
  const result = await callTool("press_key", args);
  if (result.success) {
    log.success("press_key", result.result);
  } else {
    log.error("press_key", result.error || "Unknown error");
  }
  return result;
}

/**
 * Move the mouse cursor over elements
 * @param args.selector - CSS selector for the element to hover over
 * @param args.pageId - Optional specific page to operate on
 */
export async function hover(args: {
  selector: string;
  pageId?: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("hover", args);
  const result = await callTool("hover", args);
  if (result.success) {
    log.success("hover", result.result);
  } else {
    log.error("hover", result.error || "Unknown error");
  }
  return result;
}

/**
 * Perform drag and drop operations
 * @param args.sourceSelector - Element to drag from
 * @param args.targetSelector - Element to drag to
 * @param args.pageId - Optional specific page to operate on
 */
export async function drag(args: {
  sourceSelector: string;
  targetSelector: string;
  pageId?: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("drag", args);
  const result = await callTool("drag", args);
  if (result.success) {
    log.success("drag", result.result);
  } else {
    log.error("drag", result.error || "Unknown error");
  }
  return result;
}

/**
 * Handle file upload inputs
 * @param args.selector - CSS selector for file input
 * @param args.filePath - Absolute path to file to upload
 * @param args.pageId - Optional specific page to operate on
 */
export async function upload_file(args: {
  selector: string;
  filePath: string;
  pageId?: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("upload_file", args);
  const result = await callTool("upload_file", args);
  if (result.success) {
    log.success("upload_file", result.result);
  } else {
    log.error("upload_file", result.error || "Unknown error");
  }
  return result;
}

/**
 * Respond to browser dialogs (alerts, confirms, prompts)
 * @param args.action - "accept" or "dismiss"
 * @param args.promptText - Optional text to enter in prompt dialogs
 * @param args.pageId - Optional specific page to operate on
 */
export async function handle_dialog(args: {
  action: string;
  promptText?: string;
  pageId?: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("handle_dialog", args);
  const result = await callTool("handle_dialog", args);
  if (result.success) {
    log.success("handle_dialog", result.result);
  } else {
    log.error("handle_dialog", result.error || "Unknown error");
  }
  return result;
}

// ==================== Debugging Tools ====================

/**
 * Retrieve all console messages from the page
 * @param args.pageId - Optional specific page to get console messages from
 * @param args.types - Optional filter by message type
 */
export async function list_console_messages(args: {
  pageId?: string;
  types?: string[];
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("list_console_messages", args);
  const result = await callTool("list_console_messages", args);
  if (result.success) {
    log.success("list_console_messages", result.result);
  } else {
    log.error("list_console_messages", result.error || "Unknown error");
  }
  return result;
}

/**
 * Retrieve a specific console message by ID
 * @param args.messageId - The ID or index of the message
 * @param args.pageId - Optional specific page
 */
export async function get_console_message(args: {
  messageId: string;
  pageId?: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("get_console_message", args);
  const result = await callTool("get_console_message", args);
  if (result.success) {
    log.success("get_console_message", result.result);
  } else {
    log.error("get_console_message", result.error || "Unknown error");
  }
  return result;
}

/**
 * View all network requests made by the page
 * @param args.pageId - Optional specific page to get requests from
 * @param args.filter - Optional filter by URL pattern, method, or status
 */
export async function list_network_requests(args: {
  pageId?: string;
  filter?: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("list_network_requests", args);
  const result = await callTool("list_network_requests", args);
  if (result.success) {
    log.success("list_network_requests", result.result);
  } else {
    log.error("list_network_requests", result.error || "Unknown error");
  }
  return result;
}

/**
 * Get detailed information about a specific network request
 * @param args.requestId - The ID of the request
 * @param args.pageId - Optional specific page
 */
export async function get_network_request(args: {
  requestId: string;
  pageId?: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("get_network_request", args);
  const result = await callTool("get_network_request", args);
  if (result.success) {
    log.success("get_network_request", result.result);
  } else {
    log.error("get_network_request", result.error || "Unknown error");
  }
  return result;
}

/**
 * Execute JavaScript code in the page context
 * @param args.script - JavaScript code to execute
 * @param args.returnByValue - Optional whether to return the result value
 * @param args.pageId - Optional specific page to execute on
 */
export async function evaluate_script(args: {
  script: string;
  returnByValue?: boolean;
  pageId?: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("evaluate_script", args);
  const result = await callTool("evaluate_script", args);
  if (result.success) {
    log.success("evaluate_script", result.result);
  } else {
    log.error("evaluate_script", result.error || "Unknown error");
  }
  return result;
}

// ==================== Visual Tools ====================

/**
 * Take a screenshot of the page
 * @param args.pageId - Optional specific page to screenshot
 * @param args.fullPage - Optional whether to capture full page
 */
export async function take_screenshot(args: {
  pageId?: string;
  fullPage?: boolean;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("take_screenshot", args);
  const result = await callTool("take_screenshot", args);
  if (result.success) {
    log.success("take_screenshot", result.result);
  } else {
    log.error("take_screenshot", result.error || "Unknown error");
  }
  return result;
}

/**
 * Capture a DOM snapshot
 * @param args.pageId - Optional specific page to snapshot
 */
export async function take_snapshot(args: {
  pageId?: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("take_snapshot", args);
  const result = await callTool("take_snapshot", args);
  if (result.success) {
    log.success("take_snapshot", result.result);
  } else {
    log.error("take_snapshot", result.error || "Unknown error");
  }
  return result;
}

// ==================== Emulation Tools ====================

/**
 * Emulate device/conditions
 * @param args.device - Device to emulate (e.g., "iPhone 13")
 * @param args.pageId - Optional specific page to emulate on
 */
export async function emulate(args: {
  device: string;
  pageId?: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("emulate", args);
  const result = await callTool("emulate", args);
  if (result.success) {
    log.success("emulate", result.result);
  } else {
    log.error("emulate", result.error || "Unknown error");
  }
  return result;
}

/**
 * Resize the viewport
 * @param args.width - Viewport width
 * @param args.height - Viewport height
 * @param args.pageId - Optional specific page to resize
 */
export async function resize_page(args: {
  width: number;
  height: number;
  pageId?: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("resize_page", args);
  const result = await callTool("resize_page", args);
  if (result.success) {
    log.success("resize_page", result.result);
  } else {
    log.error("resize_page", result.error || "Unknown error");
  }
  return result;
}

// ==================== Performance Tools ====================

/**
 * Start performance tracing
 * @param args.pageId - Optional specific page to trace
 */
export async function performance_start_trace(args: {
  pageId?: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("performance_start_trace", args);
  const result = await callTool("performance_start_trace", args);
  if (result.success) {
    log.success("performance_start_trace", result.result);
  } else {
    log.error("performance_start_trace", result.error || "Unknown error");
  }
  return result;
}

/**
 * Stop performance tracing
 * @param args.pageId - Optional specific page
 */
export async function performance_stop_trace(args: {
  pageId?: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("performance_stop_trace", args);
  const result = await callTool("performance_stop_trace", args);
  if (result.success) {
    log.success("performance_stop_trace", result.result);
  } else {
    log.error("performance_stop_trace", result.error || "Unknown error");
  }
  return result;
}

/**
 * Get performance analysis insights
 * @param args.pageId - Optional specific page
 */
export async function performance_analyze_insight(args: {
  pageId?: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("performance_analyze_insight", args);
  const result = await callTool("performance_analyze_insight", args);
  if (result.success) {
    log.success("performance_analyze_insight", result.result);
  } else {
    log.error("performance_analyze_insight", result.error || "Unknown error");
  }
  return result;
}
