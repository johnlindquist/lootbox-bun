/**
 * Gemini Research Tool - Leverage Gemini Pro's 1M context window for research and analysis
 *
 * This tool wraps the Gemini CLI to provide research, summarization, and analysis
 * capabilities that benefit from Gemini's massive context window.
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Logging utilities - writes to file on disk
const LOG_DIR = join(process.env.HOME || "/tmp", ".lootbox-logs");
const LOG_FILE = join(LOG_DIR, "gemini.log");

// Helper to append log (creates dir if needed)
const writeLog = async (level: string, message: string) => {
  try {
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
  const preview =
    typeof result === "string"
      ? result.substring(0, 200) + (result.length > 200 ? "..." : "")
      : JSON.stringify(result).substring(0, 200);
  await writeLog("SUCCESS", `✅ ${fn} → ${preview}`);
};
const logError = async (fn: string, error: string) => {
  await writeLog("ERROR", `❌ ${fn} → ${error}`);
};
const logInfo = async (message: string) => {
  await writeLog("INFO", `ℹ️ ${message}`);
};

/**
 * Progress callback type for streaming updates
 */
type ProgressCallback = (message: string) => void;

// Global progress callback - set by the worker when streaming is enabled
let globalProgressCallback: ProgressCallback | null = null;

/**
 * Set the progress callback for streaming updates
 * Called by the worker infrastructure when a streaming call is made
 */
export function setProgressCallback(callback: ProgressCallback | null): void {
  globalProgressCallback = callback;
}

/**
 * Send a progress update if streaming is enabled
 */
function sendProgress(message: string): void {
  if (globalProgressCallback) {
    globalProgressCallback(message);
  }
}

/**
 * Execute a Gemini CLI command and return the result
 * Supports streaming progress updates to prevent timeouts on long operations
 *
 * Gemini CLI usage:
 * - Positional prompt: gemini -m pro "your prompt here"
 * - Stdin + prompt: echo "content" | gemini -m pro "instruction about the content"
 * - Output format: -o text for plain text (default), -o json for JSON
 */
async function runGemini(
  prompt: string,
  options: { stdin?: string; timeout?: number } = {}
): Promise<{ success: boolean; output: string; error?: string }> {
  const { stdin, timeout = 120000 } = options;

  try {
    await logInfo(`Executing Gemini with prompt: ${prompt.substring(0, 100)}...`);
    sendProgress("Starting Gemini request...");

    const startTime = Date.now();

    // Start a progress reporter that sends updates every 5 seconds
    const progressInterval = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      sendProgress(`Gemini processing... (${elapsed}s elapsed)`);
    }, 5000);

    try {
      let result;
      if (stdin) {
        // Pipe content through stdin - gemini will see stdin content + prompt
        // Using raw array form to avoid shell escaping issues
        const proc = Bun.spawn(["gemini", "-m", "pro", "-o", "text", prompt], {
          stdin: new TextEncoder().encode(stdin),
          stdout: "pipe",
          stderr: "pipe",
        });

        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);

        const exitCode = await proc.exited;

        if (exitCode !== 0) {
          return { success: false, output: "", error: stderr || `Exit code ${exitCode}` };
        }

        return { success: true, output: stdout.trim() };
      } else {
        // No stdin, just run with prompt as positional argument
        const proc = Bun.spawn(["gemini", "-m", "pro", "-o", "text", prompt], {
          stdout: "pipe",
          stderr: "pipe",
        });

        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);

        const exitCode = await proc.exited;

        if (exitCode !== 0) {
          return { success: false, output: "", error: stderr || `Exit code ${exitCode}` };
        }

        const elapsed = Math.round((Date.now() - startTime) / 1000);
        sendProgress(`Gemini completed in ${elapsed}s`);
        return { success: true, output: stdout.trim() };
      }
    } finally {
      clearInterval(progressInterval);
    }
  } catch (error) {
    const err = error as { stderr?: { toString(): string }; message?: string };
    const errorMsg = err.stderr?.toString() || err.message || String(error);
    return { success: false, output: "", error: errorMsg };
  }
}

/**
 * Research and analyze a topic using Gemini Pro's massive context window.
 * Great for synthesizing information from multiple sources or analyzing complex topics.
 *
 * @param args.prompt - The research question or analysis request
 * @param args.context - Optional additional context to include
 */
export async function research(args: {
  prompt: string;
  context?: string;
}): Promise<{ success: boolean; result?: string; error?: string }> {
  logCall("research", args);
  const { prompt, context } = args;

  const fullPrompt = context
    ? `${prompt}\n\nContext:\n${context}`
    : prompt;

  const result = await runGemini(fullPrompt);

  if (result.success) {
    logSuccess("research", result.output);
    return { success: true, result: result.output };
  }
  logError("research", result.error || "Unknown error");
  return { success: false, error: result.error };
}

