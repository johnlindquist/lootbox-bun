/**
 * DeepWiki Tool - Access documentation and insights about GitHub repositories
 *
 * DeepWiki provides AI-powered documentation understanding for open-source projects.
 * Use this tool when investigating how an open-source project works.
 *
 * Implements direct MCP-over-HTTP communication with the DeepWiki server.
 */

const DEEPWIKI_MCP_URL = "https://mcp.deepwiki.com/mcp";

// Logging utilities - writes to file on disk
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = join(process.env.HOME || "/tmp", ".lootbox-logs");
const LOG_FILE = join(LOG_DIR, "deepwiki.log");

// Helper to append log (creates dir if needed)
const writeLog = async (level: string, message: string) => {
  try {
    // Ensure directory exists
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${message}\n`;
    appendFileSync(LOG_FILE, line);
  } catch (e) {
    // Silent fail if logging fails
  }
};

const logCall = async (fn: string, args: Record<string, unknown>) => {
  await writeLog("CALL", `📞 ${fn}(${JSON.stringify(args)})`);
};
const logSuccess = async (fn: string, result: unknown) => {
  const preview = typeof result === 'string'
    ? result.substring(0, 200) + (result.length > 200 ? '...' : '')
    : JSON.stringify(result).substring(0, 200);
  await writeLog("SUCCESS", `✅ ${fn} → ${preview}`);
};
const logError = async (fn: string, error: string) => {
  await writeLog("ERROR", `❌ ${fn} → ${error}`);
};
const logInfo = async (message: string) => {
  await writeLog("INFO", `ℹ️ ${message}`);
};

// Session cache - we'll reuse sessions for better performance
let cachedSession: { id: string; expiresAt: number } | null = null;

/**
 * Parse SSE response to extract JSON-RPC result
 */
function parseSSEResponse(text: string): { result?: unknown; error?: { message: string } } {
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const data = line.slice(6);
      if (data === "ping") continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.result) {
          return { result: parsed.result };
        }
        if (parsed.error) {
          return { error: { message: parsed.error.message || JSON.stringify(parsed.error) } };
        }
      } catch {
        // Skip malformed JSON
      }
    }
  }
  return { error: { message: "No valid response found in SSE stream" } };
}

/**
 * Initialize MCP session and get session ID
 */
async function initializeSession(): Promise<{ success: boolean; sessionId?: string; error?: string }> {
  try {
    const response = await fetch(DEEPWIKI_MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "lootbox", version: "1.0" },
        },
      }),
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const sessionId = response.headers.get("mcp-session-id");
    if (!sessionId) {
      return { success: false, error: "No session ID in response" };
    }

    const text = await response.text();
    const parsed = parseSSEResponse(text);

    if (parsed.error) {
      return { success: false, error: parsed.error.message };
    }

    return { success: true, sessionId };
  } catch (error) {
    const err = error as Error;
    return { success: false, error: err.message || String(error) };
  }
}

/**
 * Get or create a session
 */
async function getSession(): Promise<{ success: boolean; sessionId?: string; error?: string }> {
  // Check if we have a valid cached session (cache for 5 minutes)
  const now = Date.now();
  if (cachedSession && cachedSession.expiresAt > now) {
    return { success: true, sessionId: cachedSession.id };
  }

  // Initialize new session
  const result = await initializeSession();
  if (result.success && result.sessionId) {
    cachedSession = {
      id: result.sessionId,
      expiresAt: now + 5 * 60 * 1000, // 5 minutes
    };
  }
  return result;
}

/**
 * Call a DeepWiki tool with session management
 */
async function callDeepWikiTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<{ success: boolean; result?: string; error?: string }> {
  logInfo(`Calling DeepWiki MCP tool: ${toolName}`);

  // Get session
  const session = await getSession();
  if (!session.success || !session.sessionId) {
    logError(toolName, session.error || "Failed to get session");
    return { success: false, error: session.error || "Failed to get session" };
  }
  logInfo(`Session acquired: ${session.sessionId.substring(0, 20)}...`);

  try {
    const response = await fetch(DEEPWIKI_MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "mcp-session-id": session.sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: toolName,
          arguments: args,
        },
      }),
    });

    if (!response.ok) {
      // Session might have expired, clear cache and try once more
      if (response.status === 400 || response.status === 401) {
        cachedSession = null;
        return callDeepWikiTool(toolName, args);
      }
      return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const text = await response.text();
    const parsed = parseSSEResponse(text);

    if (parsed.error) {
      return { success: false, error: parsed.error.message };
    }

    // Extract text content from MCP result
    const result = parsed.result as { content?: Array<{ type: string; text: string }> };
    if (result?.content && Array.isArray(result.content)) {
      const textContent = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      return { success: true, result: textContent };
    }

    return { success: true, result: JSON.stringify(result) };
  } catch (error) {
    const err = error as Error;
    return { success: false, error: err.message || String(error) };
  }
}

/**
 * Get the documentation structure/table of contents for a GitHub repository.
 * This is typically the first tool to call to understand what documentation is available.
 *
 * @param args.repo_name - GitHub repository in format 'owner/repo' (e.g., 'anthropics/claude-code')
 */
export async function read_wiki_structure(args: {
  repo_name: string;
}): Promise<{ success: boolean; structure?: string; error?: string }> {
  logCall("read_wiki_structure", args);
  const { repo_name } = args;

  // Validate repo format
  if (!repo_name.includes("/")) {
    const err = `Invalid repo format. Expected 'owner/repo', got '${repo_name}'`;
    logError("read_wiki_structure", err);
    return { success: false, error: err };
  }

  const result = await callDeepWikiTool("read_wiki_structure", {
    repoName: repo_name,
  });

  if (result.success) {
    logSuccess("read_wiki_structure", result.result);
    return { success: true, structure: result.result };
  }
  logError("read_wiki_structure", result.error || "Unknown error");
  return { success: false, error: result.error };
}

/**
 * Get the full documentation content for a GitHub repository.
 * Use after read_wiki_structure to retrieve complete documentation.
 *
 * @param args.repo_name - GitHub repository in format 'owner/repo' (e.g., 'anthropics/claude-code')
 */
export async function read_wiki_contents(args: {
  repo_name: string;
}): Promise<{ success: boolean; contents?: string; error?: string }> {
  logCall("read_wiki_contents", args);
  const { repo_name } = args;

  // Validate repo format
  if (!repo_name.includes("/")) {
    const err = `Invalid repo format. Expected 'owner/repo', got '${repo_name}'`;
    logError("read_wiki_contents", err);
    return { success: false, error: err };
  }

  const result = await callDeepWikiTool("read_wiki_contents", {
    repoName: repo_name,
  });

  if (result.success) {
    logSuccess("read_wiki_contents", result.result);
    return { success: true, contents: result.result };
  }
  logError("read_wiki_contents", result.error || "Unknown error");
  return { success: false, error: result.error };
}

/**
 * Ask any question about a GitHub repository and get an AI-powered answer.
 * This is the most powerful tool - provides semantic understanding of the codebase.
 *
 * @param args.repo_name - GitHub repository in format 'owner/repo' (e.g., 'anthropics/claude-code')
 * @param args.question - The question to ask about the repository
 */
export async function ask_question(args: {
  repo_name: string;
  question: string;
}): Promise<{ success: boolean; answer?: string; error?: string }> {
  logCall("ask_question", args);
  const { repo_name, question } = args;

  // Validate repo format
  if (!repo_name.includes("/")) {
    const err = `Invalid repo format. Expected 'owner/repo', got '${repo_name}'`;
    logError("ask_question", err);
    return { success: false, error: err };
  }

  if (!question || question.trim().length === 0) {
    const err = "Question cannot be empty";
    logError("ask_question", err);
    return { success: false, error: err };
  }

  const result = await callDeepWikiTool("ask_question", {
    repoName: repo_name,
    question: question,
  });

  if (result.success) {
    logSuccess("ask_question", result.result);
    return { success: true, answer: result.result };
  }
  logError("ask_question", result.error || "Unknown error");
  return { success: false, error: result.error };
}
