/**
 * Tmux Tool - Programmatic control of tmux sessions for parallel task observation
 *
 * Enables a master AI agent to:
 * - Create/manage multiple tmux sessions for parallel work
 * - Send commands and keystrokes to sessions
 * - Capture and monitor output from sessions
 * - Orchestrate multiple agents working in parallel
 *
 * Security: All operations are confined to a dedicated claude socket directory
 * to avoid interfering with user's personal tmux sessions.
 */

import { createLogger, extractErrorMessage, type ProgressCallback } from "./shared/index.ts";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

const log = createLogger("tmux");

// Socket directory for all claude-managed tmux sessions
const SOCKET_DIR = process.env.CLAUDE_TMUX_SOCKET_DIR || join(process.env.TMPDIR || "/tmp", "claude-tmux-sockets");
const DEFAULT_SOCKET = join(SOCKET_DIR, "claude.sock");

// Detect terminal app (iTerm2 preferred, fallback to Terminal.app)
const TERMINAL_APP = process.env.TERM_PROGRAM === "iTerm.app" ? "iTerm2" : "Terminal";

// Progress callback for long operations
let globalProgressCallback: ProgressCallback | null = null;

export function setProgressCallback(callback: ProgressCallback | null): void {
  globalProgressCallback = callback;
}

function sendProgress(message: string): void {
  if (globalProgressCallback) {
    globalProgressCallback(message);
  }
}

/**
 * Ensure the socket directory exists
 */
function ensureSocketDir(): void {
  if (!existsSync(SOCKET_DIR)) {
    mkdirSync(SOCKET_DIR, { recursive: true });
  }
}

/**
 * Validate that a socket path is within the safe claude directory
 */
function validateSocketPath(socketPath: string): { valid: boolean; error?: string } {
  if (!socketPath.startsWith(SOCKET_DIR)) {
    return {
      valid: false,
      error: `Socket path must be under ${SOCKET_DIR}. Got: ${socketPath}`,
    };
  }
  return { valid: true };
}

/**
 * Open a new terminal window and run a command using AppleScript
 * Works with iTerm2 and Terminal.app on macOS
 */
async function openTerminalWindow(command: string): Promise<{ success: boolean; error?: string }> {
  log.info(`Opening terminal window with command: ${command}`);

  // Escape single quotes for AppleScript
  const escapedCommand = command.replace(/'/g, "'\"'\"'");

  let appleScript: string;

  if (TERMINAL_APP === "iTerm2") {
    appleScript = `
      tell application "iTerm2"
        activate
        set newWindow to (create window with default profile)
        tell current session of newWindow
          write text "${escapedCommand}"
        end tell
      end tell
    `;
  } else {
    appleScript = `
      tell application "Terminal"
        activate
        do script "${escapedCommand}"
      end tell
    `;
  }

  try {
    const proc = Bun.spawn(["osascript", "-e", appleScript], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return { success: false, error: stderr || `osascript exited with code ${exitCode}` };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: extractErrorMessage(error) };
  }
}

/**
 * Run a tmux command and return the result
 */
