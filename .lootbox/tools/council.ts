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
 * - Debate mode: agents critique each other's answers
 * - Consensus detection: identify agreements vs disagreements
 * - Devil's advocate: force critical analysis
 * - Role-based queries: specialized personas per agent
 */

import { createLogger, extractErrorMessage, type ProgressCallback, getCodeMapContext, spawnWithTimeout } from "./shared/index.ts";
import { saveToolResponse } from "./shared/response_history.ts";

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
// All agents use streaming output to provide continuous progress updates
const AGENTS = {
  claude: {
    name: "Claude (Opus ultrathink)",
    command: "claude",
    // Use opus model with ultrathink, stream-json for continuous output
    // Note: --verbose is required when using -p with --output-format stream-json
    args: ["-p", "--verbose", "--model", "opus", "--append-system-prompt", "ultrathink", "--output-format", "stream-json"],
    description: "Anthropic's most capable model with extended thinking enabled",
    parseOutput: "stream-json", // Parse stream-json format
  },
  codex: {
    name: "Codex (GPT-5.1-Codex-Max)",
    command: "codex",
    // Use exec mode with --json for JSONL streaming output
    args: ["exec", "-m", "gpt-5.1-codex-max", "-c", 'model_reasoning_effort="xhigh"', "--json"],
    description: "OpenAI's top coding model with maximum reasoning effort",
    parseOutput: "jsonl", // Parse JSONL format
  },
  gemini: {
    name: "Gemini (Pro)",
    command: "gemini",
    // Use pro model with stream-json for continuous output
    args: ["-m", "pro", "-o", "stream-json"],
    description: "Google's strongest reasoning model with 1M context window",
    parseOutput: "stream-json", // Parse stream-json format
  },
} as const;

type AgentName = keyof typeof AGENTS;
type ParseOutputType = typeof AGENTS[AgentName]["parseOutput"];

// Predefined role configurations for specialized perspectives
const ROLE_PRESETS = {
  // Software development roles
  software: {
    claude: "You are a senior software architect. Focus on system design, scalability, maintainability, and best practices.",
    codex: "You are a senior implementation engineer. Focus on code quality, performance optimization, and practical implementation details.",
    gemini: "You are a QA engineer and security specialist. Focus on edge cases, potential bugs, security vulnerabilities, and testing strategies.",
  },
  // Security audit roles
  security: {
    claude: "You are a security architect. Analyze for architectural security flaws, threat modeling, and defense in depth.",
    codex: "You are a penetration tester. Look for exploitable vulnerabilities, injection points, and attack vectors in the code.",
    gemini: "You are a compliance auditor. Check for OWASP top 10, data protection issues, and security best practices.",
  },
  // Code review roles
  review: {
    claude: "You are Martin Fowler. Focus on refactoring opportunities, design patterns, and code clarity.",
    codex: "You are a performance engineer. Look for inefficiencies, memory issues, and optimization opportunities.",
    gemini: "You are a junior developer reviewing for readability. Point out confusing code, missing docs, and unclear naming.",
  },
  // Creative/brainstorming roles
  creative: {
    claude: "You are a creative writer. Focus on clarity, narrative flow, and engaging communication.",
    codex: "You are an editor. Focus on structure, conciseness, and eliminating redundancy.",
    gemini: "You are a fact-checker. Verify claims, check for logical consistency, and identify gaps.",
  },
  // Architecture decision roles
  architecture: {
    claude: "You are a distributed systems expert. Focus on scalability, fault tolerance, and system boundaries.",
    codex: "You are a data modeling expert. Focus on data flow, storage patterns, and API design.",
    gemini: "You are a DevOps engineer. Focus on deployment, monitoring, operational complexity, and cost.",
  },
} as const;

type RolePreset = keyof typeof ROLE_PRESETS;

/**
 * Parse streaming JSON output from Claude CLI (stream-json format)
 * Each line is a JSON object with type and content
 */
