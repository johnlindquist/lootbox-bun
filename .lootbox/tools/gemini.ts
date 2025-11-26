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

// ============================================================================
// PROJECT ANALYSIS & DEEP THINKING TOOLS
// ============================================================================

/**
 * Helper to read multiple files and combine them with labels
 */
async function readFilesWithLabels(
  file_paths: string[]
): Promise<{ content: string; errors: string[] }> {
  const contents: string[] = [];
  const errors: string[] = [];

  for (const filePath of file_paths) {
    try {
      if (!existsSync(filePath)) {
        errors.push(`File not found: ${filePath}`);
        continue;
      }
      const content = readFileSync(filePath, "utf-8");
      contents.push(`=== ${filePath} ===\n${content}`);
      await logInfo(`Read ${content.length} characters from ${filePath}`);
    } catch (error) {
      const err = error as Error;
      errors.push(`Error reading ${filePath}: ${err.message}`);
    }
  }

  return { content: contents.join("\n\n"), errors };
}

/**
 * Deeply analyze project files to understand architecture, patterns, and design decisions.
 * Reads actual files and provides comprehensive analysis using Gemini's large context window.
 *
 * @param args.file_paths - Array of file paths to analyze
 * @param args.question - What to analyze or understand about the code
 * @param args.focus - Optional focus area (architecture, patterns, dependencies, flow, security)
 */
export async function analyze_project(args: {
  file_paths: string[];
  question: string;
  focus?: string;
}): Promise<{ success: boolean; analysis?: string; files_read?: number; error?: string }> {
  logCall("analyze_project", args);
  const { file_paths, question, focus } = args;

  if (!file_paths || file_paths.length === 0) {
    const err = "No file paths provided";
    logError("analyze_project", err);
    return { success: false, error: err };
  }

  const { content, errors } = await readFilesWithLabels(file_paths);

  if (!content) {
    const err = `Could not read any files: ${errors.join(", ")}`;
    logError("analyze_project", err);
    return { success: false, error: err };
  }

  let prompt = `Analyze the following project files and answer this question: ${question}`;
  if (focus) {
    prompt += `\n\nFocus specifically on: ${focus}`;
  }
  if (errors.length > 0) {
    prompt += `\n\nNote: Some files could not be read: ${errors.join(", ")}`;
  }
  prompt += "\n\nProvide a detailed analysis with specific code references where relevant.";

  const result = await runGemini(prompt, { stdin: content });

  if (result.success) {
    logSuccess("analyze_project", result.output);
    return {
      success: true,
      analysis: result.output,
      files_read: file_paths.length - errors.length,
    };
  }
  logError("analyze_project", result.error || "Unknown error");
  return { success: false, error: result.error };
}

/**
 * Evaluate multiple implementation approaches or design decisions.
 * Reads relevant files and provides reasoned recommendations.
 *
 * @param args.problem - The problem or decision to evaluate
 * @param args.options - Array of options to consider
 * @param args.file_paths - Optional file paths for context
 * @param args.criteria - Optional criteria to evaluate against (performance, maintainability, etc.)
 */
