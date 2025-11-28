/**
 * Enhanced Deep Research Tool with Improved Startup, Observability, and Error Handling
 *
 * This is an example of how to integrate the new error handling, progress indication,
 * and startup validation modules into the deep_research tool.
 */

import {
  createLogger,
  extractErrorMessage,
  type ProgressCallback,
  spawnWithTimeout,
  getCodeMapContext
} from "./shared/index.ts";
import { saveToolResponse } from "./shared/response_history.ts";
import {
  enhanceError,
  formatErrorForUser,
  withRetry,
  performHealthCheck
} from "./shared/error-handler.ts";
import {
  ProgressManager,
  ProgressTemplates,
  withProgress
} from "./shared/progress-indicator.ts";
import {
  validateStartup,
  formatValidationResults
} from "./shared/startup-validator.ts";

const log = createLogger("deep_research_enhanced");

// ============================================================================
// ENHANCED MAIN FUNCTION WITH STARTUP VALIDATION
// ============================================================================

export async function deep_research(args: {
  topic: string;
  default: string;
  depth?: "quick" | "standard" | "thorough";
  focus?: string;
  include_gaps?: boolean;
  include_codemap?: boolean;
  timeout_seconds?: number;
  setProgressCallback?: (callback: ProgressCallback | null) => void;
}): Promise<any> {
  const startTime = Date.now();

  // Set up progress manager
  const progress = new ProgressManager(
    args.setProgressCallback ? (msg) => args.setProgressCallback!((_) => msg) : undefined
  );

  try {
    // Step 1: Startup Validation
    progress.startOperation("Startup Validation", ["Checking prerequisites", "Validating environment"]);

    const validation = await validateStartup("deep_research", true);

    if (!validation.valid) {
      const errorMessage = formatValidationResults(validation);
      log.error("Startup validation failed", validation);

      // Create enhanced error
      const enhanced = enhanceError(
        new Error("Startup validation failed"),
        {
          tool: "deep_research",
          operation: "startup",
          input: args
        }
      );

      // Add validation-specific recommendations
      enhanced.actionableSteps = [
        ...validation.recommendations,
        ...enhanced.actionableSteps
      ];

      throw new Error(formatErrorForUser(enhanced));
    }

    progress.completeStep(0, "Prerequisites validated");
    progress.completeStep(1, "Environment ready");

    // Step 2: Begin actual research with progress tracking
    const depth = args.depth || "standard";
    const steps = ProgressTemplates.deepResearch[depth];

    progress.startOperation(`Deep Research: ${args.topic}`, steps);

    // Step 3: Query expansion with retry
    progress.startStep("Expanding search queries");

    const expandedQueries = await withRetry(
      async () => {
        return await expandTopicToQueries(args.topic, getNumAngles(depth));
      },
      {
        maxAttempts: 3,
        onRetry: (attempt, delay) => {
          progress.sendMessage(`Retrying query expansion (attempt ${attempt})...`);
        }
      }
    );

    progress.completeStep("Expanding search queries", `Generated ${expandedQueries.angles.length} search angles`);

    // Step 4: Parallel searches with progress
    progress.startStep("Running parallel searches");

    const searchResults = await runParallelSearches(
      expandedQueries.angles,
      args.focus,
      (completed, total) => {
        const percent = Math.round((completed / total) * 100);
        progress.updateProgress(percent, `Completed ${completed}/${total} searches`);
      }
    );

    progress.completeStep("Running parallel searches", `${searchResults.filter(r => r.success).length} successful searches`);

    // Step 5: Synthesis with multi-agent analysis
    if (steps.includes("Initial synthesis")) {
      progress.startStep("Initial synthesis");

      const synthesis = await synthesizeFindings(
        searchResults,
        args.topic,
        (agent) => {
          progress.sendMessage(`Consulting ${agent}...`);
        }
      );

      progress.completeStep("Initial synthesis", "Combined findings from multiple sources");
    }

    // Step 6: Gap analysis (if enabled)
    let gaps: string[] = [];
    if (args.include_gaps !== false && depth !== "quick") {
      progress.startStep("Identifying knowledge gaps");

      gaps = await identifyKnowledgeGaps(searchResults, args.topic);

      progress.completeStep("Identifying knowledge gaps", `Found ${gaps.length} gaps to explore`);

      // Step 7: Follow-up research
      if (gaps.length > 0) {
        progress.startStep("Gap follow-up research");

        const gapResults = await runGapResearch(
          gaps.slice(0, 2), // Top 2 gaps
          args.topic,
          (completed, total) => {
            const percent = Math.round((completed / total) * 100);
            progress.updateProgress(percent, `Researched ${completed}/${total} gaps`);
          }
        );

        searchResults.push(...gapResults);

        progress.completeStep("Gap follow-up research", "Filled knowledge gaps");
      }
    }

    // Step 8: Final synthesis
    progress.startStep("Final synthesis");

    const finalResult = await generateFinalReport(
      searchResults,
      args.topic,
      gaps,
      args.focus
    );

    progress.completeStep("Final synthesis", "Report generated");

    // Add metadata
    finalResult.metadata = {
      ...finalResult.metadata,
      duration_ms: Date.now() - startTime,
      depth,
      validation: validation.valid
    };

    // Complete operation
    const summary = `Researched "${args.topic}" with ${searchResults.length} searches, ${gaps.length} gaps identified`;
    progress.complete(summary);

    // Save response
    await saveToolResponse("deep_research", args, finalResult);

    return finalResult;

  } catch (error) {
    // Enhanced error handling
    const enhanced = enhanceError(error, {
      tool: "deep_research",
      operation: "research",
      input: args
    });

    const userMessage = formatErrorForUser(enhanced);

    progress.fail(userMessage);

    // Log detailed error
    log.error("Deep research failed", {
      error: extractErrorMessage(error),
      enhanced,
      args
    });

    // Run health check for diagnostics
    const health = await performHealthCheck("deep_research");
    if (!health.healthy && health.recommendations) {
      log.info("Health check recommendations:", health.recommendations);
    }

    throw new Error(userMessage);
  }
}