/**
 * Summarize a file or content using Gemini Pro's large context window.
 * Ideal for summarizing large documents, codebases, or lengthy content.
 *
 * @param args.file_path - Path to the file to summarize (optional if content provided)
 * @param args.content - Direct content to summarize (optional if file_path provided)
 * @param args.focus - Optional focus area for the summary
 */
export async function summarize(args: {
  file_path?: string;
  content?: string;
  focus?: string;
}): Promise<{ success: boolean; summary?: string; error?: string }> {
  logCall("summarize", args);
  const { file_path, content, focus } = args;

  let textContent = content || "";

  if (file_path) {
    try {
      if (!existsSync(file_path)) {
        const err = `File not found: ${file_path}`;
        logError("summarize", err);
        return { success: false, error: err };
      }
      textContent = readFileSync(file_path, "utf-8");
      await logInfo(`Read ${textContent.length} characters from ${file_path}`);
    } catch (error) {
      const err = error as Error;
      logError("summarize", err.message);
      return { success: false, error: err.message };
    }
  }

  if (!textContent) {
    const err = "No content provided - specify either file_path or content";
    logError("summarize", err);
    return { success: false, error: err };
  }

  const prompt = focus
    ? `Please summarize the following content, focusing on: ${focus}`
    : "Please provide a comprehensive summary of the following content:";

  const result = await runGemini(prompt, { stdin: textContent });

  if (result.success) {
    logSuccess("summarize", result.output);
    return { success: true, summary: result.output };
  }
  logError("summarize", result.error || "Unknown error");
  return { success: false, error: result.error };
}

/**
 * Analyze code using Gemini Pro's deep understanding and large context.
 * Perfect for code review, architecture analysis, or understanding complex codebases.
 *
 * @param args.file_path - Path to the code file to analyze (optional if code provided)
 * @param args.code - Direct code to analyze (optional if file_path provided)
 * @param args.question - Specific question about the code
 */
export async function analyze_code(args: {
  file_path?: string;
  code?: string;
  question: string;
}): Promise<{ success: boolean; analysis?: string; error?: string }> {
  logCall("analyze_code", args);
  const { file_path, code, question } = args;

  let codeContent = code || "";

  if (file_path) {
    try {
      if (!existsSync(file_path)) {
        const err = `File not found: ${file_path}`;
        logError("analyze_code", err);
        return { success: false, error: err };
      }
      codeContent = readFileSync(file_path, "utf-8");
      await logInfo(`Read ${codeContent.length} characters from ${file_path}`);
    } catch (error) {
      const err = error as Error;
      logError("analyze_code", err.message);
      return { success: false, error: err.message };
    }
  }

  if (!codeContent) {
    const err = "No code provided - specify either file_path or code";
    logError("analyze_code", err);
    return { success: false, error: err };
  }

  const prompt = `Analyze the following code and answer this question: ${question}`;
  const result = await runGemini(prompt, { stdin: codeContent });

  if (result.success) {
    logSuccess("analyze_code", result.output);
    return { success: true, analysis: result.output };
  }
  logError("analyze_code", result.error || "Unknown error");
  return { success: false, error: result.error };
}

/**
 * Compare and analyze multiple pieces of content using Gemini's large context.
 * Great for comparing implementations, approaches, or documentation.
 *
 * @param args.items - Array of content items to compare
 * @param args.comparison_prompt - What to compare/analyze
 */
export async function compare(args: {
  items: Array<{ label: string; content: string }>;
  comparison_prompt: string;
}): Promise<{ success: boolean; comparison?: string; error?: string }> {
  logCall("compare", args);
  const { items, comparison_prompt } = args;

  if (!items || items.length < 2) {
    const err = "At least 2 items required for comparison";
    logError("compare", err);
    return { success: false, error: err };
  }

  const formattedItems = items
    .map((item, i) => `=== ${item.label || `Item ${i + 1}`} ===\n${item.content}`)
    .join("\n\n");

  const prompt = `${comparison_prompt}\n\nItems to compare:\n${formattedItems}`;
  const result = await runGemini(prompt);

  if (result.success) {
    logSuccess("compare", result.output);
    return { success: true, comparison: result.output };
  }
  logError("compare", result.error || "Unknown error");
  return { success: false, error: result.error };
}

/**
 * Think through a complex problem step by step using Gemini Pro.
 * Useful for breaking down complex problems, planning, or reasoning.
 *
 * @param args.problem - The problem or question to think through
 * @param args.constraints - Optional constraints or requirements
 */
