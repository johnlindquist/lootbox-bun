/**
 * Deep Review Tool - Multi-persona code review using AI council
 *
 * Leverages expert reviewer personas (Fowler, Carmack, Linus, etc.) combined with
 * multi-agent reasoning to provide comprehensive, multi-perspective code reviews.
 *
 * Architecture:
 * 1. Context Analysis: Understand the code/diff being reviewed
 * 2. Persona Selection: Choose relevant reviewer personas based on context
 * 3. Parallel Review: Multiple agents review from different expert perspectives
 * 4. Council Synthesis: Combine insights, identify consensus/disagreements
 * 5. Actionable Output: Prioritized findings with concrete recommendations
 *
 * Use this for:
 * - Comprehensive code reviews requiring multiple perspectives
 * - Architecture decisions needing expert viewpoints
 * - Performance-critical code needing specialized analysis
 * - Complex refactoring decisions
 */

import {
  createLogger,
  type ProgressCallback,
  getCodeMapContext,
  spawnWithTimeout,
} from "./shared/index.ts";
import { saveToolResponse } from "./shared/response_history.ts";
import * as fs from "fs";
import * as path from "path";

const log = createLogger("deep_review");

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

// =============================================================================
// REVIEWER PERSONAS
// =============================================================================

const REVIEWER_PERSONAS = {
  // Architecture & Design
  fowler: {
    name: "Martin Fowler",
    key: "fowler",
    focus: "Refactoring, code smells, evolutionary architecture",
    tags: ["architecture", "refactoring", "design", "patterns", "maintainability"],
    referenceFile: "fowler-reviewer.md",
  },
  grace: {
    name: "Grace Hopper & Barbara Liskov",
    key: "grace",
    focus: "Abstraction integrity, substitutability, modular design",
    tags: ["abstraction", "modularity", "liskov", "solid", "interfaces"],
    referenceFile: "grace-reviewer.md",
  },
  dean: {
    name: "Jeff Dean",
    key: "dean",
    focus: "Planet-scale systems, efficiency, distributed reliability",
    tags: ["distributed", "scale", "systems", "infrastructure", "reliability"],
    referenceFile: "dean-reviewer.md",
  },

  // Performance & Low-Level
  carmack: {
    name: "John Carmack",
    key: "carmack",
    focus: "Low-level excellence, performance optimization, precision thinking",
    tags: ["performance", "optimization", "algorithms", "memory", "cache"],
    referenceFile: "carmack-reviewer.md",
  },
  perf: {
    name: "Brendan Gregg & Liz Rice",
    key: "perf",
    focus: "Observability, tracing, data-first performance analysis",
    tags: ["observability", "tracing", "profiling", "metrics", "debugging"],
    referenceFile: "perf-reviewer.md",
  },
  bjarne: {
    name: "Bjarne Stroustrup",
    key: "bjarne",
    focus: "Performance via abstraction, type safety, disciplined engineering",
    tags: ["cpp", "performance", "abstraction", "types", "engineering"],
    referenceFile: "bjarne-reviewer.md",
  },

  // Systems & Rigor
  linus: {
    name: "Linus Torvalds",
    key: "linus",
    focus: "Kernel-level rigor, patch discipline, brutally honest feedback",
    tags: ["systems", "kernel", "rigor", "simplicity", "correctness"],
    referenceFile: "linus-reviewer.md",
  },
  unix: {
    name: "Unix Traditionalist",
    key: "unix",
    focus: "Small sharp tools, composability, text-first automation",
    tags: ["unix", "cli", "pipes", "composability", "simplicity"],
    referenceFile: "unix-reviewer.md",
  },
  rob: {
    name: "Rob Pike",
    key: "rob",
    focus: "Go/Unix minimalism, concurrency primitives, composable tooling",
    tags: ["go", "concurrency", "simplicity", "unix", "minimalism"],
    referenceFile: "rob-reviewer.md",
  },

  // Type Systems & Languages
  anders: {
    name: "Anders Hejlsberg",
    key: "anders",
    focus: "Strong typing, language/tooling ergonomics, structured APIs",
    tags: ["typescript", "types", "language", "tooling", "api"],
    referenceFile: "anders-reviewer.md",
  },
  lattner: {
    name: "Chris Lattner",
    key: "lattner",
    focus: "Compiler/toolchain innovation, language interoperability, performance",
    tags: ["compiler", "llvm", "swift", "toolchain", "interop"],
    referenceFile: "lattner-reviewer.md",
  },

  // Testing & Practices
  beck: {
    name: "Kent Beck",
    key: "beck",
    focus: "TDD discipline, rapid feedback loops, adaptive design",
    tags: ["testing", "tdd", "xp", "agile", "feedback"],
    referenceFile: "beck-reviewer.md",
  },
  github: {
    name: "GitHub Generation",
    key: "github",
    focus: "Collaboration hygiene, docs, CI/CD automation",
    tags: ["cicd", "automation", "docs", "collaboration", "pr"],
    referenceFile: "github-reviewer.md",
  },

  // Frontend & React
  react: {
    name: "React Core Maintainer",
    key: "react",
    focus: "Hooks, concurrent rendering, DX-focused component patterns",
    tags: ["react", "hooks", "components", "frontend", "state"],
    referenceFile: "react-reviewer.md",
  },
  brendan: {
    name: "Brendan Eich",
    key: "brendan",
    focus: "Rapid innovation, creative problem-solving, pragmatic experimentation",
    tags: ["javascript", "web", "innovation", "pragmatic", "prototyping"],
    referenceFile: "brendan-reviewer.md",
  },

  // Language-Specific
  guido: {
    name: "Guido van Rossum",
    key: "guido",
    focus: "Readability, Pythonic simplicity, pragmatic clarity",
    tags: ["python", "readability", "simplicity", "zen", "pythonic"],
    referenceFile: "guido-reviewer.md",
  },
  matz: {
    name: 'Yukihiro "Matz" Matsumoto',
    key: "matz",
    focus: "Ruby aesthetics, human-centric design, joy in code",
    tags: ["ruby", "aesthetics", "developer-experience", "joy", "human"],
    referenceFile: "matz-reviewer.md",
  },
  james: {
    name: "James Gosling",
    key: "james",
    focus: "JVM portability, API stability, backward compatibility",
    tags: ["java", "jvm", "api", "stability", "compatibility"],
    referenceFile: "james-reviewer.md",
  },

  // Specialized
  dhh: {
    name: "DHH",
    key: "dhh",
    focus: "Opinionated conventions, developer autonomy, simplicity over ceremony",
    tags: ["rails", "conventions", "simplicity", "pragmatic", "web"],
    referenceFile: "dhh-reviewer.md",
  },
  ai: {
    name: "AI Visionaries",
    key: "ai",
    focus: "Adaptive systems, emergent behavior, data-driven design",
    tags: ["ai", "ml", "data", "adaptive", "learning"],
    referenceFile: "ai-reviewer.md",
  },
} as const;

