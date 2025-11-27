/**
 * Brainstorm Tool - Multi-Agent Creative Ideation
 *
 * Generate, refine, and synthesize ideas using multiple AI agents
 * with various brainstorming methodologies.
 *
 * Features:
 * - Mode-based brainstorming (SCAMPER, Six Thinking Hats, Mind Map, First Principles)
 * - Parallel agent idea generation
 * - Cross-agent idea synthesis and combination
 * - Constraint-based creativity
 * - Idea scoring and ranking
 * - Multiple export formats
 */

import { createLogger, extractErrorMessage, type ProgressCallback } from "./shared/index.ts";
import { saveToolResponse } from "./shared/response_history.ts";

const log = createLogger("brainstorm");

let globalProgressCallback: ProgressCallback | null = null;

export function setProgressCallback(callback: ProgressCallback | null): void {
  globalProgressCallback = callback;
}

function sendProgress(message: string): void {
  if (globalProgressCallback) {
    globalProgressCallback(message);
  }
}

// Agent configuration
const AGENTS = {
  claude: {
    name: "Claude",
    command: "claude",
    args: ["-p", "--model", "sonnet", "--output-format", "text"],
  },
  codex: {
    name: "Codex",
    command: "codex",
    args: ["exec", "-m", "o4-mini"],
  },
  gemini: {
    name: "Gemini",
    command: "gemini",
    args: ["-m", "flash"],
  },
} as const;

type AgentName = keyof typeof AGENTS;

// Brainstorming mode configurations
const BRAINSTORM_MODES = {
  // SCAMPER: Each agent tackles different transformations
  scamper: {
    name: "SCAMPER",
    description: "Systematic creativity through Substitute, Combine, Adapt, Modify, Put to other uses, Eliminate, Reverse",
    agentPrompts: {
      claude: "Using SCAMPER method, focus on SUBSTITUTE and COMBINE. What can be replaced or combined differently?",
      codex: "Using SCAMPER method, focus on ADAPT and MODIFY. How can this be adapted or changed in scale/form?",
      gemini: "Using SCAMPER method, focus on PUT TO OTHER USES, ELIMINATE, and REVERSE. What can be repurposed, removed, or reversed?",
    },
  },

  // Six Thinking Hats: Different perspectives
  six_hats: {
    name: "Six Thinking Hats",
    description: "Parallel thinking from different perspectives: facts, emotions, critical, optimistic, creative, process",
    agentPrompts: {
      claude: "Wear the WHITE HAT (facts/data) and GREEN HAT (creativity/alternatives). What are the facts and creative possibilities?",
      codex: "Wear the BLACK HAT (critical/risks) and YELLOW HAT (benefits/optimism). What are the risks and potential benefits?",
      gemini: "Wear the RED HAT (emotions/intuition) and BLUE HAT (process/overview). What's the intuitive feeling and big picture?",
    },
  },

  // Mind Map: Divergent expansion
  mind_map: {
    name: "Mind Map Expansion",
    description: "Divergent thinking to expand ideas in multiple directions",
    agentPrompts: {
      claude: "Expand this topic into PRIMARY BRANCHES - identify 3-5 major themes or categories.",
      codex: "For each major theme, generate SECONDARY BRANCHES - specific sub-topics or implementations.",
      gemini: "Add CONNECTIONS and CROSS-LINKS - how do different branches relate to each other?",
    },
  },

  // First Principles: Break down and rebuild
  first_principles: {
    name: "First Principles",
    description: "Break down to fundamental truths and rebuild from scratch",
    agentPrompts: {
      claude: "DECONSTRUCT: What are the fundamental assumptions and base truths here? Break it down to first principles.",
      codex: "RECONSTRUCT: Given those first principles, what new solutions emerge when we build up from scratch?",
      gemini: "VALIDATE: Which reconstructed solutions are most viable? What novel combinations emerged?",
    },
  },

  // Contrarian: Devil's advocate brainstorming
  contrarian: {
    name: "Contrarian Brainstorm",
    description: "Generate ideas by challenging conventional wisdom",
    agentPrompts: {
      claude: "What does CONVENTIONAL WISDOM say about this? List the standard approaches and assumptions.",
      codex: "CHALLENGE each assumption. What if the opposite were true? Generate contrarian alternatives.",
      gemini: "SYNTHESIZE: Which contrarian ideas have merit? What hybrid approaches emerge?",
    },
  },

  // Rapid Fire: High-volume generation
  rapid: {
    name: "Rapid Fire",
    description: "High-volume idea generation without filtering",
    agentPrompts: {
      claude: "Generate 10 quick ideas without self-censoring. Quantity over quality. Be wild.",
      codex: "Generate 10 different ideas, focus on practical and implementable. Be specific.",
      gemini: "Generate 10 ideas that combine creativity with feasibility. Mix wild and practical.",
    },
  },
} as const;

