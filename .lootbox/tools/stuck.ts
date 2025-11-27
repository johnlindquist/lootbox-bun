/**
 * Stuck Tool - Maximum effort problem solving when you're blocked
 *
 * This tool orchestrates multiple AI capabilities in parallel to provide
 * comprehensive help when you're stuck on an issue:
 *
 * 1. Deep Reasoning - Gemini Pro analyzes the problem systematically
 * 2. Web Research - Searches for solutions, documentation, similar issues
 * 3. Multi-Agent Council - Gets perspectives from Claude, Codex, and Gemini
 * 4. Code Analysis - Analyzes relevant files for context (if provided)
 * 5. Library Documentation - Queries DeepWiki for framework/library help (if applicable)
 *
 * Use this when you're truly stuck and need maximum AI firepower to break through.
 */

import { createLogger, extractErrorMessage, type ProgressCallback } from "./shared/index.ts";

const log = createLogger("stuck");

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

// Import the tools we'll orchestrate
import * as gemini from "./gemini.ts";
import * as council from "./council.ts";
import * as deepwiki from "./deepwiki.ts";

// Forward progress callbacks to child tools
function setupChildProgress() {
  gemini.setProgressCallback((msg) => sendProgress(`[Gemini] ${msg}`));
  council.setProgressCallback((msg) => sendProgress(`[Council] ${msg}`));
}

interface StuckInput {
  /** Describe what you're stuck on - be as detailed as possible */
  problem: string;
  /** Optional: File paths to analyze for context */
  file_paths?: string[];
  /** Optional: Library/framework name to look up (e.g., "react", "express") */
  library?: string;
  /** Optional: Repository for deepwiki lookup (e.g., "facebook/react") */
  repo?: string;
  /** Optional: Error message or stack trace if applicable */
  error_message?: string;
  /** Optional: What you've already tried */
  attempted_solutions?: string[];
  /** Optional: Skip certain analyses (council, research, deepwiki, code_analysis) */
  skip?: string[];
  /** Timeout per operation in seconds (default: 180) */
  timeout_seconds?: number;
}

interface AnalysisResult {
  source: string;
  success: boolean;
  content?: string;
  error?: string;
  duration_ms: number;
}

interface StuckResult {
  success: boolean;
  problem: string;
  /** Synthesized recommendations from all analyses */
  recommendations: string;
  /** Individual analysis results */
  analyses: {
    reasoning?: AnalysisResult;
    research?: AnalysisResult;
    council?: AnalysisResult;
    code_analysis?: AnalysisResult;
    deepwiki?: AnalysisResult;
  };
  /** Summary of what was found */
  summary: string;
  /** Suggested next steps */
  next_steps: string[];
  /** Total time taken */
  total_duration_ms: number;
  error?: string;
}

/**
 * Maximum effort problem-solving when you're stuck.
 * Runs multiple AI analyses in parallel and synthesizes actionable recommendations.
 */