async function runTmux(
  args: string[],
  socketPath: string = DEFAULT_SOCKET
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const validation = validateSocketPath(socketPath);
  if (!validation.valid) {
    return { success: false, stdout: "", stderr: validation.error! };
  }

  ensureSocketDir();

  const fullArgs = ["-S", socketPath, ...args];
  log.info(`Running: tmux ${fullArgs.join(" ")}`);

  try {
    const proc = Bun.spawn(["tmux", ...fullArgs], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;

    return {
      success: exitCode === 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (error) {
    return {
      success: false,
      stdout: "",
      stderr: extractErrorMessage(error),
    };
  }
}

// ============================================================================
// SESSION MANAGEMENT
// ============================================================================

/**
 * Create a new tmux session for running tasks
 *
 * @param args.session_name - Name for the session (e.g., "agent-1", "build-task")
 * @param args.window_name - Optional name for the initial window
 * @param args.start_command - Optional command to run when session starts
 * @param args.working_dir - Optional working directory for the session
 * @param args.socket_path - Optional custom socket path (defaults to claude socket)
 * @param args.visible - If true (default), opens a new terminal window attached to the session
 */
export async function create_session(args: {
  session_name: string;
  window_name?: string;
  start_command?: string;
  working_dir?: string;
  socket_path?: string;
  visible?: boolean;
}): Promise<{
  success: boolean;
  session_name?: string;
  socket_path?: string;
  monitor_command?: string;
  visible?: boolean;
  error?: string;
}> {
  log.call("create_session", args);
  const {
    session_name,
    window_name = "main",
    start_command,
    working_dir,
    socket_path = DEFAULT_SOCKET,
    visible = true, // Default to visible
  } = args;

  // Validate session name (no spaces, slug-like)
  if (!/^[a-zA-Z0-9_-]+$/.test(session_name)) {
    const err = "Session name must be alphanumeric with dashes/underscores only";
    log.error("create_session", err);
    return { success: false, error: err };
  }

  // Always create session detached first, then optionally attach in new window
  const tmuxArgs = ["new-session", "-d", "-s", session_name, "-n", window_name];

  if (working_dir) {
    tmuxArgs.push("-c", working_dir);
  }

  const result = await runTmux(tmuxArgs, socket_path);

  if (!result.success) {
    // Check if session already exists
    if (result.stderr.includes("duplicate session")) {
      log.info(`Session ${session_name} already exists, reusing`);
    } else {
      log.error("create_session", result.stderr);
      return { success: false, error: result.stderr };
    }
  }

  // If a start command was provided, send it
  if (start_command) {
    await runTmux(
      ["send-keys", "-t", `${session_name}:${window_name}`, start_command, "Enter"],
      socket_path
    );
  }

  const monitor_command = `tmux -S "${socket_path}" attach -t ${session_name}`;

  // If visible, open a new terminal window and attach to the session
  if (visible) {
    const termResult = await openTerminalWindow(monitor_command);
    if (!termResult.success) {
      log.warn(`Failed to open visible terminal: ${termResult.error}. Session created but not visible.`);
    }
  }

  log.success("create_session", { session_name, socket_path, monitor_command, visible });
  return {
    success: true,
    session_name,
    socket_path,
    monitor_command,
    visible,
  };
}

/**
 * List all active tmux sessions on the claude socket
 *
 * @param args.socket_path - Optional custom socket path
 * @param args.filter - Optional filter for session names
 */
export async function list_sessions(args: {
  socket_path?: string;
  filter?: string;
}): Promise<{
  success: boolean;
  sessions?: Array<{
    name: string;
    attached: boolean;
    created: string;
    windows: number;
  }>;
  error?: string;
}> {
  log.call("list_sessions", args);
  const { socket_path = DEFAULT_SOCKET, filter } = args;

  const result = await runTmux(
    ["list-sessions", "-F", "#{session_name}\t#{session_attached}\t#{session_created_string}\t#{session_windows}"],
    socket_path
  );

  if (!result.success) {
    // No server running is not an error, just means no sessions
    if (result.stderr.includes("no server") || result.stderr.includes("connection refused")) {
      log.success("list_sessions", []);
      return { success: true, sessions: [] };
    }
    log.error("list_sessions", result.stderr);
    return { success: false, error: result.stderr };
  }

  let sessions = result.stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [name, attached, created, windows] = line.split("\t");
      return {
        name,
        attached: attached === "1",
        created,
        windows: parseInt(windows, 10),
      };
    });

  if (filter) {
    const filterLower = filter.toLowerCase();
    sessions = sessions.filter((s) => s.name.toLowerCase().includes(filterLower));
  }

  log.success("list_sessions", sessions);
  return { success: true, sessions };
}

/**
 * Attach to an existing session in a new visible terminal window
 *
 * @param args.session_name - Name of the session to attach to
 * @param args.socket_path - Optional custom socket path
 */
export async function attach_session(args: {
  session_name: string;
  socket_path?: string;
}): Promise<{ success: boolean; monitor_command?: string; error?: string }> {
  log.call("attach_session", args);
  const { session_name, socket_path = DEFAULT_SOCKET } = args;

  // Verify session exists
  const listResult = await list_sessions({ socket_path, filter: session_name });
  if (!listResult.success) {
    return { success: false, error: listResult.error };
  }

  const sessionExists = listResult.sessions?.some((s) => s.name === session_name);
  if (!sessionExists) {
    const err = `Session '${session_name}' not found`;
    log.error("attach_session", err);
    return { success: false, error: err };
  }

  const monitor_command = `tmux -S "${socket_path}" attach -t ${session_name}`;

  const termResult = await openTerminalWindow(monitor_command);
  if (!termResult.success) {
    log.error("attach_session", termResult.error || "Failed to open terminal");
    return { success: false, error: termResult.error };
  }

  log.success("attach_session", { session_name, monitor_command });
  return { success: true, monitor_command };
}

/**
 * Kill/close a tmux session
 *
 * @param args.session_name - Name of the session to kill
 * @param args.socket_path - Optional custom socket path
 */
export async function kill_session(args: {
  session_name: string;
  socket_path?: string;
}): Promise<{ success: boolean; error?: string }> {
  log.call("kill_session", args);
  const { session_name, socket_path = DEFAULT_SOCKET } = args;

  const result = await runTmux(["kill-session", "-t", session_name], socket_path);

  if (!result.success) {
    log.error("kill_session", result.stderr);
    return { success: false, error: result.stderr };
  }

  log.success("kill_session", { session_name });
  return { success: true };
}

/**
 * Kill all sessions on the claude socket (cleanup)
 *
 * @param args.socket_path - Optional custom socket path
 */
export async function kill_all_sessions(args: {
  socket_path?: string;
}): Promise<{ success: boolean; killed_count?: number; error?: string }> {
  log.call("kill_all_sessions", args);
  const { socket_path = DEFAULT_SOCKET } = args;

  // First list all sessions
  const listResult = await list_sessions({ socket_path });
  if (!listResult.success) {
    return { success: false, error: listResult.error };
  }

  if (!listResult.sessions || listResult.sessions.length === 0) {
    log.success("kill_all_sessions", { killed_count: 0 });
    return { success: true, killed_count: 0 };
  }

  // Kill the server (kills all sessions)
  const result = await runTmux(["kill-server"], socket_path);

  if (!result.success && !result.stderr.includes("no server")) {
    log.error("kill_all_sessions", result.stderr);
    return { success: false, error: result.stderr };
  }

  const killed_count = listResult.sessions.length;
  log.success("kill_all_sessions", { killed_count });
  return { success: true, killed_count };
}

// ============================================================================
// COMMAND EXECUTION
// ============================================================================

/**
 * Send keys/commands to a tmux session
 *
 * @param args.session_name - Target session name
 * @param args.keys - Keys or command to send
 * @param args.literal - If true, send keys literally (no special key interpretation)
 * @param args.enter - If true, append Enter key (default: true)
 * @param args.target - Optional specific target (window.pane), defaults to :0.0
 * @param args.socket_path - Optional custom socket path
 */
export async function send_keys(args: {
  session_name: string;
  keys: string;
  literal?: boolean;
  enter?: boolean;
  target?: string;
  socket_path?: string;
}): Promise<{ success: boolean; error?: string }> {
  log.call("send_keys", args);
  const {
    session_name,
    keys,
    literal = false,
    enter = true,
    target = "0.0",
    socket_path = DEFAULT_SOCKET,
  } = args;

  const fullTarget = `${session_name}:${target}`;
  const tmuxArgs = ["send-keys", "-t", fullTarget];

  if (literal) {
    tmuxArgs.push("-l");
  }

  tmuxArgs.push("--", keys);

  if (enter) {
    tmuxArgs.push("Enter");
  }

  const result = await runTmux(tmuxArgs, socket_path);

  if (!result.success) {
    log.error("send_keys", result.stderr);
    return { success: false, error: result.stderr };
  }

  log.success("send_keys", { session_name, keys: keys.substring(0, 50) });
  return { success: true };
}

/**
 * Send a control key sequence (C-c, C-d, C-z, etc.)
 *
 * @param args.session_name - Target session name
 * @param args.control_key - Control key to send (e.g., "C-c", "C-d", "Escape")
 * @param args.target - Optional specific target (window.pane)
 * @param args.socket_path - Optional custom socket path
 */
export async function send_control_key(args: {
  session_name: string;
  control_key: string;
  target?: string;
  socket_path?: string;
}): Promise<{ success: boolean; error?: string }> {
  log.call("send_control_key", args);
  const { session_name, control_key, target = "0.0", socket_path = DEFAULT_SOCKET } = args;

  const fullTarget = `${session_name}:${target}`;
  const result = await runTmux(["send-keys", "-t", fullTarget, control_key], socket_path);

  if (!result.success) {
    log.error("send_control_key", result.stderr);
    return { success: false, error: result.stderr };
  }

  log.success("send_control_key", { session_name, control_key });
  return { success: true };
}

// ============================================================================
// OUTPUT CAPTURE
// ============================================================================

/**
 * Capture the current output from a tmux pane
 *
 * @param args.session_name - Target session name
 * @param args.lines - Number of history lines to capture (default: 200)
 * @param args.target - Optional specific target (window.pane)
 * @param args.socket_path - Optional custom socket path
 */
export async function capture_output(args: {
  session_name: string;
  lines?: number;
  target?: string;
  socket_path?: string;
}): Promise<{ success: boolean; output?: string; error?: string }> {
  log.call("capture_output", args);
  const { session_name, lines = 200, target = "0.0", socket_path = DEFAULT_SOCKET } = args;

  const fullTarget = `${session_name}:${target}`;
  const result = await runTmux(
    ["capture-pane", "-p", "-J", "-t", fullTarget, "-S", `-${lines}`],
    socket_path
  );

  if (!result.success) {
    log.error("capture_output", result.stderr);
    return { success: false, error: result.stderr };
  }

  log.success("capture_output", result.stdout.substring(0, 100));
  return { success: true, output: result.stdout };
}

/**
 * Wait for specific text/pattern to appear in a tmux pane
 *
 * @param args.session_name - Target session name
 * @param args.pattern - Regex pattern to wait for
 * @param args.timeout_seconds - Timeout in seconds (default: 30)
 * @param args.poll_interval - Poll interval in seconds (default: 0.5)
 * @param args.lines - Number of history lines to search (default: 1000)
 * @param args.target - Optional specific target (window.pane)
 * @param args.socket_path - Optional custom socket path
 */
export async function wait_for_text(args: {
  session_name: string;
  pattern: string;
  timeout_seconds?: number;
  poll_interval?: number;
  lines?: number;
  target?: string;
  socket_path?: string;
}): Promise<{ success: boolean; matched?: boolean; output?: string; error?: string }> {
  log.call("wait_for_text", args);
  const {
    session_name,
    pattern,
    timeout_seconds = 30,
    poll_interval = 0.5,
    lines = 1000,
    target = "0.0",
    socket_path = DEFAULT_SOCKET,
  } = args;

  const fullTarget = `${session_name}:${target}`;
  const regex = new RegExp(pattern);
  const startTime = Date.now();
  const timeoutMs = timeout_seconds * 1000;
  const pollMs = poll_interval * 1000;

  sendProgress(`Waiting for pattern "${pattern}" in ${session_name}...`);

  while (Date.now() - startTime < timeoutMs) {
    const result = await runTmux(
      ["capture-pane", "-p", "-J", "-t", fullTarget, "-S", `-${lines}`],
      socket_path
    );

    if (result.success && regex.test(result.stdout)) {
      log.success("wait_for_text", { matched: true, pattern });
      return { success: true, matched: true, output: result.stdout };
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    sendProgress(`Still waiting for "${pattern}"... (${elapsed}s)`);

    await Bun.sleep(pollMs);
  }

  // Timeout - capture final output for debugging
  const finalCapture = await runTmux(
    ["capture-pane", "-p", "-J", "-t", fullTarget, "-S", `-${lines}`],
    socket_path
  );

  log.error("wait_for_text", `Timeout after ${timeout_seconds}s waiting for: ${pattern}`);
  return {
    success: false,
    matched: false,
    output: finalCapture.stdout,
    error: `Timeout after ${timeout_seconds}s waiting for pattern: ${pattern}`,
  };
}

// ============================================================================
// WINDOW/PANE MANAGEMENT
// ============================================================================

/**
 * Create a new window in an existing session
 *
 * @param args.session_name - Target session name
 * @param args.window_name - Name for the new window
 * @param args.start_command - Optional command to run in the new window
 * @param args.socket_path - Optional custom socket path
 */
export async function create_window(args: {
  session_name: string;
  window_name: string;
  start_command?: string;
  socket_path?: string;
}): Promise<{ success: boolean; window_name?: string; error?: string }> {
  log.call("create_window", args);
  const { session_name, window_name, start_command, socket_path = DEFAULT_SOCKET } = args;

  const tmuxArgs = ["new-window", "-t", session_name, "-n", window_name];

  const result = await runTmux(tmuxArgs, socket_path);

  if (!result.success) {
    log.error("create_window", result.stderr);
    return { success: false, error: result.stderr };
  }

  if (start_command) {
    await runTmux(
      ["send-keys", "-t", `${session_name}:${window_name}`, start_command, "Enter"],
      socket_path
    );
  }

  log.success("create_window", { session_name, window_name });
  return { success: true, window_name };
}

/**
 * Split a pane horizontally or vertically
 *
 * @param args.session_name - Target session name
 * @param args.direction - Split direction: "horizontal" or "vertical"
 * @param args.target - Optional specific target (window.pane)
 * @param args.start_command - Optional command to run in the new pane
 * @param args.socket_path - Optional custom socket path
 */
export async function split_pane(args: {
  session_name: string;
  direction: "horizontal" | "vertical";
  target?: string;
  start_command?: string;
  socket_path?: string;
}): Promise<{ success: boolean; error?: string }> {
  log.call("split_pane", args);
  const {
    session_name,
    direction,
    target = "0.0",
    start_command,
    socket_path = DEFAULT_SOCKET,
  } = args;

  const fullTarget = `${session_name}:${target}`;
  const splitFlag = direction === "horizontal" ? "-h" : "-v";

  const result = await runTmux(["split-window", splitFlag, "-t", fullTarget], socket_path);

  if (!result.success) {
    log.error("split_pane", result.stderr);
    return { success: false, error: result.stderr };
  }

  if (start_command) {
    // The new pane becomes the active one after split
    await runTmux(["send-keys", start_command, "Enter"], socket_path);
  }

  log.success("split_pane", { session_name, direction });
  return { success: true };
}

/**
 * List all panes in a session
 *
 * @param args.session_name - Target session name
 * @param args.socket_path - Optional custom socket path
 */
export async function list_panes(args: {
  session_name: string;
  socket_path?: string;
}): Promise<{
  success: boolean;
  panes?: Array<{
    window_index: number;
    window_name: string;
    pane_index: number;
    pane_id: string;
    active: boolean;
    current_command: string;
  }>;
  error?: string;
}> {
  log.call("list_panes", args);
  const { session_name, socket_path = DEFAULT_SOCKET } = args;

  const result = await runTmux(
    [
      "list-panes",
      "-t",
      session_name,
      "-a",
      "-F",
      "#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_id}\t#{pane_active}\t#{pane_current_command}",
    ],
    socket_path
  );

  if (!result.success) {
    log.error("list_panes", result.stderr);
    return { success: false, error: result.stderr };
  }

  const panes = result.stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [window_index, window_name, pane_index, pane_id, active, current_command] =
        line.split("\t");
      return {
        window_index: parseInt(window_index, 10),
        window_name,
        pane_index: parseInt(pane_index, 10),
        pane_id,
        active: active === "1",
        current_command,
      };
    });

  log.success("list_panes", panes);
  return { success: true, panes };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get information about the tmux socket and environment
 */
export async function get_info(args: {
  socket_path?: string;
}): Promise<{
  success: boolean;
  info?: {
    socket_dir: string;
    socket_path: string;
    server_running: boolean;
    session_count: number;
  };
  error?: string;
}> {
  log.call("get_info", args);
  const { socket_path = DEFAULT_SOCKET } = args;

  ensureSocketDir();

  // Check if server is running
  const result = await runTmux(["list-sessions"], socket_path);
  const serverRunning = result.success || !result.stderr.includes("no server");
  const sessionCount = result.success
    ? result.stdout.split("\n").filter((l) => l.trim()).length
    : 0;

  const info = {
    socket_dir: SOCKET_DIR,
    socket_path,
    server_running: serverRunning,
    session_count: sessionCount,
  };

  log.success("get_info", info);
  return { success: true, info };
}

/**
 * Run a command in a new session and wait for it to complete
 * Useful for running build commands, tests, etc. in parallel
 *
 * @param args.session_name - Name for the session
 * @param args.command - Command to run
 * @param args.completion_pattern - Pattern that indicates command is done (e.g., "\\$" for shell prompt)
 * @param args.timeout_seconds - Timeout in seconds (default: 300 = 5 minutes)
 * @param args.working_dir - Optional working directory
 * @param args.socket_path - Optional custom socket path
 * @param args.visible - If true (default), opens session in a visible terminal window
 */
export async function run_and_wait(args: {
  session_name: string;
  command: string;
  completion_pattern?: string;
  timeout_seconds?: number;
  working_dir?: string;
  socket_path?: string;
  visible?: boolean;
}): Promise<{
  success: boolean;
  output?: string;
  completed?: boolean;
  error?: string;
}> {
  log.call("run_and_wait", args);
  const {
    session_name,
    command,
    completion_pattern = "\\$\\s*$", // Default: shell prompt
    timeout_seconds = 300,
    working_dir,
    socket_path = DEFAULT_SOCKET,
    visible = true,
  } = args;

  // Create the session
  const createResult = await create_session({
    session_name,
    working_dir,
    socket_path,
    visible,
  });

  if (!createResult.success) {
    return { success: false, error: createResult.error };
  }

  sendProgress(`Running command in ${session_name}: ${command.substring(0, 50)}...`);

  // Send the command
  const sendResult = await send_keys({
    session_name,
    keys: command,
    socket_path,
  });

  if (!sendResult.success) {
    return { success: false, error: sendResult.error };
  }

  // Wait for completion
  const waitResult = await wait_for_text({
    session_name,
    pattern: completion_pattern,
    timeout_seconds,
    socket_path,
  });

  return {
    success: waitResult.success,
    output: waitResult.output,
    completed: waitResult.matched,
    error: waitResult.error,
  };
}