export async function think(args: {
  problem: string;
  constraints?: string;
}): Promise<{ success: boolean; reasoning?: string; error?: string }> {
  logCall("think", args);
  const { problem, constraints } = args;

  let prompt = `Think through this problem step by step:\n\n${problem}`;
  if (constraints) {
    prompt += `\n\nConstraints/Requirements:\n${constraints}`;
  }
  prompt += "\n\nProvide your reasoning and conclusion.";

  const result = await runGemini(prompt);

  if (result.success) {
    logSuccess("think", result.output);
    return { success: true, reasoning: result.output };
  }
  logError("think", result.error || "Unknown error");
  return { success: false, error: result.error };
}

/**
 * Extract specific information from content using Gemini's understanding.
 *
 * @param args.content - The content to extract from
 * @param args.extract_what - What to extract (e.g., "all function names", "API endpoints", "dependencies")
 * @param args.output_format - Optional output format (e.g., "json", "list", "table")
 */
export async function extract(args: {
  content: string;
  extract_what: string;
  output_format?: string;
}): Promise<{ success: boolean; extracted?: string; error?: string }> {
  logCall("extract", args);
  const { content, extract_what, output_format } = args;

  let prompt = `Extract ${extract_what} from the following content.`;
  if (output_format) {
    prompt += ` Format the output as ${output_format}.`;
  }

  const result = await runGemini(prompt, { stdin: content });

  if (result.success) {
    logSuccess("extract", result.output);
    return { success: true, extracted: result.output };
  }
  logError("extract", result.error || "Unknown error");
  return { success: false, error: result.error };
}

/**
 * Ask a direct question to Gemini Pro.
 * Simple interface for quick queries.
 *
 * @param args.question - The question to ask
 */
export async function ask(args: {
  question: string;
}): Promise<{ success: boolean; answer?: string; error?: string }> {
  logCall("ask", args);
  const { question } = args;

  const result = await runGemini(question);

  if (result.success) {
    logSuccess("ask", result.output);
    return { success: true, answer: result.output };
  }
  logError("ask", result.error || "Unknown error");
  return { success: false, error: result.error };
}

/**
 * Search the web using Gemini Pro's integrated search capabilities.
 * Gemini has access to current information and can search for up-to-date content.
 * This is the PREFERRED method for web searches as Gemini excels at this.
 *
 * @param args.query - The search query or question about current information
 * @param args.focus - Optional focus area (e.g., "news", "technical", "products", "reviews")
 */
export async function web_search(args: {
  query: string;
  focus?: string;
}): Promise<{ success: boolean; results?: string; error?: string }> {
  logCall("web_search", args);
  const { query, focus } = args;

  let prompt = `Search the web and provide comprehensive, up-to-date information about: ${query}`;
  if (focus) {
    prompt += `\n\nFocus on: ${focus}`;
  }
  prompt += "\n\nInclude sources and dates where relevant. Provide accurate, current information.";

  const result = await runGemini(prompt);

  if (result.success) {
    logSuccess("web_search", result.output);
    return { success: true, results: result.output };
  }
  logError("web_search", result.error || "Unknown error");
  return { success: false, error: result.error };
}

/**
 * Get the latest news on a topic using Gemini's search capabilities.
 * Optimized for finding recent news and developments.
 *
 * @param args.topic - The topic to get news about
 * @param args.timeframe - Optional timeframe (e.g., "today", "this week", "this month")
 */
export async function get_news(args: {
  topic: string;
  timeframe?: string;
}): Promise<{ success: boolean; news?: string; error?: string }> {
  logCall("get_news", args);
  const { topic, timeframe } = args;

  let prompt = `What is the latest news about: ${topic}`;
  if (timeframe) {
    prompt += ` from ${timeframe}`;
  }
  prompt += "\n\nProvide a summary of the most important recent developments, including dates and sources where available.";

  const result = await runGemini(prompt);

  if (result.success) {
    logSuccess("get_news", result.output);
    return { success: true, news: result.output };
  }
  logError("get_news", result.error || "Unknown error");
  return { success: false, error: result.error };
}

/**
 * Look up current information about a topic using Gemini's search.
 * Use this for factual queries that need up-to-date information.
 *
 * @param args.query - What to look up
 */
export async function lookup(args: {
  query: string;
}): Promise<{ success: boolean; info?: string; error?: string }> {
  logCall("lookup", args);
  const { query } = args;

  const prompt = `Look up and provide accurate, current information about: ${query}\n\nInclude relevant facts, figures, and sources.`;

  const result = await runGemini(prompt);

  if (result.success) {
    logSuccess("lookup", result.output);
    return { success: true, info: result.output };
  }
  logError("lookup", result.error || "Unknown error");
  return { success: false, error: result.error };
}
