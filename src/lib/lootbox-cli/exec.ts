import type { ExecResponse } from "./types.ts";
import { generateId, readStdin } from "./utils.ts";
import { get_config } from "../get_config.ts";
import { existsSync } from "fs";

/**
 * Execute inline code directly
 */
export async function execInline(code: string, serverUrl: string): Promise<void> {
  await executeScript(code, serverUrl);
}

export async function executeScript(
  script: string,
  serverUrl: string
): Promise<void> {
  // Connect to WebSocket
  let ws: WebSocket;
  try {
    ws = new WebSocket(serverUrl);
  } catch (error) {
    console.error(
      `Error connecting to ${serverUrl}:`,
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }

  const id = generateId();
  const responsePromise = new Promise<ExecResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Timeout waiting for response (30s)"));
    }, 30000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ script, id }));
    };

    ws.onmessage = (event) => {
      clearTimeout(timeout);
      try {
        const response = JSON.parse(event.data as string) as ExecResponse;
        if (response.id === id) {
          ws.close();
          resolve(response);
        }
      } catch (error) {
        ws.close();
        reject(
          new Error(
            `Invalid response: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
      }
    };

    ws.onerror = (error) => {
      clearTimeout(timeout);
      ws.close();
      reject(new Error(`WebSocket error: ${error}`));
    };

    ws.onclose = (event) => {
      clearTimeout(timeout);
      if (!event.wasClean) {
        reject(
          new Error(`Connection closed unexpectedly (code: ${event.code})`)
        );
      }
    };
  });

  try {
    const response = await responsePromise;

    if (response.error) {
      console.error(response.error);
      process.exit(1);
    }

    if (response.result) {
      // Output result to stdout (trim trailing newline if present for clean piping)
      const output = response.result;
      process.stdout.write(output);
    }

    process.exit(0);
  } catch (error) {
    console.error(
      "Execution failed:",
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }
}

async function resolveScriptPath(file: string): Promise<string> {
  // Try the path as-is first
  if (existsSync(file)) {
    return file;
  }

  // If not found, try in scripts directory
  const config = await get_config();
  const fallbackPath = `${config.scripts_dir}/${file}`;
  if (existsSync(fallbackPath)) {
    return fallbackPath;
  }

  // Return original path so error message is accurate
  return file;
}

export async function getScriptFromArgs(
  evalScript: string | undefined,
  args: string[]
): Promise<string> {
  let script: string;

  if (evalScript) {
    script = evalScript;
  } else if (args.length > 0) {
    const filePath = await resolveScriptPath(args[0]);
    try {
      script = await Bun.file(filePath).text();
    } catch (error) {
      console.error(
        `Error reading file '${filePath}':`,
        error instanceof Error ? error.message : String(error)
      );
      process.exit(1);
    }
  } else {
    // Check if stdin is a TTY (interactive terminal)
    if (process.stdin.isTTY) {
      console.error("Error: No script provided");
      console.error(
        "Usage: lootbox [file] or lootbox -e 'script' or pipe via stdin"
      );
      console.error("Run 'lootbox --help' for more information");
      process.exit(1);
    }
    // Read from stdin
    return await readStdin();
  }

  // If stdin is piped, prepend it as a global variable for both -e and file cases
  if (!process.stdin.isTTY) {
    const stdinData = await readStdin();
    script = `const $STDIN = ${JSON.stringify(stdinData)};
const stdin = (defaultValue = "") => {
  const value = typeof $STDIN !== 'undefined' ? $STDIN : defaultValue;
  return {
    text: () => value.trim(),
    json: () => { try { return JSON.parse(value); } catch { return null; } },
    lines: () => value.split('\\n').filter(l => l.trim()),
    raw: () => value
  };
};
${script}`;
  }

  return script;
}