function parseClaudeStreamJson(rawOutput: string): string {
  const lines = rawOutput.split("\n").filter((line) => line.trim());
  const textParts: string[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      // Claude stream-json has different message types
      if (obj.type === "assistant" && obj.message?.content) {
        for (const block of obj.message.content) {
          if (block.type === "text") {
            textParts.push(block.text);
          }
        }
      } else if (obj.type === "content_block_delta" && obj.delta?.text) {
        textParts.push(obj.delta.text);
      } else if (obj.type === "result" && obj.result) {
        // Final result message
        textParts.push(obj.result);
      }
    } catch {
      // Not JSON, might be plain text fallback
      if (line.trim() && !line.startsWith("{")) {
        textParts.push(line);
      }
    }
  }

  return textParts.join("") || rawOutput;
}

/**
 * Parse JSONL output from Codex CLI
 * Each line is a JSON event object
 */
function parseCodexJsonl(rawOutput: string): string {
  const lines = rawOutput.split("\n").filter((line) => line.trim());
  const textParts: string[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      // Codex JSONL has events with different types
      if (obj.type === "message" && obj.content) {
        textParts.push(obj.content);
      } else if (obj.type === "agent_message" && obj.message) {
        textParts.push(obj.message);
      } else if (obj.message) {
        textParts.push(obj.message);
      } else if (obj.content) {
        textParts.push(obj.content);
      } else if (obj.text) {
        textParts.push(obj.text);
      }
    } catch {
      // Not JSON, might be plain text
      if (line.trim() && !line.startsWith("{")) {
        textParts.push(line);
      }
    }
  }

  return textParts.join("\n") || rawOutput;
}

/**
 * Parse streaming JSON output from Gemini CLI
 */
function parseGeminiStreamJson(rawOutput: string): string {
  const lines = rawOutput.split("\n").filter((line) => line.trim());
  const textParts: string[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      // Gemini stream-json format
      if (obj.text) {
        textParts.push(obj.text);
      } else if (obj.content) {
        textParts.push(obj.content);
      } else if (obj.message) {
        textParts.push(obj.message);
      } else if (obj.type === "text" && obj.data) {
        textParts.push(obj.data);
      }
    } catch {
      // Not JSON, might be plain text
      if (line.trim() && !line.startsWith("{")) {
        textParts.push(line);
      }
    }
  }

  return textParts.join("") || rawOutput;
}

/**
 * Parse output based on agent's output format
 */
function parseAgentOutput(rawOutput: string, parseType: ParseOutputType): string {
  switch (parseType) {
    case "stream-json": {
      // Try Claude format first, then Gemini
      const claudeParsed = parseClaudeStreamJson(rawOutput);
      if (claudeParsed !== rawOutput) return claudeParsed;
      return parseGeminiStreamJson(rawOutput);
    }
    case "jsonl":
      return parseCodexJsonl(rawOutput);
    default:
      return rawOutput;
  }
}

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
 * Uses spawnWithTimeout for proper timeout handling and process cleanup
 */
