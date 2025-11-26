/**
 * Chrome DevTools Tool - Bridge to Chrome DevTools MCP for browser automation
 *
 * This tool provides browser automation and debugging capabilities via Chrome DevTools Protocol.
 * It bridges to an external chrome-devtools-mcp server running on stdio.
 */

import { spawn, ChildProcess } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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

// Profile configuration
let currentProfileEmail: string | null = null;

// Browser connection configuration
let browserUrl: string | null = null;
const DEFAULT_DEBUG_PORT = 9222;

/**
 * Check if Chrome is running with remote debugging enabled on the specified port
 */
async function checkChromeDebugPort(port: number = DEFAULT_DEBUG_PORT): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get Chrome executable path for the current platform
 */
function getChromeExecutable(): string {
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  } else if (process.platform === "win32") {
    return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  } else {
    return "google-chrome";
  }
}

/**
 * Launch Chrome with remote debugging enabled
 * NOTE: Chrome doesn't allow remote debugging on its default data directory
 * So we always use a separate directory for debugging sessions
 */
async function launchChromeWithDebugging(
  profileDir: string | null,
  port: number = DEFAULT_DEBUG_PORT
): Promise<{ success: boolean; error?: string }> {
  try {
    log.info(`Launching Chrome with debugging on port ${port}...`);

    // Chrome requires a separate user-data-dir for remote debugging
    // It won't work with the standard Chrome data directory
    const debugDataDir = join(homedir(), ".chrome-debug-profile");

    const chromeArgs = [
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${debugDataDir}`,
    ];

    if (profileDir) {
      log.info(`Note: Profile "${profileDir}" specified but debugging requires separate data dir. You may need to log in again.`);
    }

    const chromePath = getChromeExecutable();
    log.info(`Launching: ${chromePath} with data dir: ${debugDataDir}`);

    const chrome = spawn(chromePath, chromeArgs, {
      detached: true,
      stdio: "ignore",
    });
    chrome.unref();

    // Wait for Chrome to start and debugging port to be available
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await checkChromeDebugPort(port)) {
        log.info(`Chrome debugging available on port ${port}`);
        return { success: true };
      }
    }

    return { success: false, error: "Chrome started but debugging port not available. Try closing all Chrome instances first." };
  } catch (err) {
    return { success: false, error: extractErrorMessage(err) };
  }
}

/**
 * Get the Chrome user data directory for the current platform
 */
function getChromeUserDataDir(): string {
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Google", "Chrome");
  } else if (process.platform === "win32") {
    return join(home, "AppData", "Local", "Google", "Chrome", "User Data");
  } else {
    // Linux
    return join(home, ".config", "google-chrome");
  }
}

/**
 * Find the profile directory name that matches a given email address
 * @param email - The Gmail address to search for (e.g., "user@gmail.com")
 * @returns The profile directory name (e.g., "Profile 1") or null if not found
 */
function findProfileByEmail(email: string): string | null {
  const userDataDir = getChromeUserDataDir();

  if (!existsSync(userDataDir)) {
    log.info(`Chrome user data directory not found: ${userDataDir}`);
    return null;
  }

  const entries = readdirSync(userDataDir, { withFileTypes: true });
  const profileDirs = entries
    .filter((e) => e.isDirectory())
    .filter((e) => e.name === "Default" || e.name.startsWith("Profile "))
    .map((e) => e.name);

  for (const profileDir of profileDirs) {
    const prefsPath = join(userDataDir, profileDir, "Preferences");
    if (!existsSync(prefsPath)) {
      continue;
    }

    try {
      const prefs = JSON.parse(readFileSync(prefsPath, "utf-8"));
      // Check account_info array for matching email
      const accountInfo = prefs?.account_info;
      if (Array.isArray(accountInfo)) {
        for (const account of accountInfo) {
          if (account?.email?.toLowerCase() === email.toLowerCase()) {
            log.info(`Found profile "${profileDir}" for email "${email}"`);
            return profileDir;
          }
        }
      }
      // Also check google.services.account_id or signin.email
      const signinEmail = prefs?.signin?.email || prefs?.google?.services?.username;
      if (signinEmail?.toLowerCase() === email.toLowerCase()) {
        log.info(`Found profile "${profileDir}" for email "${email}"`);
        return profileDir;
      }
    } catch (err) {
      // Skip profiles with invalid/unreadable preferences
      continue;
    }
  }

  log.info(`No profile found for email "${email}"`);
  return null;
}

/**
 * Set the Chrome profile to use for the session by email address
 * If the server is already running with a different profile, it will be restarted
 * @param args.email - Gmail address to use (e.g., "user@gmail.com")
 */
export async function set_profile(args: {
  email: string;
}): Promise<{ success: boolean; result?: string; error?: string }> {
  log.call("set_profile", args);

  const { email } = args;

  // Check if profile exists
  const profileDir = findProfileByEmail(email);
  if (!profileDir) {
    const error = `No Chrome profile found for email "${email}". Make sure you have signed into Chrome with this account.`;
    log.error("set_profile", error);
    return { success: false, error };
  }

  // If server is running with different profile, restart it
  if (serverInitialized && currentProfileEmail !== email) {
    log.info(`Profile changed from "${currentProfileEmail}" to "${email}", restarting server...`);
    await stopMcpServer();
  }

  currentProfileEmail = email;
  const result = `Profile set to "${email}" (using Chrome profile directory: ${profileDir})`;
  log.success("set_profile", result);
  return { success: true, result };
}

/**
 * Connect to an existing Chrome browser at a specific debugging URL
 * Use this when you have Chrome running with --remote-debugging-port
 * @param args.url - The debugging URL (e.g., "http://127.0.0.1:9222")
 */
export async function connect_browser(args: {
  url: string;
}): Promise<{ success: boolean; result?: string; error?: string }> {
  log.call("connect_browser", args);

  const { url } = args;

  // Validate URL format
  try {
    new URL(url);
  } catch {
    const error = `Invalid URL format: ${url}`;
    log.error("connect_browser", error);
    return { success: false, error };
  }

  // Check if the debugging endpoint is accessible
  try {
    const response = await fetch(`${url}/json/version`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      const error = `Chrome debugging endpoint not accessible at ${url}`;
      log.error("connect_browser", error);
      return { success: false, error };
    }
  } catch (err) {
    const error = `Cannot connect to Chrome at ${url}: ${extractErrorMessage(err)}`;
    log.error("connect_browser", error);
    return { success: false, error };
  }

  // If server is running, restart it with new URL
  if (serverInitialized) {
    log.info("Restarting server with new browser URL...");
    await stopMcpServer();
  }

  browserUrl = url;
  currentProfileEmail = null; // Clear profile when connecting directly

  const result = `Connected to browser at ${url}`;
  log.success("connect_browser", result);
  return { success: true, result };
}

/**
 * Check if Chrome is running (any instance)
 */
async function isChromeRunning(): Promise<boolean> {
  const { execSync } = await import("node:child_process");
  try {
    if (process.platform === "darwin") {
      const result = execSync("pgrep -x 'Google Chrome'", { encoding: "utf-8" });
      return result.trim().length > 0;
    } else if (process.platform === "win32") {
      const result = execSync("tasklist /FI \"IMAGENAME eq chrome.exe\"", { encoding: "utf-8" });
      return result.includes("chrome.exe");
    } else {
      const result = execSync("pgrep -x chrome", { encoding: "utf-8" });
      return result.trim().length > 0;
    }
  } catch {
    return false;
  }
}

/**
 * Kill all Chrome processes
 */
async function killChrome(): Promise<void> {
  const { execSync } = await import("node:child_process");
  try {
    if (process.platform === "darwin") {
      execSync("pkill -9 'Google Chrome'", { encoding: "utf-8" });
    } else if (process.platform === "win32") {
      execSync("taskkill /F /IM chrome.exe", { encoding: "utf-8" });
    } else {
      execSync("pkill -9 chrome", { encoding: "utf-8" });
    }
    // Wait for Chrome to fully close
    await new Promise((r) => setTimeout(r, 1000));
  } catch {
    // Ignore errors if no Chrome was running
  }
}

/**
 * Launch Chrome with remote debugging enabled for the current profile
 * This allows connecting to Chrome with your logged-in profile
 * @param args.port - Optional debugging port (default: 9222)
 * @param args.restart - If true, will kill existing Chrome and restart with debugging
 */
export async function launch_browser(args: {
  port?: number;
  restart?: boolean;
}): Promise<{ success: boolean; result?: string; error?: string }> {
  log.call("launch_browser", args);

  const port = args.port || DEFAULT_DEBUG_PORT;
  const restart = args.restart ?? false;
  const profileDir = currentProfileEmail ? findProfileByEmail(currentProfileEmail) : null;

  // Check if debug port is already available
  if (await checkChromeDebugPort(port)) {
    const result = `Chrome already running with debugging on port ${port}`;
    log.success("launch_browser", result);
    browserUrl = `http://127.0.0.1:${port}`;
    return { success: true, result };
  }

  // Check if Chrome is running without debugging
  const chromeRunning = await isChromeRunning();
  if (chromeRunning && !restart) {
    const error = `Chrome is running but without remote debugging. Use restart=true to restart Chrome with debugging enabled, or manually restart Chrome with: --remote-debugging-port=${port}`;
    log.error("launch_browser", error);
    return { success: false, error };
  }

  // Kill existing Chrome if restart is requested
  if (chromeRunning && restart) {
    log.info("Killing existing Chrome to restart with debugging...");
    await killChrome();
  }

  // Launch Chrome with debugging
  const launchResult = await launchChromeWithDebugging(profileDir, port);

  if (!launchResult.success) {
    log.error("launch_browser", launchResult.error || "Failed to launch Chrome");
    return { success: false, error: launchResult.error };
  }

  // Restart MCP server if running
  if (serverInitialized) {
    await stopMcpServer();
  }

  browserUrl = `http://127.0.0.1:${port}`;
  const profileInfo = profileDir ? ` with profile "${profileDir}"` : "";
  const result = `Chrome launched${profileInfo} with debugging on port ${port}`;
  log.success("launch_browser", result);
  return { success: true, result };
}

/**
 * Clear the current profile setting (use default Chrome profile)
 */
export async function clear_profile(args: Record<string, never> = {}): Promise<{
  success: boolean;
  result?: string;
  error?: string;
}> {
  log.call("clear_profile", args);

  if (serverInitialized && currentProfileEmail !== null) {
    log.info("Clearing profile, restarting server...");
    await stopMcpServer();
  }

  currentProfileEmail = null;
  const result = "Profile cleared, will use default Chrome profile";
  log.success("clear_profile", result);
  return { success: true, result };
}

/**
 * Get the current profile setting
 */
export async function get_profile(args: Record<string, never> = {}): Promise<{
  success: boolean;
  result?: { email: string | null; profileDir: string | null };
  error?: string;
}> {
  log.call("get_profile", args);

  const profileDir = currentProfileEmail
    ? findProfileByEmail(currentProfileEmail)
    : null;

  return {
    success: true,
    result: {
      email: currentProfileEmail,
      profileDir,
    },
  };
}

/**
 * List all available Chrome profiles with their associated email addresses
 */
export async function list_profiles(args: Record<string, never> = {}): Promise<{
  success: boolean;
  result?: Array<{ profileDir: string; email: string | null; name: string | null }>;
  error?: string;
}> {
  log.call("list_profiles", args);

  const userDataDir = getChromeUserDataDir();

  if (!existsSync(userDataDir)) {
    return {
      success: false,
      error: `Chrome user data directory not found: ${userDataDir}`,
    };
  }

  const profiles: Array<{ profileDir: string; email: string | null; name: string | null }> = [];

  try {
    const entries = readdirSync(userDataDir, { withFileTypes: true });
    const profileDirs = entries
      .filter((e) => e.isDirectory())
      .filter((e) => e.name === "Default" || e.name.startsWith("Profile "))
      .map((e) => e.name);

    for (const profileDir of profileDirs) {
      const prefsPath = join(userDataDir, profileDir, "Preferences");
      let email: string | null = null;
      let name: string | null = null;

      if (existsSync(prefsPath)) {
        try {
          const prefs = JSON.parse(readFileSync(prefsPath, "utf-8"));
          // Get profile name
          name = prefs?.profile?.name || null;
          // Get email from account_info
          const accountInfo = prefs?.account_info;
          if (Array.isArray(accountInfo) && accountInfo.length > 0) {
            email = accountInfo[0]?.email || null;
          }
          // Fallback to signin email
          if (!email) {
            email = prefs?.signin?.email || prefs?.google?.services?.username || null;
          }
        } catch {
          // Skip profiles with invalid preferences
        }
      }

      profiles.push({ profileDir, email, name });
    }

    log.success("list_profiles", `Found ${profiles.length} profiles`);
    return { success: true, result: profiles };
  } catch (err) {
    const error = extractErrorMessage(err);
    log.error("list_profiles", error);
    return { success: false, error };
  }
}

/**
 * Stop the MCP server process
 */
async function stopMcpServer(): Promise<void> {
  if (mcpProcess && !mcpProcess.killed) {
    log.info("Stopping MCP server...");
    mcpProcess.kill();
    mcpProcess = null;
  }
  serverInitialized = false;
  initializationPromise = null;
  pendingRequests.clear();
  responseBuffer = "";
}

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

      // Build command arguments
      const args = ["chrome-devtools-mcp@latest"];

      // If a profile is set, we need to connect to Chrome with that profile
      if (currentProfileEmail) {
        const profileDir = findProfileByEmail(currentProfileEmail);
        if (profileDir) {
          log.info(`Using Chrome profile: ${profileDir} (${currentProfileEmail})`);

          // Check if Chrome is already running with debug port
          const debugAvailable = await checkChromeDebugPort(DEFAULT_DEBUG_PORT);

          if (debugAvailable) {
            // Connect to existing Chrome instance
            log.info(`Connecting to existing Chrome on port ${DEFAULT_DEBUG_PORT}`);
            args.push(`--browserUrl=http://127.0.0.1:${DEFAULT_DEBUG_PORT}`);
          } else {
            // Try to launch Chrome with the profile and debug port
            log.info("No Chrome debug port available, launching Chrome with profile...");
            const launchResult = await launchChromeWithDebugging(profileDir, DEFAULT_DEBUG_PORT);

            if (launchResult.success) {
              args.push(`--browserUrl=http://127.0.0.1:${DEFAULT_DEBUG_PORT}`);
            } else {
              // Fall back to chrome-devtools-mcp launching its own browser
              log.info(`Failed to launch Chrome with profile: ${launchResult.error}. Using default browser.`);
            }
          }
        }
      } else if (browserUrl) {
        // Use explicitly set browser URL
        args.push(`--browserUrl=${browserUrl}`);
      }

      mcpProcess = spawn("npx", args, {
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
 * The MCP tool expects a function declaration string (e.g., "() => document.title")
 * If you provide a plain expression, it will be wrapped in an arrow function automatically
 * @param args.script - JavaScript code to execute (will be auto-wrapped if not a function declaration)
 * @param args.function - Alternative: provide a function declaration directly
 * @param args.args - Optional array of element UIDs to pass as arguments
 */
export async function evaluate_script(args: {
  script?: string;
  function?: string;
  args?: Array<{ uid: string }>;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  log.call("evaluate_script", args);

  let functionStr = args.function || args.script || "";

  // If the input doesn't look like a function declaration, wrap it in one
  const trimmed = functionStr.trim();
  const isFunction =
    trimmed.startsWith("()") ||
    trimmed.startsWith("async ()") ||
    trimmed.startsWith("function") ||
    trimmed.startsWith("(") && trimmed.includes("=>") ||
    trimmed.startsWith("async (");

  if (!isFunction && functionStr) {
    // Wrap plain expressions in an arrow function
    functionStr = `() => (${functionStr})`;
    log.info(`Wrapped script as function: ${functionStr}`);
  }

  const toolArgs: Record<string, unknown> = {
    function: functionStr,
  };

  if (args.args && args.args.length > 0) {
    toolArgs.args = args.args;
  }

  const result = await callTool("evaluate_script", toolArgs);
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
