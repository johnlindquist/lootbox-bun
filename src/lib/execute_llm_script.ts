import { saveScriptRun } from "./script_history.ts";
import { get_client } from "./client_cache.ts";
import { unlink, mkdtemp, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

export const execute_llm_script = async (args: { script: string; sessionId?: string }) => {
  const { script, sessionId } = args;
  const startTime = Date.now();
  console.error("🔧 execute_llm_script: Starting execution");

  // Import client via HTTP URL with version for cache busting only when RPC files change
  const { get_config } = await import("./get_config.ts");
  const config = await get_config();
  const client = get_client();
  const clientUrl = `http://localhost:${config.port}/client.ts?v=${client.version}`;

  console.error(`📦 Using client from ${clientUrl} (version ${client.version})`);

  // Inject import statement at the top of the user script
  const injectedScript = `import { tools } from "${clientUrl}";\n\n// User script begins here\n${script}`;

  let tempFile: string | null = null;

  try {
    // Create temp file
    const tempDir = await mkdtemp(join(tmpdir(), "lootbox-script-"));
    tempFile = join(tempDir, "script.ts");
    console.error(`📁 Created temp file: ${tempFile}`);
    await writeFile(tempFile, injectedScript);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    const proc = Bun.spawn(["bun", "run", tempFile], {
      stdout: "pipe",
      stderr: "pipe",
    });

    // Handle timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => {
        proc.kill();
        reject(new Error("AbortError"));
      });
    });

    const resultPromise = (async () => {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      return { exitCode, stdout, stderr };
    })();

    let result: { exitCode: number; stdout: string; stderr: string };
    try {
      result = await Promise.race([resultPromise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }

    const { exitCode, stdout: outStr, stderr: errStr } = result;

    // Clean up temp file
    if (tempFile) {
      await unlink(tempFile).catch(() => {});
    }

    const durationMs = Date.now() - startTime;

    if (exitCode !== 0) {
      const error = errStr || "Script execution failed";

      // Save failed run
      await saveScriptRun({
        timestamp: startTime,
        script,
        success: false,
        error,
        output: outStr,
        durationMs,
        sessionId,
      });

      return {
        success: false,
        error,
        output: outStr,
      };
    }

    // Save successful run
    await saveScriptRun({
      timestamp: startTime,
      script,
      success: true,
      output: outStr,
      durationMs,
      sessionId,
    });

    return {
      success: true,
      output: outStr,
      warnings: errStr || undefined,
    };
  } catch (error) {
    // Clean up temp file
    if (tempFile) {
      await unlink(tempFile).catch(() => {});
    }

    const durationMs = Date.now() - startTime;

    if (error instanceof Error && error.message === "AbortError") {
      const errorMsg = "Script execution timeout (10 seconds)";

      // Save timeout run
      await saveScriptRun({
        timestamp: startTime,
        script,
        success: false,
        error: errorMsg,
        durationMs,
        sessionId,
      });

      return {
        success: false,
        error: errorMsg,
      };
    }

    const errorMsg = error instanceof Error ? error.message : String(error);

    // Save error run
    await saveScriptRun({
      timestamp: startTime,
      script,
      success: false,
      error: errorMsg,
      durationMs,
      sessionId,
    });

    return {
      success: false,
      error: errorMsg,
    };
  }
};
