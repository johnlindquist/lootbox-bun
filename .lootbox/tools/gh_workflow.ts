/**
 * GitHub Workflow Tool - Monitor and debug GitHub Actions workflows
 *
 * Wraps the gh CLI to:
 * - Check latest or specific workflow runs
 * - Watch running workflows with live progress
 * - Analyze failures and suggest fixes
 * - Get logs from failed jobs
 */

import { $ } from "bun";
import { createLogger, extractErrorMessage, type ProgressCallback } from "./shared/index.ts";

const log = createLogger("gh_workflow");

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

// ============================================================================
// TYPES
// ============================================================================

interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  branch: string;
  event: string;
  created_at: string;
  updated_at: string;
  url: string;
  head_sha: string;
  workflow_name: string;
}

interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string;
  completed_at: string | null;
  steps: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    number: number;
  }>;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Run a gh command and return the result
 */
async function runGh(
  args: string[],
  options?: { json?: boolean; cwd?: string }
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const fullArgs = [...args];
  if (options?.json) {
    fullArgs.push("--json", "databaseId,name,status,conclusion,headBranch,event,createdAt,updatedAt,url,headSha,workflowName");
  }

  log.info(`Running: gh ${fullArgs.join(" ")}`);

  try {
    const proc = Bun.spawn(["gh", ...fullArgs], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: options?.cwd,
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;

    return {
      success: exitCode === 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (error) {
    return {
      success: false,
      stdout: "",
      stderr: extractErrorMessage(error),
    };
  }
}

/**
 * Parse workflow run from gh JSON output
 */
function parseWorkflowRun(json: any): WorkflowRun {
  return {
    id: json.databaseId,
    name: json.name || json.displayTitle,
    status: json.status,
    conclusion: json.conclusion,
    branch: json.headBranch,
    event: json.event,
    created_at: json.createdAt,
    updated_at: json.updatedAt,
    url: json.url,
    head_sha: json.headSha,
    workflow_name: json.workflowName,
  };
}

/**
 * Get the current branch name
 */
async function getCurrentBranch(cwd?: string): Promise<string | null> {
  try {
    const result = await $`git rev-parse --abbrev-ref HEAD`.cwd(cwd || process.cwd()).text();
    return result.trim();
  } catch {
    return null;
  }
}

// ============================================================================
// TOOL FUNCTIONS
// ============================================================================

/**
 * Get the latest workflow run for the current repository
 *
 * @param args.branch - Filter by branch (defaults to current branch if "current", or all branches if omitted)
 * @param args.workflow - Filter by workflow name or filename
 * @param args.status - Filter by status: queued, in_progress, completed
 * @param args.cwd - Working directory (for finding the repo)
 */
export async function get_latest_run(args: {
  branch?: string;
  workflow?: string;
  status?: "queued" | "in_progress" | "completed";
  cwd?: string;
}): Promise<{
  success: boolean;
  run?: WorkflowRun;
  error?: string;
}> {
  log.call("get_latest_run", args);
  const { branch, workflow, status, cwd } = args;

  const ghArgs = ["run", "list", "--limit", "1"];

  // Handle branch filtering
  let branchFilter = branch;
  if (branch === "current") {
    branchFilter = await getCurrentBranch(cwd) || undefined;
  }
  if (branchFilter) {
    ghArgs.push("--branch", branchFilter);
  }

  if (workflow) {
    ghArgs.push("--workflow", workflow);
  }

  if (status) {
    ghArgs.push("--status", status);
  }

  ghArgs.push("--json", "databaseId,displayTitle,status,conclusion,headBranch,event,createdAt,updatedAt,url,headSha,workflowName");

  const result = await runGh(ghArgs, { cwd });

  if (!result.success) {
    log.error("get_latest_run", result.stderr);
    return { success: false, error: result.stderr };
  }

  try {
    const runs = JSON.parse(result.stdout);
    if (runs.length === 0) {
      return { success: true, run: undefined };
    }

    const run = parseWorkflowRun(runs[0]);
    log.success("get_latest_run", run);
    return { success: true, run };
  } catch (error) {
    const err = extractErrorMessage(error);
    log.error("get_latest_run", err);
    return { success: false, error: err };
  }
}

/**
 * Get details of a specific workflow run
 *
 * @param args.run_id - The workflow run ID
 * @param args.cwd - Working directory
 */
export async function get_run(args: {
  run_id: number;
  cwd?: string;
}): Promise<{
  success: boolean;
  run?: WorkflowRun;
  jobs?: WorkflowJob[];
  error?: string;
}> {
  log.call("get_run", args);
  const { run_id, cwd } = args;

  // Get run details
  const runResult = await runGh(
    ["run", "view", String(run_id), "--json", "databaseId,displayTitle,status,conclusion,headBranch,event,createdAt,updatedAt,url,headSha,workflowName,jobs"],
    { cwd }
  );

  if (!runResult.success) {
    log.error("get_run", runResult.stderr);
    return { success: false, error: runResult.stderr };
  }

  try {
    const data = JSON.parse(runResult.stdout);
    const run = parseWorkflowRun(data);

    const jobs: WorkflowJob[] = (data.jobs || []).map((job: any) => ({
      id: job.databaseId,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      started_at: job.startedAt,
      completed_at: job.completedAt,
      steps: (job.steps || []).map((step: any) => ({
        name: step.name,
        status: step.status,
        conclusion: step.conclusion,
        number: step.number,
      })),
    }));

    log.success("get_run", { run, jobs_count: jobs.length });
    return { success: true, run, jobs };
  } catch (error) {
    const err = extractErrorMessage(error);
    log.error("get_run", err);
    return { success: false, error: err };
  }
}

/**
 * List recent workflow runs
 *
 * @param args.limit - Maximum number of runs to return (default: 10)
 * @param args.branch - Filter by branch
 * @param args.workflow - Filter by workflow name
 * @param args.status - Filter by status
 * @param args.cwd - Working directory
 */
export async function list_runs(args: {
  limit?: number;
  branch?: string;
  workflow?: string;
  status?: "queued" | "in_progress" | "completed";
  cwd?: string;
}): Promise<{
  success: boolean;
  runs?: WorkflowRun[];
  error?: string;
}> {
  log.call("list_runs", args);
  const { limit = 10, branch, workflow, status, cwd } = args;

  const ghArgs = ["run", "list", "--limit", String(limit)];

  let branchFilter = branch;
  if (branch === "current") {
    branchFilter = await getCurrentBranch(cwd) || undefined;
  }
  if (branchFilter) {
    ghArgs.push("--branch", branchFilter);
  }

  if (workflow) {
    ghArgs.push("--workflow", workflow);
  }

  if (status) {
    ghArgs.push("--status", status);
  }

  ghArgs.push("--json", "databaseId,displayTitle,status,conclusion,headBranch,event,createdAt,updatedAt,url,headSha,workflowName");

  const result = await runGh(ghArgs, { cwd });

  if (!result.success) {
    log.error("list_runs", result.stderr);
    return { success: false, error: result.stderr };
  }

  try {
    const data = JSON.parse(result.stdout);
    const runs = data.map(parseWorkflowRun);
    log.success("list_runs", { count: runs.length });
    return { success: true, runs };
  } catch (error) {
    const err = extractErrorMessage(error);
    log.error("list_runs", err);
    return { success: false, error: err };
  }
}

/**
 * Watch a workflow run until it completes
 *
 * @param args.run_id - The run ID to watch (optional - uses latest if not provided)
 * @param args.interval_seconds - Poll interval in seconds (default: 10)
 * @param args.timeout_seconds - Timeout in seconds (default: 600 = 10 minutes)
 * @param args.cwd - Working directory
 */
export async function watch_run(args: {
  run_id?: number;
  interval_seconds?: number;
  timeout_seconds?: number;
  cwd?: string;
}): Promise<{
  success: boolean;
  run?: WorkflowRun;
  final_status?: string;
  conclusion?: string;
  error?: string;
}> {
  log.call("watch_run", args);
  const { run_id, interval_seconds = 10, timeout_seconds = 600, cwd } = args;

  // If no run_id provided, get the latest
  let targetRunId = run_id;
  if (!targetRunId) {
    const latest = await get_latest_run({ cwd });
    if (!latest.success || !latest.run) {
      return { success: false, error: latest.error || "No workflow runs found" };
    }
    targetRunId = latest.run.id;
    sendProgress(`Watching latest run: ${latest.run.name} (${targetRunId})`);
  }

  const startTime = Date.now();
  const timeoutMs = timeout_seconds * 1000;
  const pollMs = interval_seconds * 1000;

  sendProgress(`Starting watch for run ${targetRunId}...`);

  while (Date.now() - startTime < timeoutMs) {
    const runDetails = await get_run({ run_id: targetRunId, cwd });

    if (!runDetails.success || !runDetails.run) {
      return { success: false, error: runDetails.error || "Failed to get run details" };
    }

    const { run, jobs } = runDetails;
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // Check if completed
    if (run.status === "completed") {
      const icon = run.conclusion === "success" ? "✅" : run.conclusion === "failure" ? "❌" : "⚠️";
      sendProgress(`${icon} Run ${targetRunId} completed: ${run.conclusion}`);
      log.success("watch_run", { run_id: targetRunId, conclusion: run.conclusion });
      return {
        success: true,
        run,
        final_status: run.status,
        conclusion: run.conclusion || undefined,
      };
    }

    // Show progress with job status
    const jobSummary = jobs?.map((j) => `${j.name}: ${j.status}`).join(", ") || "";
    sendProgress(`⏳ Run ${targetRunId} ${run.status} (${elapsed}s) - ${jobSummary}`);

    await Bun.sleep(pollMs);
  }

  // Timeout
  const finalRun = await get_run({ run_id: targetRunId, cwd });
  log.error("watch_run", `Timeout after ${timeout_seconds}s`);
  return {
    success: false,
    run: finalRun.run,
    final_status: finalRun.run?.status,
    error: `Timeout after ${timeout_seconds}s - run still ${finalRun.run?.status}`,
  };
}

/**
 * Get logs from failed jobs in a workflow run
 *
 * @param args.run_id - The run ID (optional - uses latest failed if not provided)
 * @param args.job_name - Filter to specific job name
 * @param args.cwd - Working directory
 */
export async function get_failed_logs(args: {
  run_id?: number;
  job_name?: string;
  cwd?: string;
}): Promise<{
  success: boolean;
  run_id?: number;
  logs?: string;
  failed_jobs?: string[];
  error?: string;
}> {
  log.call("get_failed_logs", args);
  const { run_id, job_name, cwd } = args;

  // Get the run to analyze
  let targetRunId = run_id;
  if (!targetRunId) {
    // Get the latest failed run
    const result = await runGh(
      ["run", "list", "--limit", "1", "--status", "completed", "--json", "databaseId,conclusion"],
      { cwd }
    );
    if (result.success) {
      const runs = JSON.parse(result.stdout);
      const failed = runs.find((r: any) => r.conclusion === "failure");
      if (failed) {
        targetRunId = failed.databaseId;
      }
    }
    if (!targetRunId) {
      return { success: false, error: "No failed workflow runs found" };
    }
  }

  // Get run details to identify failed jobs
  const runDetails = await get_run({ run_id: targetRunId, cwd });
  if (!runDetails.success || !runDetails.jobs) {
    return { success: false, error: runDetails.error || "Failed to get run details" };
  }

  const failedJobs = runDetails.jobs.filter((j) => j.conclusion === "failure");
  if (failedJobs.length === 0) {
    return { success: true, run_id: targetRunId, logs: "", failed_jobs: [] };
  }

  // Filter by job name if specified
  const jobsToFetch = job_name
    ? failedJobs.filter((j) => j.name.toLowerCase().includes(job_name.toLowerCase()))
    : failedJobs;

  if (jobsToFetch.length === 0) {
    return { success: false, error: `No failed jobs matching '${job_name}'` };
  }

  sendProgress(`Fetching logs for ${jobsToFetch.length} failed job(s)...`);

  // Get logs using gh run view --log-failed
  const logsResult = await runGh(["run", "view", String(targetRunId), "--log-failed"], { cwd });

  if (!logsResult.success) {
    log.error("get_failed_logs", logsResult.stderr);
    return { success: false, error: logsResult.stderr };
  }

  log.success("get_failed_logs", { run_id: targetRunId, failed_jobs: failedJobs.map((j) => j.name) });
  return {
    success: true,
    run_id: targetRunId,
    logs: logsResult.stdout,
    failed_jobs: failedJobs.map((j) => j.name),
  };
}

/**
 * Analyze a workflow failure and suggest fixes
 *
 * Uses AI to analyze the failure logs and provide actionable suggestions.
 *
 * @param args.run_id - The run ID to analyze (optional - uses latest failed)
 * @param args.cwd - Working directory
 * @param args.include_workflow_file - Include the workflow YAML in analysis (default: true)
 */
export async function analyze_failure(args: {
  run_id?: number;
  cwd?: string;
  include_workflow_file?: boolean;
}): Promise<{
  success: boolean;
  run_id?: number;
  summary?: string;
  failed_jobs?: string[];
  logs?: string;
  workflow_file?: string;
  analysis_prompt?: string;
  error?: string;
}> {
  log.call("analyze_failure", args);
  const { run_id, cwd, include_workflow_file = true } = args;

  // Get failed logs
  const logsResult = await get_failed_logs({ run_id, cwd });
  if (!logsResult.success) {
    return { success: false, error: logsResult.error };
  }

  if (!logsResult.logs || logsResult.logs.length === 0) {
    return { success: false, error: "No failure logs found" };
  }

  // Get workflow file if requested
  let workflowFile: string | undefined;
  if (include_workflow_file) {
    try {
      // Try to find the workflow file
      const runDetails = await get_run({ run_id: logsResult.run_id!, cwd });
      if (runDetails.success && runDetails.run) {
        const workflowName = runDetails.run.workflow_name;
        // Try common locations
        const possiblePaths = [
          `.github/workflows/${workflowName}.yml`,
          `.github/workflows/${workflowName}.yaml`,
          `.github/workflows/${workflowName.toLowerCase()}.yml`,
          `.github/workflows/${workflowName.toLowerCase().replace(/ /g, "-")}.yml`,
        ];

        for (const path of possiblePaths) {
          try {
            const content = await $`cat ${path}`.cwd(cwd || process.cwd()).text();
            workflowFile = content;
            break;
          } catch {
            // Try next path
          }
        }
      }
    } catch {
      // Ignore - workflow file is optional
    }
  }

  // Create an analysis prompt for the AI
  const analysisPrompt = `## CI Failure Analysis

### Failed Jobs
${logsResult.failed_jobs?.join(", ") || "Unknown"}

### Failure Logs
\`\`\`
${logsResult.logs.substring(0, 15000)}
\`\`\`

${workflowFile ? `### Workflow File\n\`\`\`yaml\n${workflowFile}\n\`\`\`` : ""}

---

Please analyze this CI failure and provide:
1. **Root Cause**: What specific error caused the failure
2. **Failed Step**: Which step in the workflow failed
3. **Fix Suggestions**: Actionable steps to fix the issue
4. **Code Changes**: If applicable, specific code changes needed

Focus on being concise and actionable.`;

  // Generate a summary of the failure
  const firstError = logsResult.logs.split("\n").find((line) =>
    line.toLowerCase().includes("error") ||
    line.toLowerCase().includes("failed") ||
    line.toLowerCase().includes("exception")
  );

  const summary = firstError
    ? `CI Failed: ${firstError.substring(0, 200)}`
    : `CI Failed in: ${logsResult.failed_jobs?.join(", ")}`;

  log.success("analyze_failure", { run_id: logsResult.run_id, summary });
  return {
    success: true,
    run_id: logsResult.run_id,
    summary,
    failed_jobs: logsResult.failed_jobs,
    logs: logsResult.logs,
    workflow_file: workflowFile,
    analysis_prompt: analysisPrompt,
  };
}

/**
 * Quick status check - get a summary of the latest run
 *
 * Returns a formatted status string suitable for display.
 *
 * @param args.branch - Filter by branch ("current" for current branch)
 * @param args.cwd - Working directory
 */
export async function quick_status(args: {
  branch?: string;
  cwd?: string;
}): Promise<{
  success: boolean;
  status_line?: string;
  run?: WorkflowRun;
  is_running?: boolean;
  is_failed?: boolean;
  error?: string;
}> {
  log.call("quick_status", args);
  const { branch, cwd } = args;

  const result = await get_latest_run({ branch, cwd });
  if (!result.success) {
    return { success: false, error: result.error };
  }

  if (!result.run) {
    return { success: true, status_line: "No workflow runs found", is_running: false, is_failed: false };
  }

  const run = result.run;
  const icon =
    run.status === "in_progress" || run.status === "queued"
      ? "🔄"
      : run.conclusion === "success"
        ? "✅"
        : run.conclusion === "failure"
          ? "❌"
          : "⚠️";

  const statusLine = `${icon} ${run.workflow_name}: ${run.conclusion || run.status} (${run.branch}) - ${run.name}`;

  log.success("quick_status", statusLine);
  return {
    success: true,
    status_line: statusLine,
    run,
    is_running: run.status === "in_progress" || run.status === "queued",
    is_failed: run.conclusion === "failure",
  };
}

/**
 * Re-run a failed workflow
 *
 * @param args.run_id - The run ID to re-run (optional - uses latest failed)
 * @param args.failed_only - Only re-run failed jobs (default: true)
 * @param args.cwd - Working directory
 */
export async function rerun(args: {
  run_id?: number;
  failed_only?: boolean;
  cwd?: string;
}): Promise<{
  success: boolean;
  run_id?: number;
  message?: string;
  error?: string;
}> {
  log.call("rerun", args);
  const { run_id, failed_only = true, cwd } = args;

  // Get the run ID if not provided
  let targetRunId = run_id;
  if (!targetRunId) {
    const latest = await get_latest_run({ cwd });
    if (!latest.success || !latest.run) {
      return { success: false, error: latest.error || "No workflow runs found" };
    }
    targetRunId = latest.run.id;
  }

  const ghArgs = ["run", "rerun", String(targetRunId)];
  if (failed_only) {
    ghArgs.push("--failed");
  }

  const result = await runGh(ghArgs, { cwd });

  if (!result.success) {
    log.error("rerun", result.stderr);
    return { success: false, error: result.stderr };
  }

  const message = failed_only
    ? `Re-running failed jobs for run ${targetRunId}`
    : `Re-running all jobs for run ${targetRunId}`;

  log.success("rerun", message);
  return { success: true, run_id: targetRunId, message };
}