type BrainstormMode = keyof typeof BRAINSTORM_MODES;

// Creative constraint presets
const CONSTRAINT_PRESETS = {
  minimal: "Constraint: Use the simplest possible approach. No over-engineering.",
  time_pressure: "Constraint: Must be achievable in under 1 hour of work.",
  resource_limited: "Constraint: Assume minimal budget and no new dependencies.",
  user_first: "Constraint: Optimize entirely for end-user experience, ignore technical elegance.",
  contrarian: "Constraint: Avoid the obvious solution. What would a competitor NOT expect?",
  moonshot: "Constraint: Ignore all practical limitations. What's the ideal solution?",
  backwards: "Constraint: Start from the desired end state and work backwards.",
} as const;

type ConstraintPreset = keyof typeof CONSTRAINT_PRESETS;

interface Idea {
  id: string;
  agent: string;
  content: string;
  category?: string;
  score?: number;
}

interface BrainstormResult {
  success: boolean;
  topic: string;
  mode: string;
  ideas: Idea[];
  synthesis?: string;
  total_duration_ms: number;
  error?: string;
}

/**
 * Run a single agent query
 */
async function queryAgent(
  agentKey: AgentName,
  prompt: string,
  timeout: number
): Promise<{ success: boolean; response?: string; error?: string; duration_ms: number }> {
  const agent = AGENTS[agentKey];
  const startTime = Date.now();

  log.info(`Querying ${agent.name}...`);
  sendProgress(`[${agent.name}] Generating ideas...`);

  try {
    const proc = Bun.spawn([agent.command, ...agent.args, prompt], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CI: "true", TERM: "dumb" },
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Timeout after ${timeout / 1000}s`)), timeout);
    });

    const resultPromise = (async () => {
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      return { stdout, stderr, exitCode };
    })();

    const { stdout, stderr, exitCode } = await Promise.race([resultPromise, timeoutPromise]);
    const duration_ms = Date.now() - startTime;

    if (exitCode !== 0) {
      return { success: false, error: stderr || `Exit code ${exitCode}`, duration_ms };
    }

    sendProgress(`[${agent.name}] Done (${(duration_ms / 1000).toFixed(1)}s)`);
    return { success: true, response: stdout.trim(), duration_ms };
  } catch (error) {
    return {
      success: false,
      error: extractErrorMessage(error),
      duration_ms: Date.now() - startTime,
    };
  }
}

/**
 * Generate ideas using a specific brainstorming mode
 *
 * @param args.topic - The topic or problem to brainstorm about
 * @param args.mode - Brainstorming mode: scamper, six_hats, mind_map, first_principles, contrarian, rapid
 * @param args.constraints - Optional constraints to apply (preset name or custom string)
 * @param args.agents - Which agents to use (defaults to all)
 * @param args.timeout_seconds - Timeout per agent (default: 90)
 */
export async function generate(args: {
  topic: string;
  mode?: BrainstormMode;
  constraints?: ConstraintPreset | string;
  agents?: AgentName[];
  timeout_seconds?: number;
}): Promise<BrainstormResult> {
  log.call("generate", args);
  const {
    topic,
    mode = "rapid",
    constraints,
    agents = ["claude", "codex", "gemini"],
    timeout_seconds = 90,
  } = args;

  if (!topic || topic.trim().length === 0) {
    return { success: false, topic: "", mode, ideas: [], total_duration_ms: 0, error: "Topic is required" };
  }

  const startTime = Date.now();
  const timeout = timeout_seconds * 1000;
  const modeConfig = BRAINSTORM_MODES[mode];

  sendProgress(`Starting ${modeConfig.name} brainstorm with ${agents.length} agents...`);

  // Build constraint string
  const constraintText = constraints
    ? (constraints in CONSTRAINT_PRESETS
        ? CONSTRAINT_PRESETS[constraints as ConstraintPreset]
        : `Constraint: ${constraints}`)
    : "";

  // Query all agents in parallel with mode-specific prompts
  const queries = agents.map((agentKey) => {
    const modePrompt = modeConfig.agentPrompts[agentKey];
    const fullPrompt = `BRAINSTORM TOPIC: ${topic}

${modePrompt}

${constraintText}

Format your response as a numbered list of distinct ideas. Be specific and actionable.`;

    return queryAgent(agentKey, fullPrompt, timeout).then((result) => ({
      agent: agentKey,
      ...result,
    }));
  });

  const results = await Promise.all(queries);

  // Parse ideas from responses
  const ideas: Idea[] = [];
  let ideaCounter = 1;

  for (const result of results) {
    if (result.success && result.response) {
      // Parse numbered list items
      const lines = result.response.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        // Match numbered items (1. or 1) or bullet points
        if (/^(\d+[.)]\s*|\*\s*|-\s*)/.test(trimmed)) {
          const content = trimmed.replace(/^(\d+[.)]\s*|\*\s*|-\s*)/, "").trim();
          if (content.length > 10) {
            ideas.push({
              id: `idea-${ideaCounter++}`,
              agent: AGENTS[result.agent].name,
              content,
            });
          }
        }
      }
    }
  }

  const total_duration_ms = Date.now() - startTime;
  const successCount = results.filter((r) => r.success).length;

  log.success("generate", { mode, ideaCount: ideas.length, successCount });
  sendProgress(`Generated ${ideas.length} ideas from ${successCount} agents`);

  const resultObj = {
    success: successCount > 0,
    topic,
    mode: modeConfig.name,
    ideas,
    total_duration_ms,
    error: successCount === 0 ? "All agents failed" : undefined,
  };

  // Save to history if successful
  if (resultObj.success) {
    const historyContent = `## Ideas (${modeConfig.name})\n\n${ideas.map((idea, i) => `${i + 1}. **[${idea.agent}]** ${idea.content}`).join("\n\n")}`;

    try {
      await saveToolResponse({
        tool: "brainstorm",
        topic,
        content: historyContent,
        tags: ["brainstorm", mode],
        duration_ms: total_duration_ms,
        agents: [...new Set(ideas.map(i => i.agent))],
        extras: { mode, constraints, ideaCount: ideas.length },
      });
    } catch (e) {
      log.warn("Failed to save response to history", e);
    }
  }

  return resultObj;
}

