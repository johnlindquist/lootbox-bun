/**
 * Promptfoo Tool - Test-Driven Development for AI Agents
 *
 * Provides capabilities to:
 * - Run prompt evaluations using Claude Code as the harness
 * - Define test cases with assertions
 * - Compare outputs across different prompts/models
 * - Generate reports on prompt quality
 *
 * Uses promptfoo CLI with a custom Claude Code provider that wraps the `claude` CLI.
 */

import { createLogger, extractErrorMessage, type ProgressCallback } from "./shared/index.ts";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const log = createLogger("promptfoo");

// Progress callback for long operations
let globalProgressCallback: ProgressCallback | null = null;

export function setProgressCallback(callback: ProgressCallback | null): void {
  globalProgressCallback = callback;
}

function sendProgress(message: string): void {
  if (globalProgressCallback) {
    globalProgressCallback(message);
  }
}

// Default eval directory
const DEFAULT_EVAL_DIR = join(process.env.HOME || "/tmp", ".lootbox-evals");

/**
 * Ensure eval directory exists
 */
function ensureEvalDir(dir: string = DEFAULT_EVAL_DIR): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * The custom Claude Code provider script content
 * This wraps the `claude` CLI as a promptfoo provider
 */
function getClaudeCodeProviderScript(): string {
  return `#!/usr/bin/env node
/**
 * Claude Code Provider for Promptfoo
 *
 * This provider wraps the \`claude\` CLI to use Claude Code as the execution harness.
 * It runs prompts through Claude Code and captures the output.
 */

const { spawn } = require('child_process');

async function runClaudeCode(prompt, options = {}) {
  const { timeout = 120000, workingDir } = options;

  return new Promise((resolve, reject) => {
    const args = ['--print', '--dangerously-skip-permissions'];

    const proc = spawn('claude', args, {
      cwd: workingDir || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Send the prompt via stdin
    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.on('close', (code) => {
      if (code !== 0 && !stdout) {
        reject(new Error(\`Claude Code exited with code \${code}: \${stderr}\`));
      } else {
        resolve(stdout.trim());
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

// Promptfoo provider interface
module.exports = {
  id: () => 'claude-code',

  async callApi(prompt, context) {
    try {
      const output = await runClaudeCode(prompt, {
        timeout: context?.config?.timeout || 120000,
        workingDir: context?.config?.workingDir,
      });

      return {
        output,
        tokenUsage: {
          // Claude Code doesn't expose token counts, estimate based on output
          total: Math.ceil((prompt.length + output.length) / 4),
        },
      };
    } catch (error) {
      return {
        error: error.message || String(error),
      };
    }
  },
};
`;
}

/**
 * Generate a sample promptfoo config for testing prompts
 */
