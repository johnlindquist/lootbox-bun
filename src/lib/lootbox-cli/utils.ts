export function generateId(): string {
  return `exec_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export function wsUrlToHttpUrl(wsUrl: string): string {
  // Convert ws://localhost:3000/ws -> http://localhost:3000
  return wsUrl
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/ws$/, "");
}

import { removeSlashes } from "slashes";

export async function readStdin(): Promise<string> {
  // Read stdin using Bun's file API
  const raw = await Bun.stdin.text();
  // Remove bash-escaped backslashes like \!
  return removeSlashes(raw);
}
