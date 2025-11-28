/**
 * Pipeline Tool - Pre-built Tool Chains
 *
 * Provides ready-to-use pipelines that compose multiple tools.
 * Also exposes the chain runner for custom pipelines.
 */

import { createLogger, type ProgressCallback, runChain, chain, type ChainConfig, type ChainResult } from "./shared/index.ts";

const log = createLogger("pipeline");

let globalProgressCallback: ProgressCallback | null = null;

export function setProgressCallback(callback: ProgressCallback | null): void {
  globalProgressCallback = callback;
}

function sendProgress(message: string): void {
  if (globalProgressCallback) {
    globalProgressCallback(message);
  }
}

// ============== Pre-built Pipelines ==============

/**
 * Research and Summarize Pipeline
 *
 * Runs deep research on a topic, then uses Gemini to create a summary.
 *
 * @param args.topic - Topic to research
 * @param args.summary_length - Length of summary: "brief" | "detailed" (default: "detailed")
 */
export async function research_and_summarize(args: {
  topic: string;
  summary_length?: "brief" | "detailed";
}): Promise<ChainResult> {
  log.call("research_and_summarize", args);
  const { topic, summary_length = "detailed" } = args;

  const result = await runChain(
    {
      steps: [
        {
          tool: "deep_research",
          method: "research",
          name: "Research",
          args: {
            topic,
            max_searches: summary_length === "brief" ? 3 : 6,
          },
        },
        {
          tool: "gemini",
          method: "query",
          name: "Summarize",
          args: (prev) => ({
            prompt: `Create a ${summary_length} summary of this research:\n\n${JSON.stringify(prev.output, null, 2)}`,
          }),
        },
      ],
      onStepComplete: (step, total, result) => {
        sendProgress(`[Pipeline] Completed step ${step + 1}/${total}: ${result.metadata.tool}`);
      },
    },
    topic,
    globalProgressCallback ?? undefined
  );

  log.success("research_and_summarize", { success: result.success });
  return result;
}

/**
 * Multi-Agent Analysis Pipeline
 *
 * Gets perspectives from multiple AI agents in parallel, then synthesizes.
 *
 * @param args.question - Question to analyze
 * @param args.agents - Agents to query (default: ["claude", "codex", "gemini"])
 */
export async function multi_agent_analysis(args: {
  question: string;
  agents?: ("claude" | "codex" | "gemini")[];
}): Promise<ChainResult> {
  log.call("multi_agent_analysis", args);
  const { question, agents = ["claude", "codex", "gemini"] } = args;

  // Build parallel steps for each agent
  const agentSteps = agents.map((agent, idx) => ({
    tool: "council",
    method: "query_single",
    name: `Query ${agent}`,
    args: {
      agent,
      question,
    },
  }));

  const result = await runChain(
    {
      steps: [
        ...agentSteps,
        {
          tool: "gemini",
          method: "query",
          name: "Synthesize",
          args: (prev) => ({
            prompt: `Synthesize these ${agents.length} AI perspectives into a unified analysis:\n\n${JSON.stringify(prev.output, null, 2)}`,
          }),
        },
      ],
      // Run all agent queries in parallel
      parallel: [agents.map((_, i) => i)],
      onStepComplete: (step, total, result) => {
        sendProgress(`[Pipeline] Completed step ${step + 1}/${total}: ${result.metadata.tool}`);
      },
    },
    question,
    globalProgressCallback ?? undefined
  );

  log.success("multi_agent_analysis", { success: result.success });
  return result;
}

/**
 * Code Review Pipeline
 *
 * Analyzes code with deep thinking, then gets expert review perspectives.
 *
 * @param args.code - Code to review
 * @param args.focus - What to focus on: "security" | "performance" | "architecture" | "all"
 */
export async function code_review_pipeline(args: {
  code: string;
  focus?: "security" | "performance" | "architecture" | "all";
}): Promise<ChainResult> {
  log.call("code_review_pipeline", args);
  const { code, focus = "all" } = args;

  const result = await runChain(
    {
      steps: [
        {
          tool: "deep_think",
          method: "analyze",
          name: "Deep Analysis",
          args: {
            problem: `Analyze this code for ${focus === "all" ? "security, performance, and architecture" : focus} issues:\n\n${code}`,
            frameworks: ["systematic", "critical"],
          },
        },
        {
          tool: "deep_review",
          method: "review",
          name: "Expert Review",
          args: (prev) => ({
            code,
            context: `Previous analysis findings: ${JSON.stringify(prev.output)}`,
            reviewers: focus === "security"
              ? ["security"]
              : focus === "performance"
              ? ["carmack"]
              : ["fowler", "linus"],
          }),
          onError: "continue", // Don't fail if deep_review isn't available
        },
      ],
      onStepComplete: (step, total, result) => {
        sendProgress(`[Pipeline] Completed step ${step + 1}/${total}: ${result.metadata.tool}`);
      },
    },
    code,
    globalProgressCallback ?? undefined
  );

  log.success("code_review_pipeline", { success: result.success });
  return result;
}

// ============== Custom Pipeline Execution ==============

/**
 * Run a custom pipeline from a configuration
 *
 * @param args.config - Pipeline configuration (steps, parallel groups, etc.)
 * @param args.input - Initial input to pass to the first step
 */
export async function run_custom(args: {
  config: ChainConfig;
  input?: unknown;
}): Promise<ChainResult> {
  log.call("run_custom", { stepCount: args.config.steps.length });

  const result = await runChain(
    {
      ...args.config,
      onStepComplete: (step, total, result) => {
        sendProgress(`[Pipeline] Completed step ${step + 1}/${total}: ${result.metadata.tool}`);
        args.config.onStepComplete?.(step, total, result);
      },
    },
    args.input,
    globalProgressCallback ?? undefined
  );

  log.success("run_custom", { success: result.success });
  return result;
}

/**
 * List available pre-built pipelines
 */
export async function list_pipelines(): Promise<{
  success: boolean;
  pipelines: Array<{
    name: string;
    description: string;
    parameters: string[];
  }>;
}> {
  log.call("list_pipelines", {});

  return {
    success: true,
    pipelines: [
      {
        name: "research_and_summarize",
        description: "Deep research on a topic, then summarize with Gemini",
        parameters: ["topic: string", "summary_length?: 'brief' | 'detailed'"],
      },
      {
        name: "multi_agent_analysis",
        description: "Query multiple AI agents in parallel, then synthesize",
        parameters: ["question: string", "agents?: ('claude' | 'codex' | 'gemini')[]"],
      },
      {
        name: "code_review_pipeline",
        description: "Deep analysis + expert code review",
        parameters: ["code: string", "focus?: 'security' | 'performance' | 'architecture' | 'all'"],
      },
      {
        name: "run_custom",
        description: "Run a custom pipeline configuration",
        parameters: ["config: ChainConfig", "input?: unknown"],
      },
    ],
  };
}
