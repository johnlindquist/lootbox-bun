/**
 * Council Tool - Ask multiple AI agents the same question in parallel
 *
 * Queries Claude (Opus 4.5), Codex (GPT-5.1-Codex-Max), and Gemini (2.5 Pro)
 * simultaneously and returns all their responses for comparison.
 *
 * Use this for:
 * - Getting diverse perspectives on complex problems
 * - Comparing reasoning approaches across models
 * - Validating answers by consensus
 * - Exploring different solution strategies
 */

import { createLogger, extractErrorMessage, type ProgressCallback } from "./shared/index.ts";

const log = createLogger("council");

// Global progress callback for streaming updates
let globalProgressCallback: ProgressCallback | null = null;

export function setProgressCallback(callback: ProgressCallback | null): void {
  globalProgressCallback = callback;
}

function sendProgress(message: string): void {
  if (globalProgressCallback) {
    globalProgressCallback(message);
  }
}

// Agent configuration with their smartest models
const AGENTS = {
  claude: {
    name: "Claude (Opus ultrathink)",
    command: "claude",
    // Use opus model with ultrathink for maximum reasoning
    args: ["-p", "--model", "opus", "--append-system-prompt", "ultrathink"],
    description: "Anthropic's most capable model with extended thinking enabled",
  },
  codex: {
    name: "Codex (GPT-5.1-Codex-Max)",
    command: "codex",
    // Use exec mode for non-interactive, with xhigh reasoning
    args: ["exec", "-m", "gpt-5.1-codex-max", "-c", 'model_reasoning_effort="xhigh"'],
    description: "OpenAI's top coding model with maximum reasoning effort",
  },
  gemini: {
    name: "Gemini (Pro)",
    command: "gemini",
    // Use pro model with text output
    args: ["-m", "pro", "-o", "text"],
    description: "Google's strongest reasoning model with 1M context window",
  },
} as const;

type AgentName = keyof typeof AGENTS;

interface AgentResponse {
  agent: string;
  model: string;
  success: boolean;
  response?: string;
  error?: string;
  duration_ms: number;
}

interface CouncilResult {
  success: boolean;
  question: string;
  responses: AgentResponse[];
  total_duration_ms: number;
  summary?: string;
  error?: string;
}

/**
 * Run a single agent query with streaming progress
 */
async function queryAgent(
  agentKey: AgentName,
  question: string,
  timeout: number
): Promise<AgentResponse> {
  const agent = AGENTS[agentKey];
  const startTime = Date.now();

  log.info(`Querying ${agent.name}...`);
  sendProgress(`[${agent.name}] Starting query...`);

  try {
    // Build the command
    const args = [...agent.args, question];

    log.debug(`Running: ${agent.command} ${args.join(" ")}`);

    const proc = Bun.spawn([agent.command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // Ensure non-interactive mode
        CI: "true",
        TERM: "dumb",
      },
    });

    // Stream stdout and collect response while sending progress
    let response = "";
    let charCount = 0;
    const progressInterval = 5000; // Send progress every 5 seconds

    // Read stdout in chunks for streaming progress
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();

    // Set up timeout that we can cancel
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;

    const resetTimeout = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeout);
    };

    resetTimeout();

    // Progress reporter that runs periodically
    const progressReporter = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const preview = response.length > 100
        ? `...${response.slice(-100).replace(/\n/g, " ")}`
        : response.replace(/\n/g, " ");
      sendProgress(`[${agent.name}] ${elapsed}s elapsed, ${charCount} chars received${preview ? `: "${preview.slice(0, 50)}..."` : ""}`);
    }, progressInterval);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        response += chunk;
        charCount += chunk.length;

        // Reset timeout on each chunk received
        resetTimeout();

        // Send immediate progress on first chunk
        if (charCount === chunk.length) {
          sendProgress(`[${agent.name}] Receiving response...`);
        }
      }
    } finally {
      clearInterval(progressReporter);
      if (timeoutId) clearTimeout(timeoutId);
    }

    if (timedOut) {
      throw new Error(`Timeout after ${timeout / 1000}s`);
    }

    // Also capture stderr
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const duration_ms = Date.now() - startTime;

    if (exitCode !== 0) {
      const errorMsg = stderr || `Exit code ${exitCode}`;
      log.error(agent.name, errorMsg);
      return {
        agent: agent.name,
        model: agentKey,
        success: false,
        error: errorMsg,
        duration_ms,
      };
    }

    const trimmedResponse = response.trim();
    log.success(agent.name, trimmedResponse.substring(0, 200));
    sendProgress(`[${agent.name}] Completed in ${(duration_ms / 1000).toFixed(1)}s (${charCount} chars)`);

    return {
      agent: agent.name,
      model: agentKey,
      success: true,
      response: trimmedResponse,
      duration_ms,
    };
  } catch (error) {
    const duration_ms = Date.now() - startTime;
    const errorMsg = extractErrorMessage(error);
    log.error(agent.name, errorMsg);
    sendProgress(`[${agent.name}] Error: ${errorMsg}`);

    return {
      agent: agent.name,
      model: agentKey,
      success: false,
      error: errorMsg,
      duration_ms,
    };
  }
}

/**
 * Ask all council members the same question in parallel
 *
 * @param args.question - The question to ask all agents
 * @param args.agents - Optional list of agents to query (defaults to all: claude, codex, gemini)
 * @param args.timeout_seconds - Timeout per agent in seconds (default: 120)
 * @param args.include_summary - If true, includes a comparison summary at the end
 */
