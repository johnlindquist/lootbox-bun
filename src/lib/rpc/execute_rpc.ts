// Execute RPC function in separate Bun process

import { unlink, mkdtemp, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

export const execute_rpc = async (args: {
  file: string;
  functionName: string;
  params: unknown; // Now a single object instead of array
}): Promise<{ success: boolean; data?: unknown; error?: string }> => {
  let tempFile: string | null = null;

  try {
    // Create a temporary script that imports and calls the function
    // With standardized args: { data: T } pattern, we just pass the params object directly
    const argsJson = JSON.stringify(args.params);

    const script = `import { ${args.functionName} } from "${args.file}";

const args = ${argsJson};
const result = await ${args.functionName}(args);
console.log(JSON.stringify({ success: true, data: result }));
`;

    // Create temp file
    const tempDir = await mkdtemp(join(tmpdir(), "lootbox-rpc-"));
    tempFile = join(tempDir, "script.ts");
    await writeFile(tempFile, script);

    const proc = Bun.spawn(["bun", "run", tempFile], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;

    // Clean up temp file
    if (tempFile) {
      await unlink(tempFile).catch(() => {});
    }

    if (exitCode !== 0) {
      return { success: false, error: stderr };
    }

    try {
      const result = JSON.parse(stdout.trim());
      return result;
    } catch {
      return { success: true, data: stdout.trim() };
    }
  } catch (err) {
    // Clean up temp file on error
    if (tempFile) {
      await unlink(tempFile).catch(() => {});
    }

    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};
