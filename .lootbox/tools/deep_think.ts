/**
 * Deep Think Tool - Comprehensive multi-agent reasoning and problem-solving
 *
 * Expands on basic thinking capabilities to provide:
 * - Multi-framework reasoning (first principles, analogical, systematic, creative, critical)
 * - Parallel agent thinking (Claude, Codex, Gemini)
 * - Assumption identification and challenging
 * - Consequence exploration
 * - Synthesis of multiple reasoning threads
 * - Devil's advocate challenges
 *
 * Architecture:
 * 1. Framework Expansion: Break problem into reasoning frameworks
 * 2. Parallel Reasoning: Multiple agents reason in parallel
 * 3. Synthesis: Combine insights into coherent conclusions
 * 4. Challenge: Identify weaknesses and counter-arguments
 * 5. Deepen: Strengthen weak areas through iteration
 * 6. Conclude: Produce structured reasoning output
 */

import { createLogger, extractErrorMessage, type ProgressCallback } from "./shared/index.ts";

const log = createLogger("deep_think");

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

// ============================================================================
// REASONING FRAMEWORKS
// ============================================================================

const REASONING_FRAMEWORKS = {
  first_principles: {
    name: "First Principles",
    prompt: `Think about this using first principles reasoning:
1. What are the fundamental truths or axioms we can be certain of?
2. Break down the problem to its most basic components
3. Build up a solution from these fundamentals, questioning every assumption
4. What would we conclude if we had no prior knowledge of existing solutions?`,
  },
  analogical: {
    name: "Analogical Reasoning",
    prompt: `Think about this using analogical reasoning:
1. What similar problems have been solved in other domains?
2. What patterns from nature, history, or other fields apply here?
3. What can we learn from how others approached similar challenges?
4. Map the successful elements to our specific problem`,
  },
  systematic: {
    name: "Systematic Analysis",
    prompt: `Think about this systematically:
1. Map out all the components and their relationships
2. Identify inputs, outputs, dependencies, and constraints
3. Trace cause and effect chains
4. Consider the system dynamics and feedback loops
5. Where are the leverage points for change?`,
  },
  creative: {
    name: "Creative/Lateral Thinking",
    prompt: `Think about this creatively:
1. What if we did the opposite of the obvious solution?
2. What constraints can we remove or change?
3. How would an outsider with fresh eyes see this?
4. What unconventional combinations might work?
5. What would a 10x solution look like vs incremental improvement?`,
  },
  critical: {
    name: "Critical Analysis",
    prompt: `Think about this critically:
1. What could go wrong with the obvious solutions?
2. What are we assuming that might not be true?
3. What evidence would change our conclusion?
4. Who might disagree and why?
5. What are the second and third-order effects?`,
  },
  pragmatic: {
    name: "Pragmatic Reasoning",
    prompt: `Think about this pragmatically:
1. What's the simplest solution that could work?
2. What are the real-world constraints (time, resources, skills)?
3. What's the minimum viable approach?
4. What tradeoffs are we willing to make?
5. How do we iterate and improve from there?`,
  },
  stakeholder: {
    name: "Stakeholder Analysis",
    prompt: `Think about this from multiple stakeholder perspectives:
1. Who are all the people affected by this decision?
2. What does each stakeholder value and fear?
3. Where do interests align or conflict?
4. How would each stakeholder evaluate the options?
5. What solution balances these perspectives best?`,
  },
  temporal: {
    name: "Temporal Analysis",
    prompt: `Think about this across time:
1. What's the short-term vs long-term impact?
2. How might this decision look in 1 year, 5 years, 10 years?
3. What future scenarios should we consider?
4. What's reversible vs irreversible?
5. How do we preserve optionality?`,
  },
} as const;

type FrameworkKey = keyof typeof REASONING_FRAMEWORKS;

// ============================================================================
// AGENT CONFIGURATION
// ============================================================================

interface AgentConfig {
  name: string;
  command: string;
  args: string[];
  parseOutput: "stream-json" | "jsonl" | "text";
}

