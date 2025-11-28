/**
 * Tool Chaining - Declarative Pipeline Execution
 *
 * Enables composing tools into pipelines with:
 * - Sequential or parallel execution
 * - Data flow between steps (output → input mapping)
 * - Error handling (fail-fast, continue, retry)
 * - Observable progress via callbacks
 *
 * Example:
 * ```typescript
 * await runChain({
 *   steps: [
 *     { tool: 'deep_research', method: 'research', args: { topic: 'AI safety' } },
 *     { tool: 'gemini', method: 'query', args: (prev) => ({ prompt: prev.output.synthesis }) },
 *   ]
 * }, null, progressCallback);
 * ```
 */

import { createLogger, type ProgressCallback } from "./index.ts";

const log = createLogger("chain");

// ============== Types ==============

export interface StepResult<T = unknown> {
  /** The output data from the step */
  output: T;
  /** Metadata about the step execution */
  metadata: {
    tool: string;
    method: string;
    durationMs: number;
    error?: string;
  };
}

export type ErrorStrategy = "fail" | "continue" | "retry";

export interface ChainStep<TInput = unknown, TOutput = unknown> {
  /** Tool namespace (e.g., 'gemini', 'deep_research') */
  tool: string;
  /** Method to call on the tool (defaults to first exported function) */
  method?: string;
  /** Arguments - static object or function that receives previous result */
  args: Record<string, unknown> | ((prev: StepResult<TInput>) => Record<string, unknown>);
  /** Error handling strategy (default: 'fail') */
  onError?: ErrorStrategy;
  /** Max retries when onError is 'retry' (default: 3) */
  maxRetries?: number;
  /** Transform the output before passing to next step */
  transform?: (result: TOutput) => unknown;
  /** Optional name for debugging */
  name?: string;
}

export interface ChainConfig {
  /** Steps to execute in order */
  steps: ChainStep[];
  /** Indices of steps to run in parallel (e.g., [0, 1, 2] runs first 3 in parallel) */
  parallel?: number[][];
  /** Called after each step completes */
  onStepComplete?: (stepIndex: number, totalSteps: number, result: StepResult) => void;
  /** Global error strategy if step doesn't specify one */
  defaultErrorStrategy?: ErrorStrategy;
}

export interface ChainResult {
  success: boolean;
  results: StepResult[];
  finalOutput: unknown;
  totalDurationMs: number;
  error?: string;
}

// ============== Chain Execution ==============

/**
 * Execute a tool by dynamically importing and calling it
 */
async function executeToolCall(
  tool: string,
  method: string | undefined,
  args: Record<string, unknown>,
  progressCallback?: ProgressCallback
): Promise<unknown> {
  // Import the tool module
  const toolPath = `../${tool}.ts`;
  const toolModule = await import(toolPath);

  // Find the method to call
  let fn: (args: unknown) => Promise<unknown>;

  if (method) {
    fn = toolModule[method];
    if (typeof fn !== "function") {
      throw new Error(`Method '${method}' not found in tool '${tool}'`);
    }
  } else {
    // Use first exported function
    const exportedFunctions = Object.entries(toolModule).filter(
      ([key, value]) => typeof value === "function" && !key.startsWith("set")
    );
    if (exportedFunctions.length === 0) {
      throw new Error(`No callable functions found in tool '${tool}'`);
    }
    fn = exportedFunctions[0][1] as (args: unknown) => Promise<unknown>;
  }

  // Set progress callback if the module supports it
  if (typeof toolModule.setProgressCallback === "function") {
    toolModule.setProgressCallback(progressCallback || null);
  }

  try {
    return await fn(args);
  } finally {
    // Clean up progress callback
    if (typeof toolModule.setProgressCallback === "function") {
      toolModule.setProgressCallback(null);
    }
  }
}

/**
 * Execute a single step with error handling
 */