async function queryAgent(
  agentKey: AgentName,
  question: string,
  timeout: number,
  role?: string
): Promise<AgentResponse> {
  const agent = AGENTS[agentKey];

  log.info(`Querying ${agent.name}...`);
  sendProgress(`[${agent.name}] Starting query...`);

  // Build the command with optional role
  let args = [...agent.args];
  let modifiedQuestion = question;

  // Add role/system prompt if provided
  if (role) {
    if (agentKey === "claude") {
      // Claude uses --append-system-prompt for additional system context
      args = args.filter(a => a !== "ultrathink"); // Remove default
      args.push("--append-system-prompt", `${role}\n\nThink deeply and carefully.`);
    } else if (agentKey === "codex") {
      // Codex: prepend role to the question
      modifiedQuestion = `[System: ${role}]\n\n${question}`;
    } else if (agentKey === "gemini") {
      // Gemini: prepend role to the question
      modifiedQuestion = `[System: ${role}]\n\n${question}`;
    }
  }

  args.push(modifiedQuestion);

  log.debug(`Running: ${agent.command} ${args.join(" ").substring(0, 100)}...`);

  // Use spawnWithTimeout for proper timeout handling and process cleanup
  const result = await spawnWithTimeout({
    command: agent.command,
    args,
    timeoutMs: timeout,
    env: { CI: "true", TERM: "dumb" },
    onProgress: (chars, elapsedMs) => {
      const elapsed = Math.round(elapsedMs / 1000);
      sendProgress(`[${agent.name}] Thinking... (${elapsed}s, ${chars} chars)`);
    },
    progressIntervalMs: 3000,
  });

  if (result.timedOut) {
    log.error(agent.name, `Timeout after ${timeout / 1000}s`);
    return {
      agent: agent.name,
      model: agentKey,
      success: false,
      error: `Agent timed out after ${timeout / 1000}s (process was killed)`,
      duration_ms: result.durationMs,
    };
  }

  if (!result.success) {
    const errorMsg = result.error || result.stderr || `Exit code ${result.exitCode}`;
    log.error(agent.name, errorMsg);
    return {
      agent: agent.name,
      model: agentKey,
      success: false,
      error: errorMsg,
      duration_ms: result.durationMs,
    };
  }

  // Parse the streaming output to extract the actual text content
  const parsedResponse = parseAgentOutput(result.stdout.trim(), agent.parseOutput);
  log.success(agent.name, parsedResponse.substring(0, 200));
  sendProgress(`[${agent.name}] Completed in ${(result.durationMs / 1000).toFixed(1)}s`);

  return {
    agent: agent.name,
    model: agentKey,
    success: true,
    response: parsedResponse,
    duration_ms: result.durationMs,
  };
}

/**
 * Ask all council members the same question in parallel
 *
 * @param args.question - The question to ask all agents
 * @param args.agents - Optional list of agents to query (defaults to all: claude, codex, gemini)
 * @param args.timeout_seconds - Timeout per agent in seconds (default: 120)
 * @param args.include_summary - If true, includes a comparison summary at the end
 * @param args.role_preset - Use a predefined role configuration (software, security, review, creative, architecture)
 * @param args.roles - Custom roles per agent: { claude: "...", codex: "...", gemini: "..." }
 */