export async function unstuck(args: StuckInput): Promise<StuckResult> {
  log.call("unstuck", { ...args, file_paths: args.file_paths?.length });
  const startTime = Date.now();

  setupChildProgress();
  sendProgress("Starting comprehensive analysis...");

  const {
    problem,
    file_paths = [],
    library,
    repo,
    error_message,
    attempted_solutions = [],
    skip = [],
    timeout_seconds = 180,
  } = args;

  if (!problem || problem.trim().length === 0) {
    return {
      success: false,
      problem: "",
      recommendations: "",
      analyses: {},
      summary: "",
      next_steps: [],
      total_duration_ms: 0,
      error: "Problem description is required",
    };
  }

  // Build enriched problem context
  let enrichedProblem = problem;
  if (error_message) {
    enrichedProblem += `\n\nError message:\n\`\`\`\n${error_message}\n\`\`\``;
  }
  if (attempted_solutions.length > 0) {
    enrichedProblem += `\n\nWhat I've already tried:\n${attempted_solutions.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
  }

  const analyses: StuckResult["analyses"] = {};
  const promises: Promise<void>[] = [];

  // 1. Deep Reasoning Analysis
  if (!skip.includes("reasoning")) {
    sendProgress("Starting deep reasoning analysis...");
    promises.push(
      (async () => {
        const start = Date.now();
        try {
          const result = await gemini.reason_through({
            problem: enrichedProblem,
            file_paths: file_paths.length > 0 ? file_paths : undefined,
            constraints: [
              "Focus on root cause analysis",
              "Consider common pitfalls and edge cases",
              "Provide specific, actionable solutions",
            ],
          });
          analyses.reasoning = {
            source: "Gemini Deep Reasoning",
            success: result.success,
            content: result.reasoning,
            error: result.error,
            duration_ms: Date.now() - start,
          };
        } catch (error) {
          analyses.reasoning = {
            source: "Gemini Deep Reasoning",
            success: false,
            error: extractErrorMessage(error),
            duration_ms: Date.now() - start,
          };
        }
      })()
    );
  }

  // 2. Web Research
  if (!skip.includes("research")) {
    sendProgress("Starting web research...");
    promises.push(
      (async () => {
        const start = Date.now();
        try {
          // Create a search-optimized query
          const searchQuery = library
            ? `${library} ${problem.slice(0, 100)}`
            : problem.slice(0, 150);

          const result = await gemini.web_search({
            query: searchQuery,
            focus: "technical",
          });
          analyses.research = {
            source: "Web Research",
            success: result.success,
            content: result.results,
            error: result.error,
            duration_ms: Date.now() - start,
          };
        } catch (error) {
          analyses.research = {
            source: "Web Research",
            success: false,
            error: extractErrorMessage(error),
            duration_ms: Date.now() - start,
          };
        }
      })()
    );
  }

  // 3. Multi-Agent Council
  if (!skip.includes("council")) {
    sendProgress("Consulting the council (Claude, Codex, Gemini)...");
    promises.push(
      (async () => {
        const start = Date.now();
        try {
          const councilQuestion = `I'm stuck on this problem and need your help:

${enrichedProblem}

Please provide:
1. Your analysis of what might be going wrong
2. Specific solutions to try (in order of likelihood)
3. Key things to check or debug
4. Common mistakes that cause this issue`;

          const result = await council.ask({
            question: councilQuestion,
            timeout_seconds,
            include_summary: true,
            role_preset: "software",
          });

          if (result.success) {
            // Format council responses
            const formatted = result.responses
              .filter((r) => r.success)
              .map((r) => `### ${r.agent}\n${r.response}`)
              .join("\n\n---\n\n");

            analyses.council = {
              source: "Multi-Agent Council",
              success: true,
              content: formatted,
              duration_ms: Date.now() - start,
            };
          } else {
            analyses.council = {
              source: "Multi-Agent Council",
              success: false,
              error: result.error,
              duration_ms: Date.now() - start,
            };
          }
        } catch (error) {
          analyses.council = {
            source: "Multi-Agent Council",
            success: false,
            error: extractErrorMessage(error),
            duration_ms: Date.now() - start,
          };
        }
      })()
    );
  }

  // 4. Code Analysis (if files provided)
  if (!skip.includes("code_analysis") && file_paths.length > 0) {
    sendProgress(`Analyzing ${file_paths.length} code file(s)...`);
    promises.push(
      (async () => {
        const start = Date.now();
        try {
          const result = await gemini.analyze_project({
            file_paths,
            question: `Given this problem: "${problem}"

Analyze the code for:
1. Potential bugs or issues that could cause this problem
2. Logic errors or edge cases
3. Missing error handling
4. Configuration or setup issues
5. Any anti-patterns or code smells`,
            focus: "debugging",
          });
          analyses.code_analysis = {
            source: "Code Analysis",
            success: result.success,
            content: result.analysis,
            error: result.error,
            duration_ms: Date.now() - start,
          };
        } catch (error) {
          analyses.code_analysis = {
            source: "Code Analysis",
            success: false,
            error: extractErrorMessage(error),
            duration_ms: Date.now() - start,
          };
        }
      })()
    );
  }

  // 5. DeepWiki Library Lookup (if library/repo specified)
  if (!skip.includes("deepwiki") && (library || repo)) {
    const repoName = repo || inferRepo(library || "");
    if (repoName) {
      sendProgress(`Looking up ${repoName} documentation...`);
      promises.push(
        (async () => {
          const start = Date.now();
          try {
            const result = await deepwiki.ask_question({
              repo_name: repoName,
              question: `How do I solve this problem: ${problem}`,
            });
            analyses.deepwiki = {
              source: `DeepWiki (${repoName})`,
              success: result.success,
              content: result.answer,
              error: result.error,
              duration_ms: Date.now() - start,
            };
          } catch (error) {
            analyses.deepwiki = {
              source: `DeepWiki (${repoName})`,
              success: false,
              error: extractErrorMessage(error),
              duration_ms: Date.now() - start,
            };
          }
        })()
      );
    }
  }

  // Wait for all analyses to complete
  sendProgress(`Running ${promises.length} analyses in parallel...`);
  await Promise.all(promises);

  // Synthesize results
  sendProgress("Synthesizing results...");
  const synthesis = synthesizeResults(problem, analyses);

  const total_duration_ms = Date.now() - startTime;

  log.success("unstuck", {
    analyses_run: Object.keys(analyses).length,
    successful: Object.values(analyses).filter(a => a?.success).length,
    total_duration_ms
  });

  sendProgress(`Analysis complete in ${(total_duration_ms / 1000).toFixed(1)}s`);

  return {
    success: true,
    problem,
    recommendations: synthesis.recommendations,
    analyses,
    summary: synthesis.summary,
    next_steps: synthesis.nextSteps,
    total_duration_ms,
  };
}