export async function evaluate_options(args: {
  problem: string;
  options: string[];
  file_paths?: string[];
  criteria?: string[];
}): Promise<{ success: boolean; evaluation?: string; recommendation?: string; error?: string }> {
  logCall("evaluate_options", args);
  const { problem, options, file_paths, criteria } = args;

  if (!options || options.length < 2) {
    const err = "At least 2 options required for evaluation";
    logError("evaluate_options", err);
    return { success: false, error: err };
  }

  let context = "";
  if (file_paths && file_paths.length > 0) {
    const { content, errors } = await readFilesWithLabels(file_paths);
    if (content) {
      context = `\n\nProject Context (from files):\n${content}`;
    }
    if (errors.length > 0) {
      context += `\n\nNote: Some files could not be read: ${errors.join(", ")}`;
    }
  }

  const optionsText = options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
  let prompt = `Evaluate these options for the following problem:\n\nProblem: ${problem}\n\nOptions:\n${optionsText}`;

  if (criteria && criteria.length > 0) {
    prompt += `\n\nEvaluate against these criteria:\n${criteria.map(c => `- ${c}`).join("\n")}`;
  }

  prompt += context;
  prompt += `\n\nFor each option:
1. List pros and cons
2. Consider how it fits with the existing codebase (if context provided)
3. Identify potential risks or gotchas
4. Rate suitability (1-10)

End with a clear recommendation and reasoning.`;

  const result = await runGemini(prompt);

  if (result.success) {
    logSuccess("evaluate_options", result.output);
    // Try to extract the recommendation (usually at the end)
    const lines = result.output.split("\n");
    const recIdx = lines.findIndex(l =>
      l.toLowerCase().includes("recommend") || l.toLowerCase().includes("conclusion")
    );
    const recommendation = recIdx >= 0 ? lines.slice(recIdx).join("\n") : undefined;

    return {
      success: true,
      evaluation: result.output,
      recommendation,
    };
  }
  logError("evaluate_options", result.error || "Unknown error");
  return { success: false, error: result.error };
}

/**
 * Plan an implementation by analyzing existing code and proposing a detailed approach.
 * Great for feature planning, refactoring, or migration planning.
 *
 * @param args.goal - What you want to achieve
 * @param args.file_paths - Files to analyze for context
 * @param args.constraints - Optional constraints or requirements
 * @param args.style - Planning style: "detailed" for step-by-step, "high-level" for overview
 */
export async function plan_implementation(args: {
  goal: string;
  file_paths: string[];
  constraints?: string[];
  style?: "detailed" | "high-level";
}): Promise<{ success: boolean; plan?: string; steps?: string[]; error?: string }> {
  logCall("plan_implementation", args);
  const { goal, file_paths, constraints, style = "detailed" } = args;

  const { content, errors } = await readFilesWithLabels(file_paths);

  if (!content) {
    const err = `Could not read any files: ${errors.join(", ")}`;
    logError("plan_implementation", err);
    return { success: false, error: err };
  }

  let prompt = `I need to: ${goal}\n\nAnalyze the following codebase and create an implementation plan.`;

  if (constraints && constraints.length > 0) {
    prompt += `\n\nConstraints/Requirements:\n${constraints.map(c => `- ${c}`).join("\n")}`;
  }

  if (style === "detailed") {
    prompt += `\n\nProvide a detailed implementation plan with:
1. Understanding: Key insights from analyzing the existing code
2. Approach: Overall strategy and rationale
3. Steps: Numbered, actionable steps with specific file changes
4. Files to Modify: List each file and what changes are needed
5. New Files: Any new files that need to be created
6. Testing: How to verify the implementation
7. Risks: Potential issues and how to mitigate them`;
  } else {
    prompt += `\n\nProvide a high-level implementation plan with:
1. Key architectural decisions
2. Major components/modules to create or modify
3. Integration points with existing code
4. High-level milestones`;
  }

  if (errors.length > 0) {
    prompt += `\n\nNote: Some files could not be read: ${errors.join(", ")}`;
  }

  const result = await runGemini(prompt, { stdin: content });

  if (result.success) {
    logSuccess("plan_implementation", result.output);

    // Try to extract steps from the output
    const stepMatches = result.output.match(/^\s*\d+\.\s+.+$/gm);
    const steps = stepMatches ? stepMatches.map(s => s.trim()) : undefined;

    return {
      success: true,
      plan: result.output,
      steps,
    };
  }
  logError("plan_implementation", result.error || "Unknown error");
  return { success: false, error: result.error };
}

/**
 * Review code for potential issues, improvements, and best practices.
 * Comprehensive code review using Gemini's understanding.
 *
 * @param args.file_paths - Files to review
 * @param args.focus - Focus areas: "security", "performance", "maintainability", "all"
 * @param args.severity_threshold - Minimum severity to report: "critical", "warning", "info"
 */
