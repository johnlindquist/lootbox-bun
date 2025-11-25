// RPC file discovery and type generation

import { get_config } from "../get_config.ts";
import { getUserLootboxToolsDir } from "../paths.ts";
import { stat, readdir, realpath } from "fs/promises";
import { join } from "path";

export interface RpcFile {
  name: string;
  path: string;
}

async function discoverToolsInDir(
  toolsDir: string
): Promise<Map<string, string>> {
  const tools = new Map<string, string>();

  try {
    const dirStat = await stat(toolsDir).catch(() => null);
    if (!dirStat?.isDirectory()) {
      return tools;
    }

    const entries = await readdir(toolsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".ts")) {
        const filePath = join(toolsDir, entry.name);
        const absolutePath = await realpath(filePath);
        const name = entry.name.replace(".ts", "");
        tools.set(name, absolutePath);
      }
    }
  } catch (err) {
    console.error(`Failed to discover tools in ${toolsDir}:`, err);
  }

  return tools;
}

export const discover_rpc_files = async (): Promise<RpcFile[]> => {
  const config = await get_config();
  const projectToolsDir = config.tools_dir;
  const globalToolsDir = getUserLootboxToolsDir();

  // Load from global tools directory (~/.lootbox/tools)
  const globalTools = await discoverToolsInDir(globalToolsDir);

  // Load from project tools directory (.lootbox/tools)
  const projectTools = await discoverToolsInDir(projectToolsDir);

  // Merge: project tools override global tools with same name
  const mergedTools = new Map([...globalTools, ...projectTools]);

  const files: RpcFile[] = Array.from(mergedTools.entries()).map(
    ([name, path]) => ({
      name,
      path,
    })
  );

  return files;
};

export const generate_types = async (): Promise<string> => {
  const files = await discover_rpc_files();

  if (files.length === 0) {
    return "// No RPC files found";
  }

  const { TypeExtractor } = await import("../type_system/type_extractor.ts");
  const { ClientGenerator } = await import(
    "../type_system/client_generator.ts"
  );

  const extractor = new TypeExtractor();
  const generator = new ClientGenerator();
  const extractionResults: ReturnType<InstanceType<typeof TypeExtractor>["extractFromFile"]>[] = [];

  for (const file of files) {
    const result = extractor.extractFromFile(file.path);
    extractionResults.push(result);
  }

  return generator.generateTypesOnly(extractionResults);
};