/**
 * Quick unstuck - faster analysis with just reasoning and research
 */
export async function quick_unstuck(args: {
  problem: string;
  error_message?: string;
  library?: string;
}): Promise<StuckResult> {
  return unstuck({
    ...args,
    skip: ["council", "code_analysis", "deepwiki"],
    timeout_seconds: 60,
  });
}

/**
 * Code-focused unstuck - emphasizes code analysis and council
 */
export async function code_unstuck(args: {
  problem: string;
  file_paths: string[];
  error_message?: string;
}): Promise<StuckResult> {
  return unstuck({
    ...args,
    skip: ["deepwiki"],
    timeout_seconds: 180,
  });
}

/**
 * Library-focused unstuck - emphasizes deepwiki and research
 */
export async function library_unstuck(args: {
  problem: string;
  library: string;
  repo?: string;
  error_message?: string;
}): Promise<StuckResult> {
  return unstuck({
    ...args,
    skip: ["code_analysis"],
    timeout_seconds: 180,
  });
}

// Helper to infer repo from library name
function inferRepo(library: string): string | null {
  const known: Record<string, string> = {
    react: "facebook/react",
    "react-dom": "facebook/react",
    next: "vercel/next.js",
    nextjs: "vercel/next.js",
    "next.js": "vercel/next.js",
    vue: "vuejs/vue",
    angular: "angular/angular",
    svelte: "sveltejs/svelte",
    express: "expressjs/express",
    fastify: "fastify/fastify",
    nest: "nestjs/nest",
    nestjs: "nestjs/nest",
    prisma: "prisma/prisma",
    drizzle: "drizzle-team/drizzle-orm",
    typeorm: "typeorm/typeorm",
    mongoose: "Automattic/mongoose",
    zod: "colinhacks/zod",
    trpc: "trpc/trpc",
    tanstack: "TanStack/query",
    "react-query": "TanStack/query",
    tailwind: "tailwindlabs/tailwindcss",
    tailwindcss: "tailwindlabs/tailwindcss",
    vite: "vitejs/vite",
    esbuild: "evanw/esbuild",
    webpack: "webpack/webpack",
    bun: "oven-sh/bun",
    deno: "denoland/deno",
    typescript: "microsoft/TypeScript",
    eslint: "eslint/eslint",
    prettier: "prettier/prettier",
    jest: "jestjs/jest",
    vitest: "vitest-dev/vitest",
    playwright: "microsoft/playwright",
    cypress: "cypress-io/cypress",
    puppeteer: "puppeteer/puppeteer",
    axios: "axios/axios",
    lodash: "lodash/lodash",
    dayjs: "iamkun/dayjs",
    luxon: "moment/luxon",
    redis: "redis/redis",
    postgres: "postgres/postgres",
    sqlite: "nicedoc/sqlite",
    docker: "moby/moby",
    kubernetes: "kubernetes/kubernetes",
    terraform: "hashicorp/terraform",
    supabase: "supabase/supabase",
    firebase: "firebase/firebase-js-sdk",
    aws: "aws/aws-sdk-js-v3",
    stripe: "stripe/stripe-node",
    clerk: "clerkinc/javascript",
    auth0: "auth0/auth0.js",
    socket: "socketio/socket.io",
    "socket.io": "socketio/socket.io",
    graphql: "graphql/graphql-js",
    apollo: "apollographql/apollo-client",
    urql: "urql-graphql/urql",
    remix: "remix-run/remix",
    astro: "withastro/astro",
    nuxt: "nuxt/nuxt",
    solid: "solidjs/solid",
    qwik: "QwikDev/qwik",
    hono: "honojs/hono",
    elysia: "elysiajs/elysia",
  };

  const normalized = library.toLowerCase().replace(/[^a-z0-9]/g, "");
  return known[normalized] || known[library.toLowerCase()] || null;
}