export async function review_code(args: {
  file_paths: string[];
  focus?: "security" | "performance" | "maintainability" | "all";
  severity_threshold?: "critical" | "warning" | "info";
}): Promise<{
  success: boolean;
  review?: string;
  issues_found?: number;
  error?: string;
}> {
  logCall("review_code", args);
  const { file_paths, focus = "all", severity_threshold = "warning" } = args;

  const { content, errors } = await readFilesWithLabels(file_paths);

  if (!content) {
    const err = `Could not read any files: ${errors.join(", ")}`;
    logError("review_code", err);
    return { success: false, error: err };
  }

  let focusAreas = "";
  if (focus === "security") {
    focusAreas = "Focus on security vulnerabilities: injection attacks, authentication issues, data exposure, insecure dependencies.";
  } else if (focus === "performance") {
    focusAreas = "Focus on performance issues: inefficient algorithms, memory leaks, unnecessary computations, N+1 queries.";
  } else if (focus === "maintainability") {
    focusAreas = "Focus on maintainability: code clarity, proper abstractions, documentation, testability, coupling.";
  } else {
    focusAreas = "Review for security, performance, maintainability, and best practices.";
  }

  const severityDesc =
    severity_threshold === "critical"
      ? "Only report critical issues that must be fixed."
      : severity_threshold === "warning"
      ? "Report critical and warning-level issues."
      : "Report all issues including minor suggestions.";

  const prompt = `Perform a code review on the following files.

${focusAreas}

${severityDesc}

For each issue found, provide:
1. **Location**: File and line number/function
2. **Severity**: Critical/Warning/Info
3. **Issue**: What's wrong
4. **Impact**: Why it matters
5. **Fix**: How to resolve it

End with a summary of the overall code quality and key recommendations.`;

  const result = await runGemini(prompt, { stdin: content });

  if (result.success) {
    logSuccess("review_code", result.output);

    // Count issues by looking for severity markers
    const criticalCount = (result.output.match(/\*\*Critical\*\*/gi) || []).length;
    const warningCount = (result.output.match(/\*\*Warning\*\*/gi) || []).length;
    const infoCount = (result.output.match(/\*\*Info\*\*/gi) || []).length;
    const issues_found = criticalCount + warningCount + infoCount;

    return {
      success: true,
      review: result.output,
      issues_found,
    };
  }
  logError("review_code", result.error || "Unknown error");
  return { success: false, error: result.error };
}

/**
 * Reason through a complex problem considering the actual project context.
 * Combines deep thinking with real code understanding.
 *
 * @param args.problem - The problem or question to reason through
 * @param args.file_paths - Optional files to consider as context
 * @param args.constraints - Optional constraints or requirements
 * @param args.output_format - Optional format: "reasoning", "decision", "both"
 */