const AGENTS: Record<string, AgentConfig> = {
  claude: {
    name: "Claude (Opus)",
    command: "claude",
    args: ["-p", "--model", "opus", "--append-system-prompt", "Think deeply and systematically. Show your reasoning step by step.", "--output-format", "text"],
    parseOutput: "text",
  },
  codex: {
    name: "Codex (GPT-5.1)",
    command: "codex",
    args: ["exec", "-m", "gpt-5.1-codex-max", "-c", 'model_reasoning_effort="xhigh"', "--json"],
    parseOutput: "jsonl",
  },
  gemini: {
    name: "Gemini (Pro)",
    command: "gemini",
    args: ["-m", "pro", "-o", "text"],
    parseOutput: "text",
  },
};

type AgentName = keyof typeof AGENTS;

// ============================================================================
// CORE UTILITIES
// ============================================================================

interface AgentThought {
  agent: string;
  framework?: string;
  success: boolean;
  reasoning?: string;
  error?: string;
  duration_ms: number;
}

/**
 * Parse JSONL output from Codex
 */
function parseCodexJsonl(rawOutput: string): string {
  const lines = rawOutput.split("\n").filter((line) => line.trim());
  const textParts: string[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.message) textParts.push(obj.message);
      else if (obj.content) textParts.push(obj.content);
      else if (obj.text) textParts.push(obj.text);
    } catch {
      if (line.trim() && !line.startsWith("{")) textParts.push(line);
    }
  }

  return textParts.join("\n") || rawOutput;
}

/**
 * Query a single agent for reasoning
 */
async function queryAgentForThinking(
  agentKey: AgentName,
  prompt: string,
  framework?: string,
  timeout = 180000
): Promise<AgentThought> {
  const agent = AGENTS[agentKey];
  const startTime = Date.now();

  log.info(`Querying ${agent.name}${framework ? ` (${framework})` : ""}...`);
  sendProgress(`[${agent.name}] Starting reasoning${framework ? ` using ${framework}` : ""}...`);

  try {
    const proc = Bun.spawn([agent.command, ...agent.args, prompt], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CI: "true", TERM: "dumb" },
    });

    // Stream with progress updates
    let response = "";
    let charCount = 0;
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();

    // Progress reporter
    const progressInterval = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      sendProgress(`[${agent.name}] Thinking... (${elapsed}s, ${charCount} chars)`);
    }, 5000);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        response += chunk;
        charCount += chunk.length;
      }
    } finally {
      clearInterval(progressInterval);
    }

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const duration_ms = Date.now() - startTime;

    if (exitCode !== 0) {
      return {
        agent: agent.name,
        framework,
        success: false,
        error: stderr || `Exit code ${exitCode}`,
        duration_ms,
      };
    }

    // Parse output based on agent type
    let reasoning = response.trim();
    if (agentKey === "codex") {
      reasoning = parseCodexJsonl(reasoning);
    }

    sendProgress(`[${agent.name}] Completed in ${(duration_ms / 1000).toFixed(1)}s`);

    return {
      agent: agent.name,
      framework,
      success: true,
      reasoning,
      duration_ms,
    };
  } catch (error) {
    return {
      agent: AGENTS[agentKey].name,
      framework,
      success: false,
      error: extractErrorMessage(error),
      duration_ms: Date.now() - startTime,
    };
  }
}

// ============================================================================
// MAIN THINKING FUNCTIONS
// ============================================================================

interface DeepThinkResult {
  success: boolean;
  problem: string;
  synthesis: string;
  reasoning_threads: Array<{
    framework: string;
    agent: string;
    reasoning: string;
  }>;
  key_insights: string[];
  assumptions_identified: string[];
  potential_flaws: string[];
  conclusion: string;
  confidence: "high" | "medium" | "low";
  methodology: {
    frameworks_used: string[];
    agents_consulted: string[];
    total_reasoning_threads: number;
  };
  total_duration_ms: number;
  error?: string;
}