function generateSampleConfig(name: string, prompts: string[]): object {
  return {
    description: `${name} evaluation`,
    prompts: prompts,
    providers: [
      {
        id: 'file://claude-code-provider.js',
        label: 'Claude Code',
        config: {
          timeout: 120000,
        },
      },
    ],
    tests: [
      {
        vars: {},
        assert: [
          {
            type: 'contains',
            value: '', // User should fill this in
            description: 'Output should contain expected content',
          },
        ],
      },
    ],
    outputPath: './results.json',
  };
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize a new promptfoo evaluation project
 *
 * @param args.name - Name of the evaluation project
 * @param args.directory - Directory to create the project in (optional)
 * @param args.prompts - Initial prompts to test (optional)
 */
export async function init_eval(args: {
  name: string;
  directory?: string;
  prompts?: string[];
}): Promise<{
  success: boolean;
  project_dir?: string;
  config_path?: string;
  error?: string;
}> {
  log.call("init_eval", args);
  const { name, directory, prompts = ['Your prompt here'] } = args;

  try {
    const projectDir = directory || join(DEFAULT_EVAL_DIR, name);
    ensureEvalDir(projectDir);

    // Write the Claude Code provider
    const providerPath = join(projectDir, 'claude-code-provider.js');
    writeFileSync(providerPath, getClaudeCodeProviderScript());

    // Write the config
    const configPath = join(projectDir, 'promptfooconfig.yaml');
    const config = generateSampleConfig(name, prompts);

    // Convert to YAML manually (simple case)
    const yamlContent = `# Promptfoo Evaluation: ${name}
# Uses Claude Code as the execution harness

description: "${name} evaluation"

prompts:
${prompts.map(p => `  - "${p.replace(/"/g, '\\"')}"`).join('\n')}

providers:
  - id: "file://claude-code-provider.js"
    label: "Claude Code"
    config:
      timeout: 120000

tests:
  - vars: {}
    assert:
      # Add your assertions here
      - type: contains
        value: ""
        description: "Output should contain expected content"

      # LLM-graded assertion (uses another model to grade)
      # - type: llm-rubric
      #   value: "The response should be helpful and accurate"

# Output results to JSON for analysis
outputPath: "./results.json"
`;

    writeFileSync(configPath, yamlContent);

    // Create a README
    const readmePath = join(projectDir, 'README.md');
    const readmeContent = `# ${name} Evaluation

This promptfoo evaluation uses Claude Code as the execution harness.

## Setup

\`\`\`bash
npm install -g promptfoo
\`\`\`

## Run Evaluation

\`\`\`bash
cd ${projectDir}
promptfoo eval
\`\`\`

## View Results

\`\`\`bash
promptfoo view
\`\`\`

## Files

- \`promptfooconfig.yaml\` - Main configuration
- \`claude-code-provider.js\` - Custom provider that wraps Claude Code CLI
- \`results.json\` - Evaluation results (after running)
`;

    writeFileSync(readmePath, readmeContent);

    log.success("init_eval", { projectDir, configPath });
    return { success: true, project_dir: projectDir, config_path: configPath };
  } catch (error) {
    const err = extractErrorMessage(error);
    log.error("init_eval", err);
    return { success: false, error: err };
  }
}

// ============================================================================
// RUNNING EVALUATIONS
// ============================================================================

/**
 * Run a promptfoo evaluation
 *
 * @param args.config_path - Path to promptfooconfig.yaml
 * @param args.output_path - Path for results output (optional)
 * @param args.filter - Only run tests matching this pattern (optional)
 * @param args.verbose - Show verbose output (optional)
 */
export async function run_eval(args: {
  config_path: string;
  output_path?: string;
  filter?: string;
  verbose?: boolean;
}): Promise<{
  success: boolean;
  results_path?: string;
  summary?: {
    total: number;
    passed: number;
    failed: number;
    pass_rate: number;
  };
  error?: string;
}> {
  log.call("run_eval", args);
  const { config_path, output_path, filter, verbose = false } = args;

  try {
    if (!existsSync(config_path)) {
      const err = `Config file not found: ${config_path}`;
      log.error("run_eval", err);
      return { success: false, error: err };
    }

    const configDir = dirname(config_path);
    const resultsPath = output_path || join(configDir, 'results.json');

    sendProgress("Starting promptfoo evaluation...");

    // Build command
    const cmdArgs = ['promptfoo', 'eval', '-c', config_path, '-o', resultsPath];
    if (filter) {
      cmdArgs.push('--filter', filter);
    }
    if (verbose) {
      cmdArgs.push('--verbose');
    }

    const startTime = Date.now();
    const progressInterval = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      sendProgress(`Evaluation running... (${elapsed}s elapsed)`);
    }, 5000);

    try {
      const proc = Bun.spawn(['npx', ...cmdArgs], {
        cwd: configDir,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env },
      });

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        log.error("run_eval", stderr || stdout);
        return { success: false, error: stderr || stdout || `Exit code ${exitCode}` };
      }

      // Parse results if they exist
      let summary;
      if (existsSync(resultsPath)) {
        try {
          const results = JSON.parse(readFileSync(resultsPath, 'utf-8'));
          const total = results.results?.length || 0;
          const passed = results.results?.filter((r: any) => r.success)?.length || 0;
          summary = {
            total,
            passed,
            failed: total - passed,
            pass_rate: total > 0 ? Math.round((passed / total) * 100) : 0,
          };
        } catch {
          // Results parsing failed, but eval succeeded
        }
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      sendProgress(`Evaluation completed in ${elapsed}s`);

      log.success("run_eval", { resultsPath, summary });
      return { success: true, results_path: resultsPath, summary };
    } finally {
      clearInterval(progressInterval);
    }
  } catch (error) {
    const err = extractErrorMessage(error);
    log.error("run_eval", err);
    return { success: false, error: err };
  }
}