export async function ask(args: {
  question: string;
  agents?: AgentName[];
  timeout_seconds?: number;
  include_summary?: boolean;
  role_preset?: RolePreset;
  roles?: Partial<Record<AgentName, string>>;
  /** Include codebase structure context (default: true) */
  include_codemap?: boolean;
}): Promise<CouncilResult> {
  log.call("ask", args);
  const {
    question,
    agents = ["claude", "codex", "gemini"],
    timeout_seconds = 120,
    include_summary = false,
    role_preset,
    roles,
    include_codemap = true,
  } = args;

  // Resolve roles: custom roles override preset
  const resolvedRoles: Partial<Record<AgentName, string>> = role_preset
    ? { ...ROLE_PRESETS[role_preset] }
    : {};
  if (roles) {
    Object.assign(resolvedRoles, roles);
  }

  if (!question || question.trim().length === 0) {
    const err = "Question is required";
    log.error("ask", err);
    return { success: false, question: "", responses: [], total_duration_ms: 0, error: err };
  }

  const startTime = Date.now();
  const timeout = timeout_seconds * 1000;

  // Get code map context for codebase awareness (if enabled)
  let codebaseSection = "";
  if (include_codemap) {
    sendProgress("Loading codebase structure...");
    const codeMapContext = await getCodeMapContext();
    if (codeMapContext) {
      codebaseSection = `\n\n<codebase-structure>\n${codeMapContext}\n</codebase-structure>`;
      log.info(`Loaded code map context (${codeMapContext.length} chars)`);
    } else {
      log.info("No code map available (not a git repo or generation failed)");
    }
  }

  // Augment question with codebase context
  const augmentedQuestion = codebaseSection
    ? `${question}${codebaseSection}`
    : question;

  sendProgress(`Consulting council (${agents.join(", ")})...`);

  // Query all agents in parallel
  const responsePromises = agents.map((agentKey) => {
    if (!(agentKey in AGENTS)) {
      return Promise.resolve<AgentResponse>({
        agent: agentKey,
        model: agentKey,
        success: false,
        error: `Unknown agent: ${agentKey}. Available: ${Object.keys(AGENTS).join(", ")}`,
        duration_ms: 0,
      });
    }
    const role = resolvedRoles[agentKey];
    return queryAgent(agentKey, augmentedQuestion, timeout, role);
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

  const resultObj = {
    success: true,
    question,
    responses,
    total_duration_ms,
    summary,
  };

  // Build markdown content for history
  const historyContent = responses.map(r =>
    `## ${r.agent}\n\n${r.success ? r.response : `**Error:** ${r.error}`}\n\n*Duration: ${(r.duration_ms / 1000).toFixed(1)}s*`
  ).join("\n\n---\n\n");

  try {
    await saveToolResponse({
      tool: "council",
      topic: question.substring(0, 100),
      content: historyContent,
      query: question,
      tags: ["council", ...(role_preset ? [role_preset] : [])],
      duration_ms: total_duration_ms,
      agents: responses.filter(r => r.success).map(r => r.agent),
    });
  } catch (e) {
    log.warn("Failed to save response to history", e);
  }

  return resultObj;
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

// =============================================================================
// NEW COUNCIL FEATURES
// =============================================================================

interface ConsensusResult {
  success: boolean;
  question: string;
  consensus: string[]; // Points all agents agree on
  disputed: string[]; // Points where agents disagree
  unique_insights: Record<string, string[]>; // Unique points per agent
  confidence: "high" | "medium" | "low"; // Based on agreement level
  total_duration_ms: number;
  error?: string;
}

interface DebateResult {
  success: boolean;
  question: string;
  rounds: Array<{
    round: number;
    type: "initial" | "critique" | "rebuttal";
    responses: AgentResponse[];
  }>;
  final_synthesis?: string;
  total_duration_ms: number;
  error?: string;
}

/**
 * Debate mode - agents critique each other's answers in multiple rounds
 *
 * Round 1: Initial answers from all agents
 * Round 2: Each agent critiques the other agents' answers
 * Round 3: Final synthesis with refined positions
 *
 * @param args.question - The question to debate
 * @param args.agents - Which agents to include (default: all)
 * @param args.rounds - Number of debate rounds (default: 2, max: 3)
 * @param args.timeout_seconds - Timeout per query (default: 120)
 */
export async function debate(args: {
  question: string;
  agents?: AgentName[];
  rounds?: number;
  timeout_seconds?: number;
}): Promise<DebateResult> {
  log.call("debate", args);
  const {
    question,
    agents = ["claude", "codex", "gemini"],
    rounds = 2,
    timeout_seconds = 120,
  } = args;

  if (!question || question.trim().length === 0) {
    return { success: false, question: "", rounds: [], total_duration_ms: 0, error: "Question is required" };
  }

  const startTime = Date.now();
  const timeout = timeout_seconds * 1000;
  const debateRounds: DebateResult["rounds"] = [];

  sendProgress(`Starting debate with ${agents.length} agents, ${rounds} rounds...`);

  // Round 1: Initial answers
  sendProgress("[Round 1] Getting initial positions...");
  const initialResponses = await Promise.all(
    agents.map((a) => queryAgent(a, question, timeout))
  );
  debateRounds.push({ round: 1, type: "initial", responses: initialResponses });

  if (rounds < 2) {
    return {
      success: true,
      question,
      rounds: debateRounds,
      total_duration_ms: Date.now() - startTime,
    };
  }

  // Round 2: Critique phase
  sendProgress("[Round 2] Agents critiquing each other's answers...");
  const successfulInitial = initialResponses.filter((r) => r.success);

  if (successfulInitial.length < 2) {
    return {
      success: true,
      question,
      rounds: debateRounds,
      total_duration_ms: Date.now() - startTime,
      error: "Not enough successful responses for critique round",
    };
  }

  // Format other agents' responses for critique
  const formatOtherResponses = (currentAgent: string) => {
    return successfulInitial
      .filter((r) => r.agent !== currentAgent)
      .map((r) => `### ${r.agent}'s answer:\n${r.response}`)
      .join("\n\n");
  };

  const critiquePromises = agents.map((agentKey) => {
    const otherResponses = formatOtherResponses(AGENTS[agentKey].name);
    const critiquePrompt = `Original question: ${question}

Here are the other council members' answers:

${otherResponses}

Please provide a thoughtful critique of these answers:
1. What do you agree with?
2. What do you disagree with and why?
3. What important points did they miss?
4. What's your refined position considering their perspectives?`;

    return queryAgent(agentKey, critiquePrompt, timeout);
  });

  const critiqueResponses = await Promise.all(critiquePromises);
  debateRounds.push({ round: 2, type: "critique", responses: critiqueResponses });

  // Round 3 (optional): Final synthesis/rebuttal
  if (rounds >= 3) {
    sendProgress("[Round 3] Final synthesis...");

    const synthesisPrompt = `After this debate on "${question}", provide your final, refined answer that:
1. Incorporates the strongest points from all perspectives
2. Addresses the main disagreements
3. Presents a clear, well-reasoned conclusion

Previous critiques:
${critiqueResponses.filter((r) => r.success).map((r) => `${r.agent}: ${r.response?.substring(0, 500)}...`).join("\n\n")}`;

    const synthesisResponses = await Promise.all(
      agents.map((a) => queryAgent(a, synthesisPrompt, timeout))
    );
    debateRounds.push({ round: 3, type: "rebuttal", responses: synthesisResponses });
  }

  // Generate final synthesis by identifying common ground
  const allSuccessful = debateRounds.flatMap((r) => r.responses).filter((r) => r.success);
  const final_synthesis = allSuccessful.length > 0
    ? `Debate completed with ${debateRounds.length} rounds. ${allSuccessful.length} successful responses gathered.`
    : undefined;

  log.success("debate", { rounds: debateRounds.length });

  return {
    success: true,
    question,
    rounds: debateRounds,
    final_synthesis,
    total_duration_ms: Date.now() - startTime,
  };
}

/**
 * Consensus detection - analyze responses to identify agreements and disagreements
 *
 * @param args.question - The question to analyze
 * @param args.agents - Which agents to query (default: all)
 * @param args.timeout_seconds - Timeout per query (default: 120)
 */
export async function consensus(args: {
  question: string;
  agents?: AgentName[];
  timeout_seconds?: number;
}): Promise<ConsensusResult> {
  log.call("consensus", args);
  const {
    question,
    agents = ["claude", "codex", "gemini"],
    timeout_seconds = 120,
  } = args;

  if (!question || question.trim().length === 0) {
    return {
      success: false,
      question: "",
      consensus: [],
      disputed: [],
      unique_insights: {},
      confidence: "low",
      total_duration_ms: 0,
      error: "Question is required",
    };
  }

  const startTime = Date.now();

  // First, get all responses
  sendProgress("Gathering responses for consensus analysis...");
  const result = await ask({ question, agents, timeout_seconds, include_summary: false });

  if (!result.success) {
    return {
      success: false,
      question,
      consensus: [],
      disputed: [],
      unique_insights: {},
      confidence: "low",
      total_duration_ms: Date.now() - startTime,
      error: result.error,
    };
  }

  const successfulResponses = result.responses.filter((r) => r.success);
  if (successfulResponses.length < 2) {
    return {
      success: false,
      question,
      consensus: [],
      disputed: [],
      unique_insights: {},
      confidence: "low",
      total_duration_ms: Date.now() - startTime,
      error: "Need at least 2 successful responses for consensus analysis",
    };
  }

  // Use one of the agents to analyze consensus
  sendProgress("Analyzing responses for consensus...");

  const analysisPrompt = `Analyze these ${successfulResponses.length} AI responses to the question: "${question}"

${successfulResponses.map((r) => `### ${r.agent}:\n${r.response}`).join("\n\n---\n\n")}

Provide a structured analysis in EXACTLY this format (use these exact headers):

## CONSENSUS (points all agents agree on)
- [List each agreed point as a bullet]

## DISPUTED (points where agents disagree)
- [List each disagreement as a bullet, noting which agents disagree]

## UNIQUE INSIGHTS
### ${successfulResponses[0].agent}
- [Unique points from this agent]
### ${successfulResponses[1].agent}
- [Unique points from this agent]
${successfulResponses[2] ? `### ${successfulResponses[2].agent}\n- [Unique points from this agent]` : ""}

## CONFIDENCE
[State: HIGH if strong agreement, MEDIUM if partial agreement, LOW if mostly disagreement]`;

  const analysisResponse = await queryAgent("claude", analysisPrompt, timeout_seconds * 1000);

  if (!analysisResponse.success || !analysisResponse.response) {
    return {
      success: true,
      question,
      consensus: ["Analysis failed - raw responses available in individual agent responses"],
      disputed: [],
      unique_insights: Object.fromEntries(
        successfulResponses.map((r) => [r.agent, [r.response?.substring(0, 200) || ""]])
      ),
      confidence: "low",
      total_duration_ms: Date.now() - startTime,
    };
  }

  // Parse the structured analysis
  const analysisText = analysisResponse.response;

  // Extract sections using regex
  const consensusMatch = analysisText.match(/## CONSENSUS[^\n]*\n([\s\S]*?)(?=## DISPUTED|$)/i);
  const disputedMatch = analysisText.match(/## DISPUTED[^\n]*\n([\s\S]*?)(?=## UNIQUE|$)/i);
  const uniqueMatch = analysisText.match(/## UNIQUE INSIGHTS\n([\s\S]*?)(?=## CONFIDENCE|$)/i);
  const confidenceMatch = analysisText.match(/## CONFIDENCE\n([\s\S]*?)$/i);

  // Parse bullet points
  const parseBullets = (text: string | undefined): string[] => {
    if (!text) return [];
    return text
      .split("\n")
      .filter((line) => line.trim().startsWith("-") || line.trim().startsWith("*"))
      .map((line) => line.replace(/^[\s]*[-*]\s*/, "").trim())
      .filter((line) => line.length > 0);
  };

  // Parse unique insights per agent
  const parseUniqueInsights = (text: string | undefined): Record<string, string[]> => {
    if (!text) return {};
    const insights: Record<string, string[]> = {};
    const agentSections = text.split(/### /);

    for (const section of agentSections) {
      if (!section.trim()) continue;
      const lines = section.split("\n");
      const agentName = lines[0]?.trim();
      if (agentName) {
        insights[agentName] = parseBullets(lines.slice(1).join("\n"));
      }
    }
    return insights;
  };

  // Determine confidence level
  const confidenceText = confidenceMatch?.[1]?.toLowerCase() || "";
  let confidence: "high" | "medium" | "low" = "medium";
  if (confidenceText.includes("high")) confidence = "high";
  else if (confidenceText.includes("low")) confidence = "low";

  log.success("consensus", { confidence });

  return {
    success: true,
    question,
    consensus: parseBullets(consensusMatch?.[1]),
    disputed: parseBullets(disputedMatch?.[1]),
    unique_insights: parseUniqueInsights(uniqueMatch?.[1]),
    confidence,
    total_duration_ms: Date.now() - startTime,
  };
}

/**
 * Devil's Advocate mode - one agent plays contrarian to stress-test ideas
 *
 * @param args.question - The idea/proposal to stress-test
 * @param args.contrarian - Which agent should be the devil's advocate (default: random)
 * @param args.agents - Which agents to include (default: all)
 * @param args.timeout_seconds - Timeout per query (default: 120)
 */
export async function devils_advocate(args: {
  question: string;
  contrarian?: AgentName;
  agents?: AgentName[];
  timeout_seconds?: number;
}): Promise<{
  success: boolean;
  question: string;
  supportive_responses: AgentResponse[];
  contrarian_response: AgentResponse;
  contrarian_agent: string;
  total_duration_ms: number;
  error?: string;
}> {
  log.call("devils_advocate", args);
  const {
    question,
    agents = ["claude", "codex", "gemini"],
    timeout_seconds = 120,
  } = args;

  if (!question || question.trim().length === 0) {
    return {
      success: false,
      question: "",
      supportive_responses: [],
      contrarian_response: { agent: "", model: "", success: false, duration_ms: 0 },
      contrarian_agent: "",
      total_duration_ms: 0,
      error: "Question is required",
    };
  }

  const startTime = Date.now();
  const timeout = timeout_seconds * 1000;

  // Select contrarian agent (random if not specified)
  const contrarian = args.contrarian || agents[Math.floor(Math.random() * agents.length)];
  const supportiveAgents = agents.filter((a) => a !== contrarian);

  sendProgress(`Devil's advocate mode: ${AGENTS[contrarian].name} will argue against...`);

  // Contrarian role prompt
  const contrarianRole = `You are the Devil's Advocate. Your job is to find flaws, edge cases, risks, and counterarguments to the proposal. Be critical, thorough, and skeptical. Challenge assumptions, identify potential failures, and argue the opposing position convincingly. Do NOT be supportive - your goal is to stress-test this idea.`;

  // Supportive role prompt
  const supportiveRole = `Analyze this proposal constructively. Identify strengths, potential benefits, and how it could succeed. Be supportive but realistic.`;

  // Query all agents in parallel
  const queries = [
    // Contrarian query
    queryAgent(contrarian, question, timeout, contrarianRole),
    // Supportive queries
    ...supportiveAgents.map((a) => queryAgent(a, question, timeout, supportiveRole)),
  ];

  const [contrarianResponse, ...supportiveResponses] = await Promise.all(queries);

  log.success("devils_advocate", { contrarian });

  return {
    success: true,
    question,
    supportive_responses: supportiveResponses,
    contrarian_response: contrarianResponse,
    contrarian_agent: AGENTS[contrarian].name,
    total_duration_ms: Date.now() - startTime,
  };
}

/**
 * List available role presets for specialized queries
 */
export async function list_role_presets(): Promise<{
  success: boolean;
  presets: Array<{
    name: string;
    description: string;
    roles: Record<string, string>;
  }>;
}> {
  log.call("list_role_presets", {});

  const presets = Object.entries(ROLE_PRESETS).map(([name, roles]) => ({
    name,
    description: getPresetDescription(name as RolePreset),
    roles: roles as Record<string, string>,
  }));

  log.success("list_role_presets", presets);
  return { success: true, presets };
}

function getPresetDescription(preset: RolePreset): string {
  switch (preset) {
    case "software":
      return "Software development: architect, implementer, QA/security";
    case "security":
      return "Security audit: architect, pentester, compliance auditor";
    case "review":
      return "Code review: Fowler-style refactoring, performance, readability";
    case "creative":
      return "Creative: writer, editor, fact-checker";
    case "architecture":
      return "Architecture: distributed systems, data modeling, DevOps";
  }
}