type PersonaKey = keyof typeof REVIEWER_PERSONAS;

// Reference file base path
const REFERENCES_BASE = path.join(
  process.env.HOME || "~",
  ".claude/skills/review/references"
);

// =============================================================================
// AGENT CONFIGURATION
// =============================================================================

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
    args: [
      "-p",
      "--model",
      "opus",
      "--append-system-prompt",
      "You are an expert code reviewer. Be thorough, specific, and actionable.",
      "--output-format",
      "text",
    ],
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

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Load a reviewer persona's reference instructions
 */
async function loadPersonaReference(persona: PersonaKey): Promise<string | null> {
  const personaInfo = REVIEWER_PERSONAS[persona];
  const filePath = path.join(REFERENCES_BASE, personaInfo.referenceFile);

  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    return content;
  } catch (error) {
    log.warn(`Could not load persona reference: ${filePath}`, error);
    return null;
  }
}

/**
 * Select relevant personas based on code context and tags
 */
function selectRelevantPersonas(
  hints: string[],
  maxPersonas: number = 4
): PersonaKey[] {
  const normalizedHints = hints.map((h) => h.toLowerCase().trim());
  const scores: Record<PersonaKey, number> = {} as Record<PersonaKey, number>;

  // Score each persona based on tag matches
  for (const [key, persona] of Object.entries(REVIEWER_PERSONAS)) {
    scores[key as PersonaKey] = 0;
    for (const tag of persona.tags) {
      if (normalizedHints.some((hint) => hint.includes(tag) || tag.includes(hint))) {
        scores[key as PersonaKey] += 2;
      }
    }
    // Partial match on focus description
    for (const hint of normalizedHints) {
      if (persona.focus.toLowerCase().includes(hint)) {
        scores[key as PersonaKey] += 1;
      }
    }
  }

  // Sort by score and take top N
  const sorted = Object.entries(scores)
    .filter(([_, score]) => score > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, maxPersonas)
    .map(([key]) => key as PersonaKey);

  // If no matches, return sensible defaults
  if (sorted.length === 0) {
    return ["fowler", "linus", "beck"];
  }

  return sorted;
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
 * Query an agent for a review
 */
async function queryAgentForReview(
  agentKey: AgentName,
  prompt: string,
  persona: string,
  timeout: number = 180000
): Promise<{
  agent: string;
  persona: string;
  success: boolean;
  review?: string;
  error?: string;
  duration_ms: number;
}> {
  const agent = AGENTS[agentKey];

  log.info(`Querying ${agent.name} as ${persona}...`);
  sendProgress(`[${agent.name}] Reviewing as ${persona}...`);

  const result = await spawnWithTimeout({
    command: agent.command,
    args: [...agent.args, prompt],
    timeoutMs: timeout,
    env: { CI: "true", TERM: "dumb" },
    onProgress: (chars, elapsedMs) => {
      const elapsed = Math.round(elapsedMs / 1000);
      sendProgress(`[${agent.name}/${persona}] Analyzing... (${elapsed}s, ${chars} chars)`);
    },
    progressIntervalMs: 5000,
  });

  if (result.timedOut) {
    return {
      agent: agent.name,
      persona,
      success: false,
      error: `Review timed out after ${timeout / 1000}s`,
      duration_ms: result.durationMs,
    };
  }

  if (!result.success) {
    return {
      agent: agent.name,
      persona,
      success: false,
      error: result.error || result.stderr || `Exit code ${result.exitCode}`,
      duration_ms: result.durationMs,
    };
  }

  let review = result.stdout.trim();
  if (agentKey === "codex") {
    review = parseCodexJsonl(review);
  }

  sendProgress(`[${agent.name}/${persona}] Completed in ${(result.durationMs / 1000).toFixed(1)}s`);

  return {
    agent: agent.name,
    persona,
    success: true,
    review,
    duration_ms: result.durationMs,
  };
}

// =============================================================================
// MAIN REVIEW FUNCTIONS
// =============================================================================

interface ReviewResult {
  success: boolean;
  code_context: string;
  reviews: Array<{
    persona: string;
    agent: string;
    review: string;
  }>;
  synthesis: {
    critical_issues: string[];
    improvements: string[];
    consensus_points: string[];
    disagreements: string[];
    action_items: string[];
  };
  overall_assessment: string;
  methodology: {
    personas_used: string[];
    agents_consulted: string[];
    total_reviews: number;
  };
  total_duration_ms: number;
  error?: string;
}

/**
 * Conduct a comprehensive multi-persona code review
 *
 * This is the main entry point for deep reviews. It:
 * 1. Analyzes the code context to select relevant reviewers
 * 2. Loads persona reference instructions
 * 3. Queries multiple agents with different expert personas
 * 4. Synthesizes all reviews into actionable findings
 *
 * @param args.code - The code or diff to review
 * @param args.context - Additional context (PR description, requirements, etc.)
 * @param args.personas - Optional specific personas to use (auto-selects if not provided)
 * @param args.hints - Keywords to help select personas (e.g., ["performance", "react"])
 * @param args.depth - Review depth: "quick" (2 personas), "standard" (3), "thorough" (5)
 * @param args.focus - Specific focus area for the review
 * @param args.timeout_seconds - Timeout per review (default: 180)
 */
export async function deep_review(args: {
  code: string;
  context?: string;
  personas?: PersonaKey[];
  hints?: string[];
  depth?: "quick" | "standard" | "thorough";
  focus?: string;
  timeout_seconds?: number;
  /** Include codebase structure context (default: true) */
  include_codemap?: boolean;
}): Promise<ReviewResult> {
  log.call("deep_review", { ...args, code: args.code?.substring(0, 100) + "..." });
  const {
    code,
    context,
    personas: explicitPersonas,
    hints = [],
    depth = "standard",
    focus,
    timeout_seconds = 180,
    include_codemap = true,
  } = args;

  if (!code || code.trim().length === 0) {
    return {
      success: false,
      code_context: "",
      reviews: [],
      synthesis: {
        critical_issues: [],
        improvements: [],
        consensus_points: [],
        disagreements: [],
        action_items: [],
      },
      overall_assessment: "",
      methodology: { personas_used: [], agents_consulted: [], total_reviews: 0 },
      total_duration_ms: 0,
      error: "Code to review is required",
    };
  }

  const startTime = Date.now();
  const timeout = timeout_seconds * 1000;

  // Get codebase context if enabled
  let codebaseSection = "";
  if (include_codemap) {
    sendProgress("Loading codebase structure...");
    const codeMapContext = await getCodeMapContext();
    if (codeMapContext) {
      codebaseSection = `\n\n<codebase-structure>\n${codeMapContext}\n</codebase-structure>`;
      log.info(`Loaded code map context (${codeMapContext.length} chars)`);
    }
  }

  // Determine number of personas based on depth
  const personaCounts = { quick: 2, standard: 3, thorough: 5 };
  const numPersonas = personaCounts[depth];

  // Select or use provided personas
  const selectedPersonas =
    explicitPersonas ||
    selectRelevantPersonas(
      [...hints, ...(focus ? [focus] : [])],
      numPersonas
    );

  sendProgress(`Selected reviewers: ${selectedPersonas.map((p) => REVIEWER_PERSONAS[p].name).join(", ")}`);

  // Load persona references
  const personaReferences: Record<string, string> = {};
  for (const persona of selectedPersonas) {
    const ref = await loadPersonaReference(persona);
    if (ref) {
      personaReferences[persona] = ref;
    }
  }

  // Build review context
  const reviewContext = [
    "## Code to Review",
    "```",
    code,
    "```",
    context ? `\n## Additional Context\n${context}` : "",
    focus ? `\n## Focus Area\n${focus}` : "",
    codebaseSection,
  ]
    .filter(Boolean)
    .join("\n");

  // Assign personas to agents (distribute across agents)
  const agentKeys: AgentName[] = ["claude", "codex", "gemini"];
  const reviewPromises: Promise<{
    agent: string;
    persona: string;
    success: boolean;
    review?: string;
    error?: string;
    duration_ms: number;
  }>[] = [];

  selectedPersonas.forEach((persona, index) => {
    const agentKey = agentKeys[index % agentKeys.length];
    const personaInfo = REVIEWER_PERSONAS[persona];
    const personaRef = personaReferences[persona] || "";

    const prompt = `You are conducting a code review as ${personaInfo.name}.

${personaRef}

Focus: ${personaInfo.focus}

---

${reviewContext}

---

**Your Review:**

Provide a thorough code review from your perspective. Include:

1. **Critical Issues** (bugs, security, correctness problems)
2. **Design Concerns** (architecture, patterns, maintainability)
3. **Specific Recommendations** (concrete suggestions with code examples if helpful)
4. **Positive Observations** (what's done well)

Be specific: cite line numbers or code snippets. Be constructive: explain why issues matter and how to fix them.`;

    reviewPromises.push(queryAgentForReview(agentKey, prompt, personaInfo.name, timeout));
  });

  // Execute all reviews in parallel
  sendProgress(`Running ${selectedPersonas.length} parallel reviews...`);
  const reviewResults = await Promise.all(reviewPromises);
  const successfulReviews = reviewResults.filter((r) => r.success);

  if (successfulReviews.length === 0) {
    return {
      success: false,
      code_context: code.substring(0, 200) + "...",
      reviews: [],
      synthesis: {
        critical_issues: [],
        improvements: [],
        consensus_points: [],
        disagreements: [],
        action_items: [],
      },
      overall_assessment: "",
      methodology: {
        personas_used: selectedPersonas,
        agents_consulted: [],
        total_reviews: 0,
      },
      total_duration_ms: Date.now() - startTime,
      error: "All reviews failed",
    };
  }

  // Compile reviews
  const reviews = successfulReviews.map((r) => ({
    persona: r.persona,
    agent: r.agent,
    review: r.review || "",
  }));

  sendProgress(`Completed ${successfulReviews.length}/${reviewResults.length} reviews. Synthesizing...`);

  // Synthesize all reviews
  const synthesisPrompt = `You are synthesizing multiple expert code reviews into a coherent summary.

## Reviews from Different Perspectives

${reviews.map((r) => `### ${r.persona} (via ${r.agent})\n\n${r.review}`).join("\n\n---\n\n")}

---

## Your Task

Analyze all reviews and provide:

1. **Critical Issues** (bullet points)
   - Issues multiple reviewers agree are serious problems
   - Security, correctness, or reliability concerns

2. **Suggested Improvements** (bullet points)
   - Enhancements that would improve code quality
   - Ranked by importance/impact

3. **Consensus Points** (bullet points)
   - What do reviewers agree on?

4. **Disagreements** (bullet points)
   - Where do reviewers have different opinions?
   - Note the tradeoffs involved

5. **Action Items** (bullet points)
   - Concrete next steps, prioritized
   - Each should be specific and actionable

6. **Overall Assessment**
   - A brief summary of the code's quality and readiness
   - Key takeaways for the author`;

  const synthesisResult = await queryAgentForReview(
    "claude",
    synthesisPrompt,
    "Synthesis",
    timeout
  );

  // Parse synthesis into structured data
  const synthesis = {
    critical_issues: [] as string[],
    improvements: [] as string[],
    consensus_points: [] as string[],
    disagreements: [] as string[],
    action_items: [] as string[],
  };

  let overall_assessment = "";

  if (synthesisResult.success && synthesisResult.review) {
    const text = synthesisResult.review;

    const parseBullets = (pattern: string): string[] => {
      const regex = new RegExp(`\\*\\*${pattern}\\*\\*[\\s\\S]*?(?=\\*\\*|$)`, "i");
      const match = text.match(regex);
      if (!match) return [];
      return match[0]
        .split("\n")
        .filter((line) => line.trim().match(/^[-*•]\s/))
        .map((line) => line.replace(/^[-*•]\s*/, "").trim())
        .filter((line) => line.length > 0);
    };

    synthesis.critical_issues = parseBullets("Critical Issues");
    synthesis.improvements = parseBullets("Suggested Improvements");
    synthesis.consensus_points = parseBullets("Consensus Points");
    synthesis.disagreements = parseBullets("Disagreements");
    synthesis.action_items = parseBullets("Action Items");

    const assessmentMatch = text.match(/\*\*Overall Assessment\*\*[\s\S]*$/i);
    if (assessmentMatch) {
      overall_assessment = assessmentMatch[0]
        .replace(/\*\*Overall Assessment\*\*\s*/i, "")
        .trim();
    }
  }

  const total_duration_ms = Date.now() - startTime;
  sendProgress(`Deep review complete in ${(total_duration_ms / 1000).toFixed(1)}s`);

  const result: ReviewResult = {
    success: true,
    code_context: code.substring(0, 500) + (code.length > 500 ? "..." : ""),
    reviews,
    synthesis,
    overall_assessment,
    methodology: {
      personas_used: selectedPersonas,
      agents_consulted: [...new Set(successfulReviews.map((r) => r.agent))],
      total_reviews: reviews.length,
    },
    total_duration_ms,
  };

  // Save to history
  const historyContent = `## Synthesis

${synthesisResult.review || ""}

## Individual Reviews

${reviews.map((r) => `### ${r.persona}\n\n${r.review}`).join("\n\n---\n\n")}`;

  try {
    await saveToolResponse({
      tool: "deep_review",
      topic: `Code review (${selectedPersonas.join(", ")})`,
      content: historyContent,
      query: code.substring(0, 200),
      tags: ["review", depth, ...selectedPersonas],
      duration_ms: total_duration_ms,
      agents: result.methodology.agents_consulted,
      extras: { depth, personas: selectedPersonas },
    });
  } catch (e) {
    log.warn("Failed to save response to history", e);
  }

  return result;
}

/**
 * Quick code review with 2 personas
 *
 * @param args.code - The code to review
 * @param args.hints - Keywords to help select personas
 */
export async function quick_review(args: {
  code: string;
  hints?: string[];
  context?: string;
}): Promise<ReviewResult> {
  log.call("quick_review", { hints: args.hints });
  return deep_review({
    ...args,
    depth: "quick",
    timeout_seconds: 120,
  });
}

/**
 * Focused review from a single expert persona
 *
 * @param args.code - The code to review
 * @param args.persona - The specific reviewer persona to use
 * @param args.context - Additional context
 */
export async function focused_review(args: {
  code: string;
  persona: PersonaKey;
  context?: string;
  focus?: string;
}): Promise<{
  success: boolean;
  persona: string;
  review: string;
  duration_ms: number;
  error?: string;
}> {
  log.call("focused_review", { persona: args.persona });
  const { code, persona, context, focus } = args;

  if (!code) {
    return {
      success: false,
      persona: "",
      review: "",
      duration_ms: 0,
      error: "Code to review is required",
    };
  }

  if (!REVIEWER_PERSONAS[persona]) {
    return {
      success: false,
      persona: persona,
      review: "",
      duration_ms: 0,
      error: `Unknown persona: ${persona}. Use list_reviewers() to see available options.`,
    };
  }

  const startTime = Date.now();
  const personaInfo = REVIEWER_PERSONAS[persona];
  const personaRef = await loadPersonaReference(persona);

  sendProgress(`Getting focused review from ${personaInfo.name}...`);

  const prompt = `You are conducting a detailed code review as ${personaInfo.name}.

${personaRef || ""}

Focus: ${personaInfo.focus}

---

## Code to Review

\`\`\`
${code}
\`\`\`

${context ? `## Additional Context\n${context}` : ""}
${focus ? `## Specific Focus\n${focus}` : ""}

---

**Your Review:**

Provide an in-depth code review from your unique perspective. Be thorough, specific, and actionable.
Include code examples where helpful. Cite specific lines or sections.`;

  const result = await queryAgentForReview("claude", prompt, personaInfo.name, 180000);

  return {
    success: result.success,
    persona: personaInfo.name,
    review: result.review || "",
    duration_ms: Date.now() - startTime,
    error: result.error,
  };
}

/**
 * List all available reviewer personas
 */
export async function list_reviewers(): Promise<{
  success: boolean;
  reviewers: Array<{
    key: string;
    name: string;
    focus: string;
    tags: string[];
  }>;
}> {
  log.call("list_reviewers", {});

  const reviewers = Object.entries(REVIEWER_PERSONAS).map(([key, value]) => ({
    key,
    name: value.name,
    focus: value.focus,
    tags: [...value.tags],
  }));

  return { success: true, reviewers };
}

/**
 * Suggest reviewers based on code characteristics or hints
 *
 * @param args.hints - Keywords describing what you want reviewed
 * @param args.code - Optional code sample to analyze
 * @param args.count - Number of reviewers to suggest (default: 3)
 */
export async function suggest_reviewers(args: {
  hints: string[];
  code?: string;
  count?: number;
}): Promise<{
  success: boolean;
  suggestions: Array<{
    key: string;
    name: string;
    reason: string;
  }>;
}> {
  log.call("suggest_reviewers", { hints: args.hints });
  const { hints, code, count = 3 } = args;

  // Add code-based hints if code is provided
  const allHints = [...hints];
  if (code) {
    // Simple heuristics to detect code characteristics
    if (code.includes("React") || code.includes("useState") || code.includes("jsx")) {
      allHints.push("react", "frontend");
    }
    if (code.includes("async") || code.includes("await") || code.includes("Promise")) {
      allHints.push("async", "concurrency");
    }
    if (code.includes("test") || code.includes("describe") || code.includes("expect")) {
      allHints.push("testing");
    }
    if (code.includes("class") && code.includes("extends")) {
      allHints.push("oop", "inheritance");
    }
    if (code.includes("O(") || code.includes("cache") || code.includes("performance")) {
      allHints.push("performance");
    }
    if (code.includes("type ") || code.includes("interface ") || code.includes(": ")) {
      allHints.push("typescript", "types");
    }
  }

  const selected = selectRelevantPersonas(allHints, count);

  const suggestions = selected.map((key) => ({
    key,
    name: REVIEWER_PERSONAS[key].name,
    reason: `Expertise in: ${REVIEWER_PERSONAS[key].focus}`,
  }));

  return { success: true, suggestions };
}

/**
 * Get a review "council" - all reviewers discuss the same code
 * and then debate/synthesize their findings
 *
 * @param args.code - Code to review
 * @param args.question - Specific question to answer about the code
 * @param args.personas - Which reviewers to include (default: fowler, carmack, linus)
 */
export async function review_council(args: {
  code: string;
  question: string;
  personas?: PersonaKey[];
  context?: string;
}): Promise<{
  success: boolean;
  question: string;
  individual_opinions: Array<{
    persona: string;
    opinion: string;
  }>;
  consensus: string[];
  disagreements: string[];
  final_recommendation: string;
  duration_ms: number;
  error?: string;
}> {
  log.call("review_council", { question: args.question });
  const {
    code,
    question,
    personas = ["fowler", "carmack", "linus"],
    context,
  } = args;

  if (!code || !question) {
    return {
      success: false,
      question: "",
      individual_opinions: [],
      consensus: [],
      disagreements: [],
      final_recommendation: "",
      duration_ms: 0,
      error: "Code and question are required",
    };
  }

  const startTime = Date.now();
  sendProgress(`Convening review council: ${personas.map((p) => REVIEWER_PERSONAS[p].name).join(", ")}...`);

  // Get each persona's opinion
  const agentKeys: AgentName[] = ["claude", "codex", "gemini"];
  const opinionPromises = personas.map((persona, index) => {
    const agentKey = agentKeys[index % agentKeys.length];
    const personaInfo = REVIEWER_PERSONAS[persona];

    const prompt = `You are ${personaInfo.name}, known for: ${personaInfo.focus}

A question has been posed about this code:

## Code
\`\`\`
${code}
\`\`\`

${context ? `## Context\n${context}` : ""}

## Question
${question}

**Your Opinion:**
Provide your expert opinion on this question. Be specific and draw from your unique perspective and expertise.`;

    return queryAgentForReview(agentKey, prompt, personaInfo.name, 120000);
  });

  const opinions = await Promise.all(opinionPromises);
  const successfulOpinions = opinions.filter((o) => o.success);

  if (successfulOpinions.length < 2) {
    return {
      success: false,
      question,
      individual_opinions: [],
      consensus: [],
      disagreements: [],
      final_recommendation: "",
      duration_ms: Date.now() - startTime,
      error: "Not enough successful opinions for council discussion",
    };
  }

  // Synthesize opinions
  sendProgress("Council members deliberating...");

  const synthesisPrompt = `You are moderating a council of expert reviewers discussing this question:

**Question:** ${question}

**Individual Opinions:**

${successfulOpinions.map((o) => `### ${o.persona}\n${o.review}`).join("\n\n---\n\n")}

**Your Task:**

1. **Consensus** (bullet points) - What do the experts agree on?
2. **Disagreements** (bullet points) - Where do opinions differ? Note the tradeoffs.
3. **Final Recommendation** - Given all perspectives, what's the best answer to the question?`;

  const synthesis = await queryAgentForReview("claude", synthesisPrompt, "Council Moderator", 120000);

  // Parse synthesis
  let consensus: string[] = [];
  let disagreements: string[] = [];
  let final_recommendation = "";

  if (synthesis.success && synthesis.review) {
    const text = synthesis.review;

    const parseBullets = (pattern: string): string[] => {
      const regex = new RegExp(`\\*\\*${pattern}\\*\\*[\\s\\S]*?(?=\\*\\*|$)`, "i");
      const match = text.match(regex);
      if (!match) return [];
      return match[0]
        .split("\n")
        .filter((line) => line.trim().match(/^[-*•]\s/))
        .map((line) => line.replace(/^[-*•]\s*/, "").trim())
        .filter((line) => line.length > 0);
    };

    consensus = parseBullets("Consensus");
    disagreements = parseBullets("Disagreements");

    const recMatch = text.match(/\*\*Final Recommendation\*\*[\s\S]*$/i);
    if (recMatch) {
      final_recommendation = recMatch[0]
        .replace(/\*\*Final Recommendation\*\*\s*/i, "")
        .trim();
    }
  }

  return {
    success: true,
    question,
    individual_opinions: successfulOpinions.map((o) => ({
      persona: o.persona,
      opinion: o.review || "",
    })),
    consensus,
    disagreements,
    final_recommendation,
    duration_ms: Date.now() - startTime,
  };
}
