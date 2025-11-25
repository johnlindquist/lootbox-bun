import type { Config } from "./types.ts";

export async function loadConfig(): Promise<Config> {
  try {
    const configText = await Bun.file("lootbox.config.json").text();
    return JSON.parse(configText);
  } catch {
    return {};
  }
}
