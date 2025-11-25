import { existsSync } from "fs";
import { mkdir } from "fs/promises";

export async function init(): Promise<void> {
  const lootboxDir = ".lootbox";
  const configFile = "lootbox.config.json";

  // Check for existing files/directories
  const conflicts: string[] = [];

  if (existsSync(lootboxDir)) {
    conflicts.push(lootboxDir);
  }

  if (existsSync(configFile)) {
    conflicts.push(configFile);
  }

  if (conflicts.length > 0) {
    console.error("Error: The following files/directories already exist:");
    conflicts.forEach((c) => console.error(`  - ${c}`));
    console.error("\nPlease remove them or run init in a different directory.");
    process.exit(1);
  }

  // Create directory structure
  await mkdir(`${lootboxDir}/tools`, { recursive: true });
  await mkdir(`${lootboxDir}/workflows`, { recursive: true });
  await mkdir(`${lootboxDir}/scripts`, { recursive: true });

  // Create config file with defaults
  const defaultConfig = {
    port: 3000,
    lootboxRoot: ".lootbox",
  };

  await Bun.write(
    configFile,
    JSON.stringify(defaultConfig, null, 2) + "\n"
  );

  // Success message
  console.log("✓ Created .lootbox/");
  console.log("✓ Created .lootbox/tools/");
  console.log("✓ Created .lootbox/workflows/");
  console.log("✓ Created .lootbox/scripts/");
  console.log("✓ Created lootbox.config.json");
  console.log("\nReady! Start server: lootbox server");
}