/**
 * View evaluation results in the browser
 *
 * @param args.results_path - Path to results.json (optional, uses latest)
 * @param args.port - Port for the viewer (optional, default: 15500)
 */
export async function view_results(args: {
  results_path?: string;
  port?: number;
}): Promise<{ success: boolean; url?: string; error?: string }> {
  log.call("view_results", args);
  const { results_path, port = 15500 } = args;

  try {
    const cmdArgs = ['promptfoo', 'view', '--port', String(port)];
    if (results_path) {
      cmdArgs.push('-o', results_path);
    }

    // Start viewer in background
    const proc = Bun.spawn(['npx', ...cmdArgs], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Give it a moment to start
    await Bun.sleep(2000);

    const url = `http://localhost:${port}`;
    log.success("view_results", { url });
    return { success: true, url };
  } catch (error) {
    const err = extractErrorMessage(error);
    log.error("view_results", err);
    return { success: false, error: err };
  }
}

// ============================================================================
// TEST CASE MANAGEMENT
// ============================================================================

/**
 * Add a test case to an existing evaluation config
 *
 * @param args.config_path - Path to promptfooconfig.yaml
 * @param args.prompt - The prompt to test
 * @param args.expected_contains - Text that should be in the output (optional)
 * @param args.expected_not_contains - Text that should NOT be in the output (optional)
 * @param args.llm_rubric - LLM-graded assertion (optional)
 * @param args.vars - Variables for the test (optional)
 */
export async function add_test(args: {
  config_path: string;
  prompt?: string;
  expected_contains?: string;
  expected_not_contains?: string;
  llm_rubric?: string;
  vars?: Record<string, string>;
}): Promise<{ success: boolean; error?: string }> {
  log.call("add_test", args);
  const { config_path, prompt, expected_contains, expected_not_contains, llm_rubric, vars } = args;

  try {
    if (!existsSync(config_path)) {
      const err = `Config file not found: ${config_path}`;
      log.error("add_test", err);
      return { success: false, error: err };
    }

    // Read existing config
    let content = readFileSync(config_path, 'utf-8');

    // Add prompt if provided
    if (prompt) {
      const promptEntry = `  - "${prompt.replace(/"/g, '\\"')}"`;
      // Find prompts section and add
      content = content.replace(
        /(prompts:\n)([\s\S]*?)(\n\nproviders:)/,
        `$1$2\n${promptEntry}$3`
      );
    }

    // Build assertion YAML
    const assertions: string[] = [];
    if (expected_contains) {
      assertions.push(`      - type: contains
        value: "${expected_contains.replace(/"/g, '\\"')}"`);
    }
    if (expected_not_contains) {
      assertions.push(`      - type: not-contains
        value: "${expected_not_contains.replace(/"/g, '\\"')}"`);
    }
    if (llm_rubric) {
      assertions.push(`      - type: llm-rubric
        value: "${llm_rubric.replace(/"/g, '\\"')}"`);
    }

    if (assertions.length > 0 || vars) {
      // Build test entry
      let testEntry = '  - vars:';
      if (vars && Object.keys(vars).length > 0) {
        for (const [key, value] of Object.entries(vars)) {
          testEntry += `\n      ${key}: "${value.replace(/"/g, '\\"')}"`;
        }
      } else {
        testEntry += ' {}';
      }

      if (assertions.length > 0) {
        testEntry += '\n    assert:\n' + assertions.join('\n');
      }

      // Find tests section and add
      content = content.replace(
        /(tests:\n)([\s\S]*?)(\n\n# Output|\n*$)/,
        `$1$2\n${testEntry}$3`
      );
    }

    writeFileSync(config_path, content);

    log.success("add_test", { config_path });
    return { success: true };
  } catch (error) {
    const err = extractErrorMessage(error);
    log.error("add_test", err);
    return { success: false, error: err };
  }
}

// ============================================================================
// ANALYSIS
// ============================================================================

/**
 * Get a summary of evaluation results
 *
 * @param args.results_path - Path to results.json
 */
export async function get_results_summary(args: {
  results_path: string;
}): Promise<{
  success: boolean;
  summary?: {
    total_tests: number;
    passed: number;
    failed: number;
    pass_rate: number;
    by_prompt: Record<string, { passed: number; failed: number }>;
    failures: Array<{
      prompt: string;
      assertion: string;
      expected: string;
      actual: string;
    }>;
  };
  error?: string;
}> {
  log.call("get_results_summary", args);
  const { results_path } = args;

  try {
    if (!existsSync(results_path)) {
      const err = `Results file not found: ${results_path}`;
      log.error("get_results_summary", err);
      return { success: false, error: err };
    }

    const results = JSON.parse(readFileSync(results_path, 'utf-8'));
    const testResults = results.results || [];

    const total_tests = testResults.length;
    const passed = testResults.filter((r: any) => r.success).length;
    const failed = total_tests - passed;

    // Group by prompt
    const by_prompt: Record<string, { passed: number; failed: number }> = {};
    for (const result of testResults) {
      const prompt = result.prompt?.raw || 'unknown';
      if (!by_prompt[prompt]) {
        by_prompt[prompt] = { passed: 0, failed: 0 };
      }
      if (result.success) {
        by_prompt[prompt].passed++;
      } else {
        by_prompt[prompt].failed++;
      }
    }

    // Collect failures
    const failures = testResults
      .filter((r: any) => !r.success)
      .map((r: any) => ({
        prompt: r.prompt?.raw?.substring(0, 100) || 'unknown',
        assertion: r.failedAssertions?.[0]?.assertion || 'unknown',
        expected: r.failedAssertions?.[0]?.expectedValue || '',
        actual: r.response?.output?.substring(0, 200) || '',
      }));

    const summary = {
      total_tests,
      passed,
      failed,
      pass_rate: total_tests > 0 ? Math.round((passed / total_tests) * 100) : 0,
      by_prompt,
      failures,
    };

    log.success("get_results_summary", { total_tests, passed, failed });
    return { success: true, summary };
  } catch (error) {
    const err = extractErrorMessage(error);
    log.error("get_results_summary", err);
    return { success: false, error: err };
  }
}

/**
 * List all evaluation projects
 */
export async function list_evals(args: {
  directory?: string;
}): Promise<{
  success: boolean;
  evals?: Array<{
    name: string;
    path: string;
    has_results: boolean;
    last_modified: string;
  }>;
  error?: string;
}> {
  log.call("list_evals", args);
  const { directory = DEFAULT_EVAL_DIR } = args;

  try {
    if (!existsSync(directory)) {
      return { success: true, evals: [] };
    }

    const { readdirSync, statSync } = await import('node:fs');
    const entries = readdirSync(directory, { withFileTypes: true });

    const evals = entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        const evalPath = join(directory, e.name);
        const configPath = join(evalPath, 'promptfooconfig.yaml');
        const resultsPath = join(evalPath, 'results.json');

        if (!existsSync(configPath)) return null;

        const stats = statSync(evalPath);
        return {
          name: e.name,
          path: evalPath,
          has_results: existsSync(resultsPath),
          last_modified: stats.mtime.toISOString(),
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .sort((a, b) => new Date(b.last_modified).getTime() - new Date(a.last_modified).getTime());

    log.success("list_evals", { count: evals.length });
    return { success: true, evals };
  } catch (error) {
    const err = extractErrorMessage(error);
    log.error("list_evals", err);
    return { success: false, error: err };
  }
}