export async function ask(args: {
  question: string;
  agents?: AgentName[];
  timeout_seconds?: number;
  include_summary?: boolean;
}): Promise<CouncilResult> {
  log.call("ask", args);
  const {
    question,
    agents = ["claude", "codex", "gemini"],
    timeout_seconds = 120,
    include_summary = false,
  } = args;

  if (!question || question.trim().length === 0) {
    const err = "Question is required";
    log.error("ask", err);
    return { success: false, question: "", responses: [], total_duration_ms: 0, error: err };
  }

  const startTime = Date.now();
  const timeout = timeout_seconds * 1000;

  sendProgress(`Consulting council (${agents.join(", ")})...`);

  // Query all agents in parallel
  const responsePromises = agents.map((agentKey) => {
    if (!(agentKey in AGENTS)) {
      return Promise.resolve({
        agent: agentKey,
        model: agentKey,
        success: false,
        error: `Unknown agent: ${agentKey}. Available: ${Object.keys(AGENTS).join(", ")}`,
        duration_ms: 0,
      });
    }
    return queryAgent(agentKey, question, timeout);
  });

  const responses = await Promise.all(responsePromises);
  const total_duration_ms = Date.now() - startTime;

  // Check if any succeeded
  const successCount = responses.filter((r) => r.success).length;

  if (successCount === 0) {
    log.error("ask", "All agents failed to respond");
    return {
      success: false,
      question,
      responses,
      total_duration_ms,
      error: "All agents failed to respond",
    };
  }

  // Generate summary if requested
  let summary: string | undefined;
  if (include_summary && successCount > 1) {
    const summaryParts = [
      `Council of ${responses.length} agents consulted.`,
      `${successCount} responded successfully.`,
    ];

    // Simple comparison notes
    const successfulResponses = responses.filter((r) => r.success);
    const avgLength =
      successfulResponses.reduce((acc, r) => acc + (r.response?.length || 0), 0) /
      successfulResponses.length;

    summaryParts.push(`Average response length: ${Math.round(avgLength)} characters.`);
    summaryParts.push(
      `Fastest: ${responses.reduce((a, b) => (a.duration_ms < b.duration_ms ? a : b)).agent}`
    );

    summary = summaryParts.join(" ");
  }

  log.success("ask", { successCount, total_duration_ms });
  sendProgress(`Council complete: ${successCount}/${responses.length} responded`);

  return {
    success: true,
    question,
    responses,
    total_duration_ms,
    summary,
  };
}

/**
 * Ask the council a question and get a formatted comparison
 *
 * @param args.question - The question to ask all agents
 * @param args.agents - Optional list of agents to query
 * @param args.timeout_seconds - Timeout per agent in seconds (default: 120)
 */
export async function compare(args: {
  question: string;
  agents?: AgentName[];
  timeout_seconds?: number;
}): Promise<{
  success: boolean;
  comparison?: string;
  error?: string;
}> {
  log.call("compare", args);

  const result = await ask({
    ...args,
    include_summary: true,
  });

  if (!result.success) {
    return { success: false, error: result.error };
  }

  // Format a nice comparison
  const sections: string[] = [
    `# Council Responses\n`,
    `**Question:** ${result.question}\n`,
    `---\n`,
  ];

  for (const response of result.responses) {
    sections.push(`## ${response.agent}`);
    sections.push(`*Duration: ${(response.duration_ms / 1000).toFixed(1)}s*\n`);

    if (response.success) {
      sections.push(response.response || "(empty response)");
    } else {
      sections.push(`**Error:** ${response.error}`);
    }

    sections.push("\n---\n");
  }

  if (result.summary) {
    sections.push(`## Summary\n${result.summary}`);
  }

  sections.push(
    `\n*Total time: ${(result.total_duration_ms / 1000).toFixed(1)}s*`
  );

  const comparison = sections.join("\n");
  log.success("compare", comparison.substring(0, 200));

  return { success: true, comparison };
}

/**
 * Get information about available council agents
 */
export async function list_agents(): Promise<{
  success: boolean;
  agents: Array<{
    key: string;
    name: string;
    description: string;
    command: string;
  }>;
}> {
  log.call("list_agents", {});

  const agents = Object.entries(AGENTS).map(([key, agent]) => ({
    key,
    name: agent.name,
    description: agent.description,
    command: agent.command,
  }));

  log.success("list_agents", agents);
  return { success: true, agents };
}

/**
 * Quick query - ask a single agent (useful for testing)
 *
 * @param args.agent - Which agent to query (claude, codex, or gemini)
 * @param args.question - The question to ask
 * @param args.timeout_seconds - Timeout in seconds (default: 120)
 */
export async function query_single(args: {
  agent: AgentName;
  question: string;
  timeout_seconds?: number;
}): Promise<AgentResponse & { success: boolean; error?: string }> {
  log.call("query_single", args);
  const { agent, question, timeout_seconds = 120 } = args;

  if (!(agent in AGENTS)) {
    const err = `Unknown agent: ${agent}. Available: ${Object.keys(AGENTS).join(", ")}`;
    log.error("query_single", err);
    return {
      agent: agent,
      model: agent,
      success: false,
      error: err,
      duration_ms: 0,
    };
  }

  const response = await queryAgent(agent, question, timeout_seconds * 1000);
  return response;
}