/**
 * Synthesize and combine ideas from a brainstorm session
 *
 * @param args.ideas - Array of ideas to synthesize (from generate())
 * @param args.topic - The original topic
 * @param args.synthesis_type - How to synthesize: "combine" | "rank" | "categorize" | "refine"
 * @param args.timeout_seconds - Timeout (default: 120)
 */
export async function synthesize(args: {
  ideas: Idea[] | string[];
  topic: string;
  synthesis_type?: "combine" | "rank" | "categorize" | "refine";
  timeout_seconds?: number;
}): Promise<{
  success: boolean;
  synthesis: string;
  ranked_ideas?: Array<{ idea: string; score: number; rationale: string }>;
  categories?: Record<string, string[]>;
  total_duration_ms: number;
  error?: string;
}> {
  log.call("synthesize", args);
  const { ideas, topic, synthesis_type = "combine", timeout_seconds = 120 } = args;

  if (!ideas || ideas.length === 0) {
    return { success: false, synthesis: "", total_duration_ms: 0, error: "Ideas are required" };
  }

  const startTime = Date.now();

  // Format ideas for synthesis
  const ideaList = ideas
    .map((idea, i) => {
      if (typeof idea === "string") return `${i + 1}. ${idea}`;
      return `${i + 1}. [${idea.agent}] ${idea.content}`;
    })
    .join("\n");

  let synthesisPrompt: string;

  switch (synthesis_type) {
    case "rank":
      synthesisPrompt = `Topic: ${topic}

Here are brainstormed ideas to evaluate:
${ideaList}

Score each idea from 1-10 on: Feasibility, Innovation, Impact.
Then provide an overall ranking.

Format as:
RANKING:
1. [Idea summary] - Score: X/10 - Rationale: [why]
2. ...

TOP 3 RECOMMENDATIONS:
[Summarize the best ideas and why]`;
      break;

    case "categorize":
      synthesisPrompt = `Topic: ${topic}

Here are brainstormed ideas to categorize:
${ideaList}

Group these ideas into logical categories.

Format as:
CATEGORY: [Name]
- [Idea 1]
- [Idea 2]

CATEGORY: [Name]
...

CROSS-CATEGORY INSIGHTS:
[What patterns emerge across categories?]`;
      break;

    case "refine":
      synthesisPrompt = `Topic: ${topic}

Here are rough brainstormed ideas:
${ideaList}

Refine each idea into a more polished, actionable form.
Combine similar ideas. Remove duplicates. Add missing details.

Format as numbered list of refined ideas.`;
      break;

    case "combine":
    default:
      synthesisPrompt = `Topic: ${topic}

Here are ideas from multiple perspectives:
${ideaList}

TASK: Synthesize these into a cohesive set of recommendations.
1. Identify common themes
2. Combine complementary ideas
3. Resolve contradictions
4. Produce 3-5 actionable recommendations

Format:
THEMES IDENTIFIED:
- [Theme 1]
- [Theme 2]

SYNTHESIZED RECOMMENDATIONS:
1. [Combined recommendation with rationale]
2. ...`;
      break;
  }

  sendProgress(`Synthesizing ${ideas.length} ideas (${synthesis_type})...`);

  // Use Claude for synthesis (best at nuanced reasoning)
  const result = await queryAgent("claude", synthesisPrompt, timeout_seconds * 1000);

  const total_duration_ms = Date.now() - startTime;

  if (!result.success) {
    return {
      success: false,
      synthesis: "",
      total_duration_ms,
      error: result.error,
    };
  }

  log.success("synthesize", { type: synthesis_type });

  return {
    success: true,
    synthesis: result.response || "",
    total_duration_ms,
  };
}