async function executeStep(
  step: ChainStep,
  prevResult: StepResult | null,
  stepIndex: number,
  progressCallback?: ProgressCallback,
  defaultErrorStrategy: ErrorStrategy = "fail"
): Promise<StepResult> {
  const startTime = Date.now();
  const errorStrategy = step.onError ?? defaultErrorStrategy;
  const maxRetries = step.maxRetries ?? 3;
  const stepName = step.name ?? `${step.tool}.${step.method ?? "default"}`;

  // Build args
  const args =
    typeof step.args === "function"
      ? step.args(prevResult ?? { output: null, metadata: { tool: "", method: "", durationMs: 0 } })
      : step.args;

  log.info({ step: stepName, args: Object.keys(args) }, `Executing step ${stepIndex + 1}`);
  progressCallback?.(`[Chain] Step ${stepIndex + 1}: ${stepName}`);

  let lastError: Error | undefined;
  let attempts = 0;

  while (attempts < (errorStrategy === "retry" ? maxRetries : 1)) {
    attempts++;

    try {
      const output = await executeToolCall(step.tool, step.method, args, progressCallback);
      const transformedOutput = step.transform ? step.transform(output) : output;

      const result: StepResult = {
        output: transformedOutput,
        metadata: {
          tool: step.tool,
          method: step.method ?? "default",
          durationMs: Date.now() - startTime,
        },
      };

      log.info({ step: stepName, durationMs: result.metadata.durationMs }, "Step completed");
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      log.warn({ step: stepName, error: lastError.message, attempt: attempts }, "Step failed");

      if (errorStrategy === "retry" && attempts < maxRetries) {
        // Exponential backoff
        const delay = Math.min(1000 * Math.pow(2, attempts - 1), 10000);
        progressCallback?.(`[Chain] Retrying ${stepName} in ${delay}ms (attempt ${attempts + 1}/${maxRetries})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // Handle final error based on strategy
  if (errorStrategy === "continue") {
    return {
      output: null,
      metadata: {
        tool: step.tool,
        method: step.method ?? "default",
        durationMs: Date.now() - startTime,
        error: lastError?.message,
      },
    };
  }

  throw lastError;
}

/**
 * Run a tool chain
 *
 * @param config - Chain configuration with steps
 * @param initialInput - Initial input passed to first step
 * @param progressCallback - Optional callback for progress updates
 */
export async function runChain(
  config: ChainConfig,
  initialInput: unknown = null,
  progressCallback?: ProgressCallback
): Promise<ChainResult> {
  const startTime = Date.now();
  const results: StepResult[] = [];
  const { steps, parallel = [], defaultErrorStrategy = "fail" } = config;

  log.info({ stepCount: steps.length }, "Starting chain execution");
  progressCallback?.(`[Chain] Starting ${steps.length}-step pipeline`);

  try {
    // Build a set of parallel step indices for quick lookup
    const parallelGroups = new Map<number, number[]>();
    for (const group of parallel) {
      for (const idx of group) {
        parallelGroups.set(idx, group);
      }
    }

    let i = 0;
    while (i < steps.length) {
      const step = steps[i];
      const prevResult = results.length > 0 ? results[results.length - 1] : null;

      // Check if this step is part of a parallel group
      const parallelGroup = parallelGroups.get(i);
      if (parallelGroup && parallelGroup[0] === i) {
        // This is the start of a parallel group
        progressCallback?.(`[Chain] Running ${parallelGroup.length} steps in parallel`);

        const parallelPromises = parallelGroup.map((idx, groupIdx) =>
          executeStep(
            steps[idx],
            prevResult,
            idx,
            progressCallback,
            defaultErrorStrategy
          )
        );

        const parallelResults = await Promise.all(parallelPromises);
        results.push(...parallelResults);

        // Report progress for each parallel step
        for (let j = 0; j < parallelResults.length; j++) {
          config.onStepComplete?.(parallelGroup[j], steps.length, parallelResults[j]);
        }

        // Skip to after the parallel group
        i = Math.max(...parallelGroup) + 1;
      } else if (!parallelGroup) {
        // Sequential step
        const result = await executeStep(
          step,
          prevResult,
          i,
          progressCallback,
          defaultErrorStrategy
        );
        results.push(result);
        config.onStepComplete?.(i, steps.length, result);
        i++;
      } else {
        // Part of a parallel group but not the first - skip (handled above)
        i++;
      }
    }

    const totalDurationMs = Date.now() - startTime;
    const finalOutput = results.length > 0 ? results[results.length - 1].output : null;

    log.info({ totalDurationMs, stepCount: steps.length }, "Chain completed successfully");
    progressCallback?.(`[Chain] Pipeline completed in ${(totalDurationMs / 1000).toFixed(1)}s`);

    return {
      success: true,
      results,
      finalOutput,
      totalDurationMs,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error({ error: errorMessage }, "Chain failed");

    return {
      success: false,
      results,
      finalOutput: null,
      totalDurationMs: Date.now() - startTime,
      error: errorMessage,
    };
  }
}

// ============== Builder Pattern (Optional) ==============

/**
 * Fluent builder for creating chains
 *
 * @example
 * ```typescript
 * const result = await chain()
 *   .step('deep_research', 'research', { topic: 'AI' })
 *   .step('gemini', 'query', (prev) => ({ prompt: prev.output }))
 *   .run();
 * ```
 */
export function chain() {
  const steps: ChainStep[] = [];
  const parallelGroups: number[][] = [];

  return {
    step<TInput, TOutput>(
      tool: string,
      methodOrArgs?: string | ChainStep<TInput, TOutput>["args"],
      args?: ChainStep<TInput, TOutput>["args"]
    ) {
      if (typeof methodOrArgs === "string") {
        steps.push({ tool, method: methodOrArgs, args: args ?? {} });
      } else {
        steps.push({ tool, args: methodOrArgs ?? {} });
      }
      return this;
    },

    parallel(...indices: number[]) {
      parallelGroups.push(indices);
      return this;
    },

    onError(strategy: ErrorStrategy) {
      if (steps.length > 0) {
        steps[steps.length - 1].onError = strategy;
      }
      return this;
    },

    transform<T>(fn: (result: T) => unknown) {
      if (steps.length > 0) {
        steps[steps.length - 1].transform = fn as (result: unknown) => unknown;
      }
      return this;
    },

    async run(initialInput?: unknown, progressCallback?: ProgressCallback): Promise<ChainResult> {
      return runChain(
        { steps, parallel: parallelGroups },
        initialInput,
        progressCallback
      );
    },
  };
}