export async function reason_through(args: {
  problem: string;
  file_paths?: string[];
  constraints?: string[];
  output_format?: "reasoning" | "decision" | "both";
}): Promise<{
  success: boolean;
  reasoning?: string;
  decision?: string;
  confidence?: string;
  error?: string;
}> {
  logCall("reason_through", args);
  const { problem, file_paths, constraints, output_format = "both" } = args;

  let context = "";
  if (file_paths && file_paths.length > 0) {
    const { content, errors } = await readFilesWithLabels(file_paths);
    if (content) {
      context = `\n\nRelevant Code Context:\n${content}`;
    }
    if (errors.length > 0) {
      context += `\n\nNote: Some files could not be read: ${errors.join(", ")}`;
    }
  }

  let prompt = `Think through this problem carefully and systematically:\n\n${problem}`;

  if (constraints && constraints.length > 0) {
    prompt += `\n\nConstraints to consider:\n${constraints.map(c => `- ${c}`).join("\n")}`;
  }

  prompt += context;

  prompt += `\n\nApproach this step by step:
1. **Understanding**: Restate the problem in your own words
2. **Key Considerations**: What factors are most important?
3. **Analysis**: Examine each aspect carefully
4. **Trade-offs**: What are the competing concerns?
5. **Reasoning**: Work through the logic step by step
6. **Conclusion**: Provide a clear decision/recommendation
7. **Confidence**: Rate your confidence (high/medium/low) and explain why`;

  const result = await runGemini(prompt);

  if (result.success) {
    logSuccess("reason_through", result.output);

    // Try to extract decision and confidence
    const lines = result.output.split("\n");
    const conclusionIdx = lines.findIndex(
      l => l.toLowerCase().includes("conclusion") || l.toLowerCase().includes("decision")
    );
    const confidenceIdx = lines.findIndex(l => l.toLowerCase().includes("confidence"));

    const decision =
      conclusionIdx >= 0
        ? lines
            .slice(conclusionIdx, confidenceIdx > conclusionIdx ? confidenceIdx : undefined)
            .join("\n")
        : undefined;

    const confidence =
      confidenceIdx >= 0 ? lines.slice(confidenceIdx, confidenceIdx + 2).join("\n") : undefined;

    return {
      success: true,
      reasoning: result.output,
      decision,
      confidence,
    };
  }
  logError("reason_through", result.error || "Unknown error");
  return { success: false, error: result.error };
}

/**
 * Trace data flow or execution flow through the codebase.
 * Useful for understanding how data moves or debugging.
 *
 * @param args.starting_point - Where to start tracing (function, variable, endpoint)
 * @param args.file_paths - Files to analyze
 * @param args.trace_type - Type of trace: "data", "execution", "dependencies"
 * @param args.question - Optional specific question about the flow
 */
export async function trace_flow(args: {
  starting_point: string;
  file_paths: string[];
  trace_type?: "data" | "execution" | "dependencies";
  question?: string;
}): Promise<{ success: boolean; trace?: string; flow_summary?: string; error?: string }> {
  logCall("trace_flow", args);
  const { starting_point, file_paths, trace_type = "execution", question } = args;

  const { content, errors } = await readFilesWithLabels(file_paths);

  if (!content) {
    const err = `Could not read any files: ${errors.join(", ")}`;
    logError("trace_flow", err);
    return { success: false, error: err };
  }

  let traceInstructions = "";
  if (trace_type === "data") {
    traceInstructions = `Trace how data flows through the system starting from "${starting_point}".
Show:
- Where the data originates
- How it's transformed at each step
- What functions/methods it passes through
- Where it's ultimately used or stored`;
  } else if (trace_type === "execution") {
    traceInstructions = `Trace the execution flow starting from "${starting_point}".
Show:
- The entry point and initial state
- Each function/method called in order
- Decision points and branches
- Side effects at each step
- The final outcome`;
  } else {
    traceInstructions = `Trace the dependencies starting from "${starting_point}".
Show:
- What "${starting_point}" depends on directly
- Transitive dependencies
- External dependencies
- Circular dependencies if any`;
  }

  let prompt = traceInstructions;
  if (question) {
    prompt += `\n\nSpecifically, answer this question: ${question}`;
  }
  if (errors.length > 0) {
    prompt += `\n\nNote: Some files could not be read: ${errors.join(", ")}`;
  }
  prompt += "\n\nProvide the trace with specific code references (file:line where possible).";

  const result = await runGemini(prompt, { stdin: content });

  if (result.success) {
    logSuccess("trace_flow", result.output);

    // Extract a brief summary from the first paragraph
    const paragraphs = result.output.split("\n\n");
    const flow_summary = paragraphs[0];

    return {
      success: true,
      trace: result.output,
      flow_summary,
    };
  }
  logError("trace_flow", result.error || "Unknown error");
  return { success: false, error: result.error };
}