/**
 * Quick brainstorm - generate and synthesize in one call
 *
 * @param args.topic - The topic to brainstorm
 * @param args.mode - Brainstorming mode (default: rapid)
 * @param args.constraints - Optional constraints
 * @param args.auto_synthesize - Whether to auto-synthesize (default: true)
 */
export async function quick(args: {
  topic: string;
  mode?: BrainstormMode;
  constraints?: ConstraintPreset | string;
  auto_synthesize?: boolean;
}): Promise<{
  success: boolean;
  topic: string;
  mode: string;
  ideas: Idea[];
  synthesis?: string;
  total_duration_ms: number;
  error?: string;
}> {
  log.call("quick", args);
  const { topic, mode = "rapid", constraints, auto_synthesize = true } = args;

  const startTime = Date.now();

  // Generate ideas
  const genResult = await generate({ topic, mode, constraints });

  if (!genResult.success || genResult.ideas.length === 0) {
    return {
      success: false,
      topic,
      mode: genResult.mode,
      ideas: [],
      total_duration_ms: Date.now() - startTime,
      error: genResult.error || "No ideas generated",
    };
  }

  // Optionally synthesize
  let synthesis: string | undefined;
  if (auto_synthesize && genResult.ideas.length > 3) {
    const synthResult = await synthesize({
      ideas: genResult.ideas,
      topic,
      synthesis_type: "combine",
    });
    if (synthResult.success) {
      synthesis = synthResult.synthesis;
    }
  }

  return {
    success: true,
    topic,
    mode: genResult.mode,
    ideas: genResult.ideas,
    synthesis,
    total_duration_ms: Date.now() - startTime,
  };
}

/**
 * List available brainstorming modes and constraints
 */
export async function list_modes(): Promise<{
  success: boolean;
  modes: Array<{ key: string; name: string; description: string }>;
  constraints: Array<{ key: string; description: string }>;
}> {
  log.call("list_modes", {});

  const modes = Object.entries(BRAINSTORM_MODES).map(([key, config]) => ({
    key,
    name: config.name,
    description: config.description,
  }));

  const constraints = Object.entries(CONSTRAINT_PRESETS).map(([key, desc]) => ({
    key,
    description: desc,
  }));

  return { success: true, modes, constraints };
}

/**
 * Expand on a specific idea with more detail
 *
 * @param args.idea - The idea to expand
 * @param args.topic - Original topic for context
 * @param args.expansion_type - Type of expansion: "detail" | "implementation" | "variations" | "critique"
 */