// ============================================================================
// HELPER FUNCTIONS (simplified examples)
// ============================================================================

function getNumAngles(depth: string): number {
  switch (depth) {
    case "quick": return 3;
    case "thorough": return 8;
    default: return 5;
  }
}

async function expandTopicToQueries(topic: string, numAngles: number): Promise<any> {
  // Implementation would go here
  return {
    original: topic,
    angles: Array(numAngles).fill(0).map((_, i) => ({
      angle: `Angle ${i + 1}`,
      query: `${topic} perspective ${i + 1}`,
      rationale: "Important perspective"
    }))
  };
}

async function runParallelSearches(
  angles: any[],
  focus: string | undefined,
  onProgress: (completed: number, total: number) => void
): Promise<any[]> {
  const results: any[] = [];
  let completed = 0;

  // Simulated parallel execution
  for (const angle of angles) {
    // In real implementation, these would run in parallel
    results.push({
      query: angle.query,
      success: true,
      content: `Search results for ${angle.query}`
    });

    completed++;
    onProgress(completed, angles.length);

    // Small delay to simulate work
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return results;
}

async function synthesizeFindings(
  results: any[],
  topic: string,
  onAgent: (agent: string) => void
): Promise<any> {
  // Simulate multi-agent synthesis
  for (const agent of ["Claude", "Gemini"]) {
    onAgent(agent);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return {
    synthesis: "Combined findings from all searches",
    agents_used: ["Claude", "Gemini"]
  };
}

async function identifyKnowledgeGaps(results: any[], topic: string): Promise<string[]> {
  // Simulated gap identification
  return [
    "Implementation details missing",
    "Performance metrics not found"
  ];
}

async function runGapResearch(
  gaps: string[],
  topic: string,
  onProgress: (completed: number, total: number) => void
): Promise<any[]> {
  const results: any[] = [];
  let completed = 0;

  for (const gap of gaps) {
    results.push({
      query: gap,
      success: true,
      content: `Gap research for ${gap}`
    });

    completed++;
    onProgress(completed, gaps.length);

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return results;
}

async function generateFinalReport(
  results: any[],
  topic: string,
  gaps: string[],
  focus?: string
): Promise<any> {
  return {
    success: true,
    topic,
    summary: "Executive summary of research findings",
    sections: [
      { title: "Overview", content: "..." },
      { title: "Key Findings", content: "..." }
    ],
    key_findings: ["Finding 1", "Finding 2"],
    knowledge_gaps: gaps,
    recommendations: ["Recommendation 1"],
    metadata: {
      queries_executed: results.length,
      sources_analyzed: results.filter(r => r.success).length
    }
  };
}

// ============================================================================
// EXPORT ENHANCED VERSION
// ============================================================================

export default {
  deep_research,
  // Export sub-functions for testing
  validateStartup: () => validateStartup("deep_research"),
  performHealthCheck: () => performHealthCheck("deep_research")
};