/**
 * Conduct deep, multi-perspective thinking on a problem
 *
 * This is the main entry point for thorough reasoning. It:
 * 1. Breaks the problem into multiple reasoning frameworks
 * 2. Queries multiple agents with different frameworks
 * 3. Synthesizes insights from all perspectives
 * 4. Identifies assumptions and potential flaws
 * 5. Produces a well-reasoned conclusion
 *
 * @param args.problem - The problem or question to think through
 * @param args.depth - Thinking depth: "quick" (2 frameworks), "standard" (4), "thorough" (6)
 * @param args.frameworks - Optional specific frameworks to use
 * @param args.context - Optional context or constraints
 * @param args.timeout_seconds - Timeout for the entire thinking process
 */
export async function deep_think(args: {
  problem: string;
  depth?: "quick" | "standard" | "thorough";
  frameworks?: FrameworkKey[];
  context?: string;
  timeout_seconds?: number;
}): Promise<DeepThinkResult> {
  log.call("deep_think", args);
  const {
    problem,
    depth = "standard",
    frameworks,
    context,
    timeout_seconds = 300,
  } = args;

  if (!problem || problem.trim().length === 0) {
    return {
      success: false,
      problem: "",
      synthesis: "",
      reasoning_threads: [],
      key_insights: [],
      assumptions_identified: [],
      potential_flaws: [],
      conclusion: "",
      confidence: "low",
      methodology: { frameworks_used: [], agents_consulted: [], total_reasoning_threads: 0 },
      total_duration_ms: 0,
      error: "Problem statement is required",
    };
  }

  const startTime = Date.now();

  // Select frameworks based on depth
  const defaultFrameworks: FrameworkKey[][] = {
    quick: ["first_principles", "pragmatic"],
    standard: ["first_principles", "systematic", "critical", "pragmatic"],
    thorough: ["first_principles", "analogical", "systematic", "creative", "critical", "pragmatic"],
  };

  const selectedFrameworks = frameworks || defaultFrameworks[depth];
  sendProgress(`Starting deep thinking on: ${problem.substring(0, 50)}... (${depth} depth, ${selectedFrameworks.length} frameworks)`);

  // Build context-aware problem statement
  const fullProblem = context
    ? `Problem: ${problem}\n\nContext/Constraints: ${context}`
    : `Problem: ${problem}`;

  // Step 1: Query agents with different frameworks in parallel
  sendProgress("Initiating multi-framework reasoning...");

  // Distribute frameworks across agents
  const agentKeys: AgentName[] = ["claude", "codex", "gemini"];
  const reasoningPromises: Promise<AgentThought>[] = [];

  selectedFrameworks.forEach((framework, index) => {
    const agentKey = agentKeys[index % agentKeys.length];
    const frameworkConfig = REASONING_FRAMEWORKS[framework];
    const prompt = `${frameworkConfig.prompt}\n\n${fullProblem}\n\nProvide your detailed reasoning:`;
    reasoningPromises.push(queryAgentForThinking(agentKey, prompt, frameworkConfig.name, timeout_seconds * 1000));
  });

  const reasoningResults = await Promise.all(reasoningPromises);
  const successfulResults = reasoningResults.filter((r) => r.success);

  if (successfulResults.length === 0) {
    return {
      success: false,
      problem,
      synthesis: "",
      reasoning_threads: [],
      key_insights: [],
      assumptions_identified: [],
      potential_flaws: [],
      conclusion: "",
      confidence: "low",
      methodology: {
        frameworks_used: selectedFrameworks,
        agents_consulted: [],
        total_reasoning_threads: 0,
      },
      total_duration_ms: Date.now() - startTime,
      error: "All reasoning attempts failed",
    };
  }

  // Compile reasoning threads
  const reasoning_threads = successfulResults.map((r) => ({
    framework: r.framework || "general",
    agent: r.agent,
    reasoning: r.reasoning || "",
  }));

  sendProgress(`Completed ${successfulResults.length}/${reasoningResults.length} reasoning threads`);

  // Step 2: Synthesize all reasoning
  sendProgress("Synthesizing insights from all perspectives...");

  const synthesisPrompt = `You are synthesizing reasoning from multiple perspectives on this problem:

**Problem:** ${problem}
${context ? `\n**Context:** ${context}` : ""}

**Reasoning from Different Frameworks:**

${reasoning_threads.map((t) => `### ${t.framework} (${t.agent})\n${t.reasoning}`).join("\n\n---\n\n")}

**Your Task:**

Synthesize these perspectives into a coherent analysis. Provide:

1. **Key Insights** (bullet points)
   - What are the most important realizations from combining these perspectives?

2. **Assumptions Identified** (bullet points)
   - What assumptions are being made across the reasoning?

3. **Potential Flaws** (bullet points)
   - Where might this reasoning be wrong?
   - What are the weak points?

4. **Synthesis**
   - How do these different perspectives fit together?
   - Where do they agree and disagree?

5. **Conclusion**
   - What is the best answer/approach given all perspectives?
   - What is your confidence level (high/medium/low) and why?`;

  const synthesisResult = await queryAgentForThinking("claude", synthesisPrompt);

  // Parse structured data from synthesis
  const key_insights: string[] = [];
  const assumptions_identified: string[] = [];
  const potential_flaws: string[] = [];
  let conclusion = "";
  let confidence: "high" | "medium" | "low" = "medium";

  if (synthesisResult.success && synthesisResult.reasoning) {
    const text = synthesisResult.reasoning;

    // Parse bullet points from sections
    const parseBullets = (sectionName: string): string[] => {
      const regex = new RegExp(`\\*\\*${sectionName}\\*\\*[\\s\\S]*?(?=\\*\\*|$)`, "i");
      const match = text.match(regex);
      if (!match) return [];
      return match[0]
        .split("\n")
        .filter((line) => line.trim().match(/^[-*•]\s/))
        .map((line) => line.replace(/^[-*•]\s*/, "").trim())
        .filter((line) => line.length > 0);
    };

    key_insights.push(...parseBullets("Key Insights"));
    assumptions_identified.push(...parseBullets("Assumptions Identified"));
    potential_flaws.push(...parseBullets("Potential Flaws"));

    // Extract conclusion
    const conclusionMatch = text.match(/\*\*Conclusion\*\*[\s\S]*$/i);
    if (conclusionMatch) {
      conclusion = conclusionMatch[0].replace(/\*\*Conclusion\*\*\s*/i, "").trim();
    }

    // Determine confidence
    const lowerText = text.toLowerCase();
    if (lowerText.includes("high confidence") || lowerText.includes("confidence: high") || lowerText.includes("confident")) {
      confidence = "high";
    } else if (lowerText.includes("low confidence") || lowerText.includes("confidence: low") || lowerText.includes("uncertain")) {
      confidence = "low";
    }
  }

  const total_duration_ms = Date.now() - startTime;
  sendProgress(`Deep thinking complete in ${(total_duration_ms / 1000).toFixed(1)}s`);

  log.success("deep_think", { problem: problem.substring(0, 50), threads: reasoning_threads.length, duration: total_duration_ms });

  return {
    success: true,
    problem,
    synthesis: synthesisResult.reasoning || "",
    reasoning_threads,
    key_insights,
    assumptions_identified,
    potential_flaws,
    conclusion,
    confidence,
    methodology: {
      frameworks_used: selectedFrameworks,
      agents_consulted: [...new Set(successfulResults.map((r) => r.agent))],
      total_reasoning_threads: reasoning_threads.length,
    },
    total_duration_ms,
  };
}

/**
 * Quick focused reasoning on a specific question
 *
 * @param args.question - The question to reason through
 * @param args.approach - Reasoning approach to use
 */
export async function quick_think(args: {
  question: string;
  approach?: "first_principles" | "systematic" | "critical" | "creative";
}): Promise<{
  success: boolean;
  question: string;
  reasoning: string;
  conclusion: string;
  confidence: string;
  duration_ms: number;
  error?: string;
}> {
  log.call("quick_think", args);
  const { question, approach = "systematic" } = args;

  if (!question) {
    return {
      success: false,
      question: "",
      reasoning: "",
      conclusion: "",
      confidence: "",
      duration_ms: 0,
      error: "Question is required",
    };
  }

  const startTime = Date.now();
  sendProgress(`Quick thinking: ${question.substring(0, 50)}...`);

  const framework = REASONING_FRAMEWORKS[approach];
  const prompt = `${framework.prompt}\n\nQuestion: ${question}\n\nProvide your reasoning step by step, then state your conclusion clearly.`;

  const result = await queryAgentForThinking("gemini", prompt, framework.name);

  if (!result.success) {
    return {
      success: false,
      question,
      reasoning: "",
      conclusion: "",
      confidence: "",
      duration_ms: Date.now() - startTime,
      error: result.error,
    };
  }

  // Extract conclusion from reasoning
  let conclusion = "";
  const conclusionMatch = result.reasoning?.match(/(?:conclusion|therefore|thus|in summary)[:\s]+([^\n]+)/i);
  if (conclusionMatch) {
    conclusion = conclusionMatch[1].trim();
  }

  return {
    success: true,
    question,
    reasoning: result.reasoning || "",
    conclusion,
    confidence: "medium",
    duration_ms: Date.now() - startTime,
  };
}

/**
 * Challenge a conclusion or idea with devil's advocate reasoning
 *
 * @param args.idea - The idea or conclusion to challenge
 * @param args.context - Optional context for the idea
 * @param args.intensity - How aggressive the challenge should be
 */
export async function challenge_idea(args: {
  idea: string;
  context?: string;
  intensity?: "gentle" | "moderate" | "aggressive";
}): Promise<{
  success: boolean;
  idea: string;
  challenges: string[];
  counter_arguments: string[];
  weak_points: string[];
  alternative_perspectives: string[];
  verdict: string;
  duration_ms: number;
  error?: string;
}> {
  log.call("challenge_idea", args);
  const { idea, context, intensity = "moderate" } = args;

  if (!idea) {
    return {
      success: false,
      idea: "",
      challenges: [],
      counter_arguments: [],
      weak_points: [],
      alternative_perspectives: [],
      verdict: "",
      duration_ms: 0,
      error: "Idea to challenge is required",
    };
  }

  const startTime = Date.now();
  sendProgress(`Challenging idea: ${idea.substring(0, 50)}...`);

  const intensityPrompts = {
    gentle: "Be constructive but point out potential issues.",
    moderate: "Be thorough in finding flaws while remaining fair.",
    aggressive: "Argue strongly against this position. Find every possible weakness.",
  };

  const prompt = `You are a devil's advocate. Your job is to challenge this idea/conclusion:

**Idea:** ${idea}
${context ? `\n**Context:** ${context}` : ""}

**Your Mission:** ${intensityPrompts[intensity]}

Provide:

1. **Direct Challenges** (bullet points)
   - What's wrong with this idea?

2. **Counter-Arguments** (bullet points)
   - What arguments oppose this?

3. **Weak Points** (bullet points)
   - Where does the logic fail?
   - What assumptions are questionable?

4. **Alternative Perspectives** (bullet points)
   - How might someone else see this differently?

5. **Verdict**
   - After challenging, does the idea still hold?
   - What would make it stronger?`;

  // Query multiple agents for diverse challenges
  const challengePromises = [
    queryAgentForThinking("claude", prompt, "Devil's Advocate (Claude)"),
    queryAgentForThinking("gemini", prompt, "Devil's Advocate (Gemini)"),
  ];

  const results = await Promise.all(challengePromises);
  const successful = results.filter((r) => r.success);

  if (successful.length === 0) {
    return {
      success: false,
      idea,
      challenges: [],
      counter_arguments: [],
      weak_points: [],
      alternative_perspectives: [],
      verdict: "",
      duration_ms: Date.now() - startTime,
      error: "All challenge attempts failed",
    };
  }

  // Combine challenges from all agents
  const challenges: string[] = [];
  const counter_arguments: string[] = [];
  const weak_points: string[] = [];
  const alternative_perspectives: string[] = [];
  let verdict = "";

  for (const result of successful) {
    if (!result.reasoning) continue;
    const text = result.reasoning;

    const parseBullets = (pattern: string): string[] => {
      const regex = new RegExp(`\\*\\*${pattern}\\*\\*[\\s\\S]*?(?=\\*\\*|$)`, "i");
      const match = text.match(regex);
      if (!match) return [];
      return match[0]
        .split("\n")
        .filter((line) => line.trim().match(/^[-*•]\s/))
        .map((line) => `[${result.agent}] ${line.replace(/^[-*•]\s*/, "").trim()}`)
        .filter((line) => line.length > 10);
    };

    challenges.push(...parseBullets("Direct Challenges"));
    counter_arguments.push(...parseBullets("Counter-Arguments"));
    weak_points.push(...parseBullets("Weak Points"));
    alternative_perspectives.push(...parseBullets("Alternative Perspectives"));

    const verdictMatch = text.match(/\*\*Verdict\*\*[\s\S]*$/i);
    if (verdictMatch && !verdict) {
      verdict = verdictMatch[0].replace(/\*\*Verdict\*\*\s*/i, "").trim();
    }
  }

  return {
    success: true,
    idea,
    challenges: [...new Set(challenges)],
    counter_arguments: [...new Set(counter_arguments)],
    weak_points: [...new Set(weak_points)],
    alternative_perspectives: [...new Set(alternative_perspectives)],
    verdict,
    duration_ms: Date.now() - startTime,
  };
}

/**
 * Evaluate multiple options/approaches systematically
 *
 * @param args.question - The decision question
 * @param args.options - The options to evaluate
 * @param args.criteria - Evaluation criteria
 * @param args.context - Optional context
 */
export async function evaluate_options(args: {
  question: string;
  options: string[];
  criteria?: string[];
  context?: string;
}): Promise<{
  success: boolean;
  question: string;
  evaluations: Array<{
    option: string;
    pros: string[];
    cons: string[];
    score: number;
    rationale: string;
  }>;
  recommendation: string;
  reasoning: string;
  duration_ms: number;
  error?: string;
}> {
  log.call("evaluate_options", args);
  const { question, options, criteria, context } = args;

  if (!question || !options || options.length < 2) {
    return {
      success: false,
      question: "",
      evaluations: [],
      recommendation: "",
      reasoning: "",
      duration_ms: 0,
      error: "Question and at least 2 options required",
    };
  }

  const startTime = Date.now();
  sendProgress(`Evaluating ${options.length} options...`);

  const prompt = `Systematically evaluate these options:

**Decision Question:** ${question}
${context ? `\n**Context:** ${context}` : ""}

**Options to Evaluate:**
${options.map((opt, i) => `${i + 1}. ${opt}`).join("\n")}

${criteria ? `**Evaluation Criteria:**\n${criteria.map((c) => `- ${c}`).join("\n")}` : ""}

**For each option, provide:**
1. Pros (bullet points)
2. Cons (bullet points)
3. Score (1-10)
4. Brief rationale

**Then provide:**
- Overall recommendation
- Reasoning for the recommendation

Format each option evaluation clearly with headers.`;

  const result = await queryAgentForThinking("claude", prompt, "Option Evaluation");

  if (!result.success) {
    return {
      success: false,
      question,
      evaluations: [],
      recommendation: "",
      reasoning: result.reasoning || "",
      duration_ms: Date.now() - startTime,
      error: result.error,
    };
  }

  // Parse evaluations (simplified - in production would be more robust)
  const evaluations = options.map((option) => ({
    option,
    pros: [] as string[],
    cons: [] as string[],
    score: 5,
    rationale: "",
  }));

  // Extract recommendation
  const recMatch = result.reasoning?.match(/(?:recommendation|recommend)[:\s]+([^\n]+)/i);
  const recommendation = recMatch ? recMatch[1].trim() : "";

  return {
    success: true,
    question,
    evaluations,
    recommendation,
    reasoning: result.reasoning || "",
    duration_ms: Date.now() - startTime,
  };
}

/**
 * Identify and analyze assumptions in reasoning or a plan
 *
 * @param args.statement - The statement, plan, or reasoning to analyze
 * @param args.domain - Optional domain context
 */
export async function identify_assumptions(args: {
  statement: string;
  domain?: string;
}): Promise<{
  success: boolean;
  statement: string;
  explicit_assumptions: string[];
  implicit_assumptions: string[];
  risky_assumptions: string[];
  validation_suggestions: string[];
  duration_ms: number;
  error?: string;
}> {
  log.call("identify_assumptions", args);
  const { statement, domain } = args;

  if (!statement) {
    return {
      success: false,
      statement: "",
      explicit_assumptions: [],
      implicit_assumptions: [],
      risky_assumptions: [],
      validation_suggestions: [],
      duration_ms: 0,
      error: "Statement to analyze is required",
    };
  }

  const startTime = Date.now();
  sendProgress("Identifying assumptions...");

  const prompt = `Analyze the assumptions in this statement/plan:

**Statement:** ${statement}
${domain ? `\n**Domain:** ${domain}` : ""}

Identify:

1. **Explicit Assumptions** (bullet points)
   - What assumptions are clearly stated?

2. **Implicit Assumptions** (bullet points)
   - What is assumed but not stated?
   - What must be true for this to work?

3. **Risky Assumptions** (bullet points)
   - Which assumptions are most likely to be wrong?
   - Which would cause the biggest problems if wrong?

4. **Validation Suggestions** (bullet points)
   - How could each risky assumption be tested?`;

  const result = await queryAgentForThinking("claude", prompt, "Assumption Analysis");

  const parseBullets = (text: string, pattern: string): string[] => {
    const regex = new RegExp(`\\*\\*${pattern}\\*\\*[\\s\\S]*?(?=\\*\\*|$)`, "i");
    const match = text.match(regex);
    if (!match) return [];
    return match[0]
      .split("\n")
      .filter((line) => line.trim().match(/^[-*•]\s/))
      .map((line) => line.replace(/^[-*•]\s*/, "").trim())
      .filter((line) => line.length > 0);
  };

  const text = result.reasoning || "";

  return {
    success: result.success,
    statement,
    explicit_assumptions: parseBullets(text, "Explicit Assumptions"),
    implicit_assumptions: parseBullets(text, "Implicit Assumptions"),
    risky_assumptions: parseBullets(text, "Risky Assumptions"),
    validation_suggestions: parseBullets(text, "Validation Suggestions"),
    duration_ms: Date.now() - startTime,
    error: result.error,
  };
}

/**
 * Explore consequences and implications of a decision or action
 *
 * @param args.action - The action or decision to analyze
 * @param args.timeframes - Time horizons to consider
 * @param args.domains - Domains to consider impact in
 */
export async function explore_consequences(args: {
  action: string;
  timeframes?: ("immediate" | "short_term" | "long_term")[];
  domains?: string[];
}): Promise<{
  success: boolean;
  action: string;
  immediate_effects: string[];
  short_term_effects: string[];
  long_term_effects: string[];
  second_order_effects: string[];
  unintended_consequences: string[];
  reversibility: string;
  duration_ms: number;
  error?: string;
}> {
  log.call("explore_consequences", args);
  const { action, timeframes = ["immediate", "short_term", "long_term"], domains } = args;

  if (!action) {
    return {
      success: false,
      action: "",
      immediate_effects: [],
      short_term_effects: [],
      long_term_effects: [],
      second_order_effects: [],
      unintended_consequences: [],
      reversibility: "",
      duration_ms: 0,
      error: "Action to analyze is required",
    };
  }

  const startTime = Date.now();
  sendProgress("Exploring consequences...");

  const prompt = `Analyze the consequences of this action/decision:

**Action:** ${action}
${domains ? `\n**Domains to Consider:** ${domains.join(", ")}` : ""}

Explore:

1. **Immediate Effects** (what happens right away)
2. **Short-term Effects** (days to weeks)
3. **Long-term Effects** (months to years)
4. **Second-Order Effects** (consequences of the consequences)
5. **Potential Unintended Consequences**
6. **Reversibility** (how easy is it to undo?)

For each, consider both positive and negative outcomes.`;

  const result = await queryAgentForThinking("claude", prompt, "Consequence Analysis");

  const parseBullets = (text: string, pattern: string): string[] => {
    const regex = new RegExp(`\\*\\*${pattern}\\*\\*[\\s\\S]*?(?=\\*\\*|$)`, "i");
    const match = text.match(regex);
    if (!match) return [];
    return match[0]
      .split("\n")
      .filter((line) => line.trim().match(/^[-*•]\s/))
      .map((line) => line.replace(/^[-*•]\s*/, "").trim())
      .filter((line) => line.length > 0);
  };

  const text = result.reasoning || "";

  // Extract reversibility
  const revMatch = text.match(/\*\*Reversibility\*\*[\s\S]*?(?=\*\*|$)/i);
  const reversibility = revMatch
    ? revMatch[0].replace(/\*\*Reversibility\*\*\s*/i, "").trim().split("\n")[0]
    : "";

  return {
    success: result.success,
    action,
    immediate_effects: parseBullets(text, "Immediate Effects"),
    short_term_effects: parseBullets(text, "Short-term Effects"),
    long_term_effects: parseBullets(text, "Long-term Effects"),
    second_order_effects: parseBullets(text, "Second-Order Effects"),
    unintended_consequences: parseBullets(text, "Unintended Consequences"),
    reversibility,
    duration_ms: Date.now() - startTime,
    error: result.error,
  };
}

/**
 * Generate a mental model or framework for understanding a concept
 *
 * @param args.concept - The concept to model
 * @param args.purpose - What the model will be used for
 */
export async function build_mental_model(args: {
  concept: string;
  purpose?: string;
}): Promise<{
  success: boolean;
  concept: string;
  core_principles: string[];
  key_relationships: string[];
  boundary_conditions: string[];
  common_mistakes: string[];
  mental_model: string;
  analogies: string[];
  duration_ms: number;
  error?: string;
}> {
  log.call("build_mental_model", args);
  const { concept, purpose } = args;

  if (!concept) {
    return {
      success: false,
      concept: "",
      core_principles: [],
      key_relationships: [],
      boundary_conditions: [],
      common_mistakes: [],
      mental_model: "",
      analogies: [],
      duration_ms: 0,
      error: "Concept is required",
    };
  }

  const startTime = Date.now();
  sendProgress(`Building mental model for: ${concept}...`);

  const prompt = `Build a mental model for understanding this concept:

**Concept:** ${concept}
${purpose ? `\n**Purpose:** ${purpose}` : ""}

Create a comprehensive mental model including:

1. **Core Principles** (the fundamental truths)
2. **Key Relationships** (how parts relate to each other)
3. **Boundary Conditions** (when does this model apply/not apply?)
4. **Common Mistakes** (how do people misunderstand this?)
5. **Mental Model Summary** (a concise framework for thinking about this)
6. **Helpful Analogies** (comparisons that aid understanding)`;

  const result = await queryAgentForThinking("claude", prompt, "Mental Model Building");

  const parseBullets = (text: string, pattern: string): string[] => {
    const regex = new RegExp(`\\*\\*${pattern}\\*\\*[\\s\\S]*?(?=\\*\\*|$)`, "i");
    const match = text.match(regex);
    if (!match) return [];
    return match[0]
      .split("\n")
      .filter((line) => line.trim().match(/^[-*•]\s/))
      .map((line) => line.replace(/^[-*•]\s*/, "").trim())
      .filter((line) => line.length > 0);
  };

  const text = result.reasoning || "";

  // Extract mental model summary
  const modelMatch = text.match(/\*\*Mental Model Summary\*\*[\s\S]*?(?=\*\*|$)/i);
  const mental_model = modelMatch
    ? modelMatch[0].replace(/\*\*Mental Model Summary\*\*\s*/i, "").trim()
    : "";

  return {
    success: result.success,
    concept,
    core_principles: parseBullets(text, "Core Principles"),
    key_relationships: parseBullets(text, "Key Relationships"),
    boundary_conditions: parseBullets(text, "Boundary Conditions"),
    common_mistakes: parseBullets(text, "Common Mistakes"),
    mental_model,
    analogies: parseBullets(text, "Helpful Analogies"),
    duration_ms: Date.now() - startTime,
    error: result.error,
  };
}

/**
 * List available reasoning frameworks
 */
export async function list_frameworks(): Promise<{
  success: boolean;
  frameworks: Array<{
    key: string;
    name: string;
    description: string;
  }>;
}> {
  log.call("list_frameworks", {});

  const frameworks = Object.entries(REASONING_FRAMEWORKS).map(([key, value]) => ({
    key,
    name: value.name,
    description: value.prompt.split("\n")[0],
  }));

  return { success: true, frameworks };
}