export async function expand(args: {
  idea: string;
  topic: string;
  expansion_type?: "detail" | "implementation" | "variations" | "critique";
  timeout_seconds?: number;
}): Promise<{
  success: boolean;
  original_idea: string;
  expansion: string;
  variations?: string[];
  total_duration_ms: number;
  error?: string;
}> {
  log.call("expand", args);
  const { idea, topic, expansion_type = "detail", timeout_seconds = 90 } = args;

  const startTime = Date.now();

  let prompt: string;

  switch (expansion_type) {
    case "implementation":
      prompt = `Topic: ${topic}
Idea: ${idea}

Provide a detailed implementation plan:
1. Concrete steps to implement this
2. Required resources/dependencies
3. Potential challenges and mitigations
4. Success metrics`;
      break;

    case "variations":
      prompt = `Topic: ${topic}
Idea: ${idea}

Generate 5 variations of this idea:
1. A more ambitious version
2. A simpler/minimal version
3. A contrarian/opposite approach
4. A hybrid with another domain
5. A futuristic/moonshot version`;
      break;

    case "critique":
      prompt = `Topic: ${topic}
Idea: ${idea}

Provide constructive critique:
1. Strengths and why it could work
2. Weaknesses and potential failures
3. Missing considerations
4. Suggested improvements
5. Overall assessment`;
      break;

    case "detail":
    default:
      prompt = `Topic: ${topic}
Idea: ${idea}

Expand this idea with more detail:
1. What specifically would this look like?
2. Who benefits and how?
3. What makes this unique?
4. What are the key components?
5. What's the first concrete step?`;
      break;
  }

  sendProgress(`Expanding idea (${expansion_type})...`);

  const result = await queryAgent("gemini", prompt, timeout_seconds * 1000);

  return {
    success: result.success,
    original_idea: idea,
    expansion: result.response || "",
    total_duration_ms: Date.now() - startTime,
    error: result.error,
  };
}

/**
 * Cross-pollinate: Have agents build on each other's ideas
 *
 * @param args.topic - The topic
 * @param args.rounds - Number of build-on rounds (default: 2)
 */
export async function cross_pollinate(args: {
  topic: string;
  rounds?: number;
  timeout_seconds?: number;
}): Promise<{
  success: boolean;
  topic: string;
  evolution: Array<{
    round: number;
    agent: string;
    ideas: string[];
  }>;
  final_synthesis?: string;
  total_duration_ms: number;
  error?: string;
}> {
  log.call("cross_pollinate", args);
  const { topic, rounds = 2, timeout_seconds = 90 } = args;

  const startTime = Date.now();
  const evolution: Array<{ round: number; agent: string; ideas: string[] }> = [];
  const agentOrder: AgentName[] = ["claude", "codex", "gemini"];

  sendProgress(`Cross-pollination: ${rounds} rounds...`);

  // Round 1: Initial ideas from first agent
  let previousIdeas = "";

  for (let round = 1; round <= rounds; round++) {
    sendProgress(`[Round ${round}/${rounds}]`);

    for (const agentKey of agentOrder) {
      const prompt = round === 1 && agentKey === "claude"
        ? `Topic: ${topic}\n\nGenerate 3 creative ideas. Be specific and actionable.`
        : `Topic: ${topic}\n\nPrevious ideas:\n${previousIdeas}\n\nBuild on these ideas. Add 2-3 new ideas that:\n- Combine elements from above\n- Take existing ideas further\n- Fill gaps or address weaknesses`;

      const result = await queryAgent(agentKey, prompt, timeout_seconds * 1000);

      if (result.success && result.response) {
        const ideas = result.response
          .split("\n")
          .filter((line) => /^(\d+[.)]\s*|\*\s*|-\s*)/.test(line.trim()))
          .map((line) => line.replace(/^(\d+[.)]\s*|\*\s*|-\s*)/, "").trim())
          .filter((idea) => idea.length > 10);

        evolution.push({ round, agent: AGENTS[agentKey].name, ideas });
        previousIdeas = ideas.map((i, idx) => `${idx + 1}. ${i}`).join("\n");
      }
    }
  }

  // Final synthesis
  const allIdeas = evolution.flatMap((e) => e.ideas);
  let final_synthesis: string | undefined;

  if (allIdeas.length > 0) {
    const synthResult = await synthesize({
      ideas: allIdeas,
      topic,
      synthesis_type: "combine",
    });
    if (synthResult.success) {
      final_synthesis = synthResult.synthesis;
    }
  }

  return {
    success: evolution.length > 0,
    topic,
    evolution,
    final_synthesis,
    total_duration_ms: Date.now() - startTime,
  };
}