// Synthesize all analysis results into recommendations
function synthesizeResults(
  problem: string,
  analyses: StuckResult["analyses"]
): { summary: string; recommendations: string; nextSteps: string[] } {
  const successfulAnalyses = Object.entries(analyses)
    .filter(([, a]) => a?.success && a?.content)
    .map(([key, a]) => ({ key, ...a! }));

  if (successfulAnalyses.length === 0) {
    return {
      summary: "All analyses failed. Check your network connection and try again.",
      recommendations: "Unable to generate recommendations due to analysis failures.",
      nextSteps: [
        "Check network connectivity",
        "Verify API keys are configured",
        "Try again with simpler problem description",
      ],
    };
  }

  // Build summary
  const summaryParts = [
    `Analyzed your problem using ${successfulAnalyses.length} different approaches:`,
    ...successfulAnalyses.map((a) => `- ${a.source}: ${a.duration_ms}ms`),
  ];

  // Extract key insights from each analysis
  const allContent = successfulAnalyses.map((a) => `## ${a.source}\n${a.content}`).join("\n\n---\n\n");

  // Build recommendations section
  const recommendations = `# Analysis Results for: "${problem.slice(0, 100)}${problem.length > 100 ? "..." : ""}"

${allContent}

---

## Synthesized Approach

Based on the combined analyses above, focus on:
1. The solutions that appear in multiple analyses
2. The root causes identified by deep reasoning
3. Documentation and best practices from library lookups
4. Specific code issues identified in code analysis`;

  // Extract action items
  const nextSteps: string[] = [];

  if (analyses.reasoning?.content) {
    nextSteps.push("Review the deep reasoning analysis for root cause understanding");
  }
  if (analyses.council?.content) {
    nextSteps.push("Compare perspectives from the council - look for consensus recommendations");
  }
  if (analyses.research?.content) {
    nextSteps.push("Check the web research for similar issues and proven solutions");
  }
  if (analyses.code_analysis?.content) {
    nextSteps.push("Examine the code analysis for specific issues to fix");
  }
  if (analyses.deepwiki?.content) {
    nextSteps.push("Review the library documentation for proper usage patterns");
  }
  nextSteps.push("If still stuck, narrow down the problem and run again with more specific details");

  return {
    summary: summaryParts.join("\n"),
    recommendations,
    nextSteps,
  };
}
