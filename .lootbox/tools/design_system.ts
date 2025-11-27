/**
 * Design System Tools
 *
 * Tools for AI agents to iteratively build design systems following a
 * progressive workflow: Foundation → Primitives → Components → Patterns → Pages
 *
 * Inspired by the long_agent pattern for multi-session work, this toolset
 * tracks design decisions and enables incremental, validated progress.
 *
 * Key concepts:
 * - Design tokens: JSON structure tracking all design decisions
 * - Layers: Progressive stages (foundation, primitives, components, patterns, pages)
 * - Iterations: History of design changes for review/rollback
 * - Outputs: Generated CSS variables, Tailwind config, JSON tokens
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger, extractErrorMessage } from "./shared/index.ts";

const log = createLogger("design_system");

// File names
const TOKENS_FILE = "design_tokens.json";
const PROGRESS_FILE = "design-progress.txt";
const OUTPUT_DIR = "output";

// Layer order (must progress through in sequence)
const LAYER_ORDER = ["foundation", "primitives", "components", "patterns", "pages"] as const;
type Layer = (typeof LAYER_ORDER)[number];

// Token categories within foundation layer
const FOUNDATION_CATEGORIES = ["colors", "typography", "spacing", "borders", "shadows", "animation"] as const;
type FoundationCategory = (typeof FOUNDATION_CATEGORIES)[number];

// Design token interfaces
interface ColorToken {
  value: string;
  description?: string;
  category?: "primitive" | "semantic" | "component";
}

interface TypographyToken {
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string | number;
  lineHeight?: string | number;
  letterSpacing?: string;
  description?: string;
}

interface SpacingToken {
  value: string;
  description?: string;
}

interface ComponentToken {
  name: string;
  description?: string;
  variants?: Record<string, Record<string, string>>;
  states?: Record<string, Record<string, string>>;
  tokens: Record<string, string>;
}

interface DesignIteration {
  id: number;
  timestamp: string;
  layer: Layer;
  category?: string;
  action: string;
  changes: string[];
  notes?: string;
}

interface DesignTokens {
  name: string;
  version: string;
  description: string;
  layers: {
    foundation: {
      colors: Record<string, ColorToken>;
      typography: Record<string, TypographyToken>;
      spacing: Record<string, SpacingToken>;
      borders: Record<string, string>;
      shadows: Record<string, string>;
      animation: Record<string, string>;
      finalized: boolean;
    };
    primitives: {
      components: Record<string, ComponentToken>;
      finalized: boolean;
    };
    components: {
      components: Record<string, ComponentToken>;
      finalized: boolean;
    };
    patterns: {
      patterns: Record<string, ComponentToken>;
      finalized: boolean;
    };
    pages: {
      templates: Record<string, { description: string; components: string[] }>;
      finalized: boolean;
    };
  };
  progress: {
    currentLayer: Layer;
    currentCategory?: string;
    iterations: DesignIteration[];
  };
  metadata: {
    created: string;
    lastUpdated: string;
    iterationCount: number;
  };
}

/**
 * Initialize a design system project
 *
 * Creates the foundational structure for iterative design system development:
 * - design_tokens.json for tracking all design decisions
 * - design-progress.txt for iteration history
 * - output/ directory for generated files
 *
 * @param args.project_path - Path to the project directory
 * @param args.name - Name of the design system
 * @param args.description - Description of the design system
 */
export async function init_design_system(args: {
  project_path: string;
  name: string;
  description?: string;
}): Promise<{
  success: boolean;
  files_created?: string[];
  error?: string;
}> {
  log.call("init_design_system", args);

  const { project_path, name, description = "" } = args;

  try {
    // Ensure directories exist
    if (!existsSync(project_path)) {
      mkdirSync(project_path, { recursive: true });
    }
    mkdirSync(join(project_path, OUTPUT_DIR), { recursive: true });

    const filesCreated: string[] = [];

    // Create design tokens file
    const tokensPath = join(project_path, TOKENS_FILE);
    const tokens: DesignTokens = {
      name,
      version: "0.1.0",
      description,
      layers: {
        foundation: {
          colors: {},
          typography: {},
          spacing: {},
          borders: {},
          shadows: {},
          animation: {},
          finalized: false,
        },
        primitives: {
          components: {},
          finalized: false,
        },
        components: {
          components: {},
          finalized: false,
        },
        patterns: {
          patterns: {},
          finalized: false,
        },
        pages: {
          templates: {},
          finalized: false,
        },
      },
      progress: {
        currentLayer: "foundation",
        currentCategory: "colors",
        iterations: [],
      },
      metadata: {
        created: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        iterationCount: 0,
      },
    };
    writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
    filesCreated.push(TOKENS_FILE);

    // Create progress file
    const progressPath = join(project_path, PROGRESS_FILE);
    const progressContent = `# ${name} - Design System Progress

## Description
${description}

## Design Workflow

Work through layers progressively:
1. **Foundation** - Colors, typography, spacing, borders, shadows
2. **Primitives** - Buttons, inputs, badges, icons
3. **Components** - Cards, modals, dropdowns, forms
4. **Patterns** - Navigation, sidebars, layouts
5. **Pages** - Dashboard, settings, list/detail templates

## Progress Log

### Iteration 1 - ${new Date().toISOString().split("T")[0]}
- Design system initialized
- Starting with foundation layer: colors

---
## Guidelines

1. Complete each layer before moving to the next
2. Use semantic naming (not "blue-500", but "primary", "success")
3. Document design decisions with descriptions
4. Generate outputs after major changes to preview
5. Validate tokens before finalizing layers

`;
    writeFileSync(progressPath, progressContent);
    filesCreated.push(PROGRESS_FILE);

    // Create output directory placeholder
    filesCreated.push(OUTPUT_DIR + "/");

    log.success("init_design_system", { filesCreated });
    return { success: true, files_created: filesCreated };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("init_design_system", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Get current design system status
 *
 * Returns progress information and what to work on next.
 *
 * @param args.project_path - Path to the project directory
 */
export async function get_design_status(args: {
  project_path: string;
}): Promise<{
  success: boolean;
  status?: {
    name: string;
    currentLayer: Layer;
    currentCategory?: string;
    layerProgress: Record<Layer, { finalized: boolean; itemCount: number }>;
    totalIterations: number;
    nextStep: string;
  };
  error?: string;
}> {
  log.call("get_design_status", args);

  const { project_path } = args;
  const tokensPath = join(project_path, TOKENS_FILE);

  try {
    if (!existsSync(tokensPath)) {
      return { success: false, error: `Design tokens file not found: ${tokensPath}` };
    }

    const tokens: DesignTokens = JSON.parse(readFileSync(tokensPath, "utf-8"));

    const layerProgress: Record<Layer, { finalized: boolean; itemCount: number }> = {
      foundation: {
        finalized: tokens.layers.foundation.finalized,
        itemCount:
          Object.keys(tokens.layers.foundation.colors).length +
          Object.keys(tokens.layers.foundation.typography).length +
          Object.keys(tokens.layers.foundation.spacing).length,
      },
      primitives: {
        finalized: tokens.layers.primitives.finalized,
        itemCount: Object.keys(tokens.layers.primitives.components).length,
      },
      components: {
        finalized: tokens.layers.components.finalized,
        itemCount: Object.keys(tokens.layers.components.components).length,
      },
      patterns: {
        finalized: tokens.layers.patterns.finalized,
        itemCount: Object.keys(tokens.layers.patterns.patterns).length,
      },
      pages: {
        finalized: tokens.layers.pages.finalized,
        itemCount: Object.keys(tokens.layers.pages.templates).length,
      },
    };

    // Determine next step
    let nextStep = "";
    const currentLayer = tokens.progress.currentLayer;

    if (currentLayer === "foundation") {
      const f = tokens.layers.foundation;
      if (Object.keys(f.colors).length === 0) {
        nextStep = "Define color palette with define_colors()";
      } else if (Object.keys(f.typography).length === 0) {
        nextStep = "Define typography scale with define_typography()";
      } else if (Object.keys(f.spacing).length === 0) {
        nextStep = "Define spacing scale with define_spacing()";
      } else if (!f.finalized) {
        nextStep = "Finalize foundation layer with finalize_layer()";
      }
    } else if (!tokens.layers[currentLayer].finalized) {
      nextStep = `Add ${currentLayer} definitions or finalize_layer() when complete`;
    } else {
      nextStep = "Design system complete! Generate final outputs.";
    }

    const status = {
      name: tokens.name,
      currentLayer,
      currentCategory: tokens.progress.currentCategory,
      layerProgress,
      totalIterations: tokens.metadata.iterationCount,
      nextStep,
    };

    log.success("get_design_status", status);
    return { success: true, status };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("get_design_status", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Define or update color palette
 *
 * Colors should follow a progression:
 * 1. Primitive colors (gray-50, blue-500, etc.)
 * 2. Semantic colors (background, foreground, primary, success, error)
 *
 * @param args.project_path - Path to the project directory
 * @param args.colors - Color definitions
 * @param args.notes - Notes about this color update
 */
export async function define_colors(args: {
  project_path: string;
  colors: Record<string, { value: string; description?: string; category?: "primitive" | "semantic" | "component" }>;
  notes?: string;
}): Promise<{
  success: boolean;
  added_count?: number;
  error?: string;
}> {
  log.call("define_colors", args);

  const { project_path, colors, notes } = args;
  const tokensPath = join(project_path, TOKENS_FILE);

  try {
    if (!existsSync(tokensPath)) {
      return { success: false, error: `Design tokens file not found: ${tokensPath}` };
    }

    const tokens: DesignTokens = JSON.parse(readFileSync(tokensPath, "utf-8"));

    if (tokens.layers.foundation.finalized) {
      return { success: false, error: "Foundation layer is finalized. Cannot modify colors." };
    }

    // Add/update colors
    const changes: string[] = [];
    for (const [name, color] of Object.entries(colors)) {
      const isNew = !tokens.layers.foundation.colors[name];
      tokens.layers.foundation.colors[name] = color;
      changes.push(`${isNew ? "Added" : "Updated"} color: ${name} = ${color.value}`);
    }

    // Record iteration
    tokens.metadata.iterationCount++;
    tokens.progress.iterations.push({
      id: tokens.metadata.iterationCount,
      timestamp: new Date().toISOString(),
      layer: "foundation",
      category: "colors",
      action: "define_colors",
      changes,
      notes,
    });

    tokens.progress.currentCategory = "colors";
    tokens.metadata.lastUpdated = new Date().toISOString();

    writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));

    log.success("define_colors", { added_count: Object.keys(colors).length });
    return { success: true, added_count: Object.keys(colors).length };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("define_colors", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Define or update typography scale
 *
 * Typography should include:
 * - Font families (sans, serif, mono)
 * - Size scale (xs, sm, base, lg, xl, 2xl, etc.)
 * - Font weights
 * - Line heights
 *
 * @param args.project_path - Path to the project directory
 * @param args.typography - Typography definitions
 * @param args.notes - Notes about this typography update
 */
export async function define_typography(args: {
  project_path: string;
  typography: Record<
    string,
    {
      fontFamily?: string;
      fontSize?: string;
      fontWeight?: string | number;
      lineHeight?: string | number;
      letterSpacing?: string;
      description?: string;
    }
  >;
  notes?: string;
}): Promise<{
  success: boolean;
  added_count?: number;
  error?: string;
}> {
  log.call("define_typography", args);

  const { project_path, typography, notes } = args;
  const tokensPath = join(project_path, TOKENS_FILE);

  try {
    if (!existsSync(tokensPath)) {
      return { success: false, error: `Design tokens file not found: ${tokensPath}` };
    }

    const tokens: DesignTokens = JSON.parse(readFileSync(tokensPath, "utf-8"));

    if (tokens.layers.foundation.finalized) {
      return { success: false, error: "Foundation layer is finalized. Cannot modify typography." };
    }

    // Add/update typography
    const changes: string[] = [];
    for (const [name, type] of Object.entries(typography)) {
      const isNew = !tokens.layers.foundation.typography[name];
      tokens.layers.foundation.typography[name] = type;
      changes.push(`${isNew ? "Added" : "Updated"} typography: ${name}`);
    }

    // Record iteration
    tokens.metadata.iterationCount++;
    tokens.progress.iterations.push({
      id: tokens.metadata.iterationCount,
      timestamp: new Date().toISOString(),
      layer: "foundation",
      category: "typography",
      action: "define_typography",
      changes,
      notes,
    });

    tokens.progress.currentCategory = "typography";
    tokens.metadata.lastUpdated = new Date().toISOString();

    writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));

    log.success("define_typography", { added_count: Object.keys(typography).length });
    return { success: true, added_count: Object.keys(typography).length };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("define_typography", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Define or update spacing scale
 *
 * Spacing should follow a consistent scale (e.g., 4px base):
 * - 0, 1 (4px), 2 (8px), 3 (12px), 4 (16px), etc.
 * - Or named: xs, sm, md, lg, xl
 *
 * @param args.project_path - Path to the project directory
 * @param args.spacing - Spacing definitions
 * @param args.notes - Notes about this spacing update
 */
export async function define_spacing(args: {
  project_path: string;
  spacing: Record<string, { value: string; description?: string }>;
  notes?: string;
}): Promise<{
  success: boolean;
  added_count?: number;
  error?: string;
}> {
  log.call("define_spacing", args);

  const { project_path, spacing, notes } = args;
  const tokensPath = join(project_path, TOKENS_FILE);

  try {
    if (!existsSync(tokensPath)) {
      return { success: false, error: `Design tokens file not found: ${tokensPath}` };
    }

    const tokens: DesignTokens = JSON.parse(readFileSync(tokensPath, "utf-8"));

    if (tokens.layers.foundation.finalized) {
      return { success: false, error: "Foundation layer is finalized. Cannot modify spacing." };
    }

    // Add/update spacing
    const changes: string[] = [];
    for (const [name, space] of Object.entries(spacing)) {
      const isNew = !tokens.layers.foundation.spacing[name];
      tokens.layers.foundation.spacing[name] = space;
      changes.push(`${isNew ? "Added" : "Updated"} spacing: ${name} = ${space.value}`);
    }

    // Record iteration
    tokens.metadata.iterationCount++;
    tokens.progress.iterations.push({
      id: tokens.metadata.iterationCount,
      timestamp: new Date().toISOString(),
      layer: "foundation",
      category: "spacing",
      action: "define_spacing",
      changes,
      notes,
    });

    tokens.progress.currentCategory = "spacing";
    tokens.metadata.lastUpdated = new Date().toISOString();

    writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));

    log.success("define_spacing", { added_count: Object.keys(spacing).length });
    return { success: true, added_count: Object.keys(spacing).length };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("define_spacing", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Define additional foundation tokens (borders, shadows, animation)
 *
 * @param args.project_path - Path to the project directory
 * @param args.category - Which foundation category to update
 * @param args.tokens - Token definitions
 * @param args.notes - Notes about this update
 */
export async function define_foundation_tokens(args: {
  project_path: string;
  category: "borders" | "shadows" | "animation";
  tokens: Record<string, string>;
  notes?: string;
}): Promise<{
  success: boolean;
  added_count?: number;
  error?: string;
}> {
  log.call("define_foundation_tokens", args);

  const { project_path, category, tokens: newTokens, notes } = args;
  const tokensPath = join(project_path, TOKENS_FILE);

  try {
    if (!existsSync(tokensPath)) {
      return { success: false, error: `Design tokens file not found: ${tokensPath}` };
    }

    const tokens: DesignTokens = JSON.parse(readFileSync(tokensPath, "utf-8"));

    if (tokens.layers.foundation.finalized) {
      return { success: false, error: "Foundation layer is finalized. Cannot modify tokens." };
    }

    // Add/update tokens
    const changes: string[] = [];
    for (const [name, value] of Object.entries(newTokens)) {
      const isNew = !tokens.layers.foundation[category][name];
      tokens.layers.foundation[category][name] = value;
      changes.push(`${isNew ? "Added" : "Updated"} ${category}: ${name} = ${value}`);
    }

    // Record iteration
    tokens.metadata.iterationCount++;
    tokens.progress.iterations.push({
      id: tokens.metadata.iterationCount,
      timestamp: new Date().toISOString(),
      layer: "foundation",
      category,
      action: "define_foundation_tokens",
      changes,
      notes,
    });

    tokens.progress.currentCategory = category;
    tokens.metadata.lastUpdated = new Date().toISOString();

    writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));

    log.success("define_foundation_tokens", { added_count: Object.keys(newTokens).length });
    return { success: true, added_count: Object.keys(newTokens).length };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("define_foundation_tokens", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Add a component definition to the current layer
 *
 * Components can be added to: primitives, components, or patterns layers.
 *
 * @param args.project_path - Path to the project directory
 * @param args.layer - Which layer (primitives, components, or patterns)
 * @param args.name - Component name
 * @param args.component - Component definition
 * @param args.notes - Notes about this component
 */
export async function add_component(args: {
  project_path: string;
  layer: "primitives" | "components" | "patterns";
  name: string;
  component: {
    description?: string;
    variants?: Record<string, Record<string, string>>;
    states?: Record<string, Record<string, string>>;
    tokens: Record<string, string>;
  };
  notes?: string;
}): Promise<{
  success: boolean;
  error?: string;
}> {
  log.call("add_component", args);

  const { project_path, layer, name, component, notes } = args;
  const tokensPath = join(project_path, TOKENS_FILE);

  try {
    if (!existsSync(tokensPath)) {
      return { success: false, error: `Design tokens file not found: ${tokensPath}` };
    }

    const tokens: DesignTokens = JSON.parse(readFileSync(tokensPath, "utf-8"));

    // Check layer dependencies
    const currentLayerIndex = LAYER_ORDER.indexOf(tokens.progress.currentLayer);
    const targetLayerIndex = LAYER_ORDER.indexOf(layer);

    if (targetLayerIndex < currentLayerIndex) {
      return { success: false, error: `Cannot add to ${layer} layer - already past that layer` };
    }

    if (targetLayerIndex > currentLayerIndex + 1) {
      return { success: false, error: `Cannot add to ${layer} layer - must complete ${tokens.progress.currentLayer} first` };
    }

    // Check if previous layer is finalized
    if (targetLayerIndex > 0) {
      const prevLayer = LAYER_ORDER[targetLayerIndex - 1];
      if (!tokens.layers[prevLayer].finalized) {
        return { success: false, error: `Cannot add to ${layer} - ${prevLayer} layer not finalized` };
      }
    }

    // Add component
    const targetLayer = layer === "patterns" ? tokens.layers.patterns.patterns : tokens.layers[layer].components;
    const isNew = !targetLayer[name];
    targetLayer[name] = { name, ...component };

    // Update progress
    if (targetLayerIndex > currentLayerIndex) {
      tokens.progress.currentLayer = layer;
    }

    // Record iteration
    tokens.metadata.iterationCount++;
    tokens.progress.iterations.push({
      id: tokens.metadata.iterationCount,
      timestamp: new Date().toISOString(),
      layer,
      action: "add_component",
      changes: [`${isNew ? "Added" : "Updated"} ${layer} component: ${name}`],
      notes,
    });

    tokens.metadata.lastUpdated = new Date().toISOString();

    writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));

    log.success("add_component", { layer, name });
    return { success: true };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("add_component", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Finalize a layer and progress to the next
 *
 * @param args.project_path - Path to the project directory
 * @param args.layer - Layer to finalize (must be current layer)
 * @param args.notes - Notes about finalizing
 */
export async function finalize_layer(args: {
  project_path: string;
  layer: Layer;
  notes?: string;
}): Promise<{
  success: boolean;
  next_layer?: Layer | "complete";
  error?: string;
}> {
  log.call("finalize_layer", args);

  const { project_path, layer, notes } = args;
  const tokensPath = join(project_path, TOKENS_FILE);

  try {
    if (!existsSync(tokensPath)) {
      return { success: false, error: `Design tokens file not found: ${tokensPath}` };
    }

    const tokens: DesignTokens = JSON.parse(readFileSync(tokensPath, "utf-8"));

    if (tokens.progress.currentLayer !== layer) {
      return { success: false, error: `Can only finalize current layer (${tokens.progress.currentLayer})` };
    }

    // Validate layer has content
    if (layer === "foundation") {
      const f = tokens.layers.foundation;
      if (Object.keys(f.colors).length === 0) {
        return { success: false, error: "Foundation layer needs colors defined" };
      }
      if (Object.keys(f.typography).length === 0) {
        return { success: false, error: "Foundation layer needs typography defined" };
      }
      if (Object.keys(f.spacing).length === 0) {
        return { success: false, error: "Foundation layer needs spacing defined" };
      }
    }

    // Finalize layer
    tokens.layers[layer].finalized = true;

    // Progress to next layer
    const currentIndex = LAYER_ORDER.indexOf(layer);
    const nextLayer = currentIndex < LAYER_ORDER.length - 1 ? LAYER_ORDER[currentIndex + 1] : null;

    if (nextLayer) {
      tokens.progress.currentLayer = nextLayer;
      tokens.progress.currentCategory = undefined;
    }

    // Record iteration
    tokens.metadata.iterationCount++;
    tokens.progress.iterations.push({
      id: tokens.metadata.iterationCount,
      timestamp: new Date().toISOString(),
      layer,
      action: "finalize_layer",
      changes: [`Finalized ${layer} layer`],
      notes,
    });

    tokens.metadata.lastUpdated = new Date().toISOString();

    writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));

    log.success("finalize_layer", { layer, next_layer: nextLayer || "complete" });
    return { success: true, next_layer: nextLayer || "complete" };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("finalize_layer", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Generate output files (CSS variables, Tailwind config, JSON)
 *
 * @param args.project_path - Path to the project directory
 * @param args.formats - Which formats to generate
 */
export async function generate_output(args: {
  project_path: string;
  formats?: ("css" | "tailwind" | "json")[];
}): Promise<{
  success: boolean;
  files_generated?: string[];
  error?: string;
}> {
  log.call("generate_output", args);

  const { project_path, formats = ["css", "tailwind", "json"] } = args;
  const tokensPath = join(project_path, TOKENS_FILE);

  try {
    if (!existsSync(tokensPath)) {
      return { success: false, error: `Design tokens file not found: ${tokensPath}` };
    }

    const tokens: DesignTokens = JSON.parse(readFileSync(tokensPath, "utf-8"));
    const outputDir = join(project_path, OUTPUT_DIR);
    mkdirSync(outputDir, { recursive: true });

    const filesGenerated: string[] = [];
    const foundation = tokens.layers.foundation;

    // Generate CSS variables
    if (formats.includes("css")) {
      let css = `:root {\n  /* Colors */\n`;

      for (const [name, color] of Object.entries(foundation.colors)) {
        css += `  --color-${name}: ${color.value};\n`;
      }

      css += `\n  /* Typography */\n`;
      for (const [name, type] of Object.entries(foundation.typography)) {
        if (type.fontFamily) css += `  --font-${name}: ${type.fontFamily};\n`;
        if (type.fontSize) css += `  --text-${name}: ${type.fontSize};\n`;
        if (type.fontWeight) css += `  --font-weight-${name}: ${type.fontWeight};\n`;
        if (type.lineHeight) css += `  --leading-${name}: ${type.lineHeight};\n`;
      }

      css += `\n  /* Spacing */\n`;
      for (const [name, space] of Object.entries(foundation.spacing)) {
        css += `  --spacing-${name}: ${space.value};\n`;
      }

      css += `\n  /* Borders */\n`;
      for (const [name, value] of Object.entries(foundation.borders)) {
        css += `  --border-${name}: ${value};\n`;
      }

      css += `\n  /* Shadows */\n`;
      for (const [name, value] of Object.entries(foundation.shadows)) {
        css += `  --shadow-${name}: ${value};\n`;
      }

      css += `}\n`;

      writeFileSync(join(outputDir, "variables.css"), css);
      filesGenerated.push("output/variables.css");
    }

    // Generate Tailwind config
    if (formats.includes("tailwind")) {
      const tailwindConfig = {
        theme: {
          extend: {
            colors: Object.fromEntries(
              Object.entries(foundation.colors).map(([name, color]) => [name, color.value])
            ),
            spacing: Object.fromEntries(
              Object.entries(foundation.spacing).map(([name, space]) => [name, space.value])
            ),
            fontFamily: Object.fromEntries(
              Object.entries(foundation.typography)
                .filter(([_, t]) => t.fontFamily)
                .map(([name, t]) => [name, t.fontFamily])
            ),
            fontSize: Object.fromEntries(
              Object.entries(foundation.typography)
                .filter(([_, t]) => t.fontSize)
                .map(([name, t]) => [
                  name,
                  [t.fontSize, { lineHeight: t.lineHeight?.toString() || "1.5" }],
                ])
            ),
            borderRadius: foundation.borders,
            boxShadow: foundation.shadows,
          },
        },
      };

      writeFileSync(
        join(outputDir, "tailwind.config.js"),
        `/** @type {import('tailwindcss').Config} */\nmodule.exports = ${JSON.stringify(tailwindConfig, null, 2)}`
      );
      filesGenerated.push("output/tailwind.config.js");
    }

    // Generate JSON tokens
    if (formats.includes("json")) {
      writeFileSync(join(outputDir, "tokens.json"), JSON.stringify(tokens, null, 2));
      filesGenerated.push("output/tokens.json");
    }

    log.success("generate_output", { filesGenerated });
    return { success: true, files_generated: filesGenerated };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("generate_output", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Generate an HTML preview of the design system
 *
 * @param args.project_path - Path to the project directory
 */
export async function generate_preview(args: {
  project_path: string;
}): Promise<{
  success: boolean;
  preview_path?: string;
  error?: string;
}> {
  log.call("generate_preview", args);

  const { project_path } = args;
  const tokensPath = join(project_path, TOKENS_FILE);

  try {
    if (!existsSync(tokensPath)) {
      return { success: false, error: `Design tokens file not found: ${tokensPath}` };
    }

    const tokens: DesignTokens = JSON.parse(readFileSync(tokensPath, "utf-8"));
    const outputDir = join(project_path, OUTPUT_DIR);
    mkdirSync(outputDir, { recursive: true });

    const foundation = tokens.layers.foundation;

    // Generate HTML preview
    let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${tokens.name} - Design System Preview</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; padding: 2rem; background: #f5f5f5; }
    h1 { margin-bottom: 2rem; }
    h2 { margin: 2rem 0 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid #ddd; }
    h3 { margin: 1rem 0 0.5rem; color: #666; font-size: 0.875rem; text-transform: uppercase; }
    .section { background: white; padding: 1.5rem; border-radius: 8px; margin-bottom: 1rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 1rem; }
    .color-swatch { height: 80px; border-radius: 8px; display: flex; align-items: end; padding: 0.5rem; }
    .color-swatch span { background: white; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.75rem; }
    .type-sample { margin: 0.5rem 0; }
    .spacing-sample { background: #3b82f6; height: 24px; border-radius: 4px; }
    .label { font-size: 0.75rem; color: #666; margin-top: 0.25rem; }
  </style>
</head>
<body>
  <h1>${tokens.name}</h1>
  <p>${tokens.description}</p>

  <h2>Colors</h2>
  <div class="section">
    <div class="grid">
`;

    for (const [name, color] of Object.entries(foundation.colors)) {
      html += `      <div>
        <div class="color-swatch" style="background: ${color.value};">
          <span>${color.value}</span>
        </div>
        <div class="label">${name}</div>
      </div>\n`;
    }

    html += `    </div>
  </div>

  <h2>Typography</h2>
  <div class="section">
`;

    for (const [name, type] of Object.entries(foundation.typography)) {
      const style = [
        type.fontFamily ? `font-family: ${type.fontFamily}` : "",
        type.fontSize ? `font-size: ${type.fontSize}` : "",
        type.fontWeight ? `font-weight: ${type.fontWeight}` : "",
        type.lineHeight ? `line-height: ${type.lineHeight}` : "",
      ]
        .filter(Boolean)
        .join("; ");

      html += `    <div class="type-sample" style="${style}">
      ${name}: The quick brown fox jumps over the lazy dog
    </div>\n`;
    }

    html += `  </div>

  <h2>Spacing</h2>
  <div class="section">
`;

    for (const [name, space] of Object.entries(foundation.spacing)) {
      html += `    <div style="margin-bottom: 0.5rem;">
      <div class="spacing-sample" style="width: ${space.value};"></div>
      <div class="label">${name}: ${space.value}</div>
    </div>\n`;
    }

    html += `  </div>
</body>
</html>`;

    const previewPath = join(outputDir, "preview.html");
    writeFileSync(previewPath, html);

    log.success("generate_preview", { preview_path: previewPath });
    return { success: true, preview_path: previewPath };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("generate_preview", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Validate design tokens for consistency issues
 *
 * @param args.project_path - Path to the project directory
 */
export async function validate_tokens(args: {
  project_path: string;
}): Promise<{
  success: boolean;
  issues?: { severity: "error" | "warning" | "info"; message: string }[];
  error?: string;
}> {
  log.call("validate_tokens", args);

  const { project_path } = args;
  const tokensPath = join(project_path, TOKENS_FILE);

  try {
    if (!existsSync(tokensPath)) {
      return { success: false, error: `Design tokens file not found: ${tokensPath}` };
    }

    const tokens: DesignTokens = JSON.parse(readFileSync(tokensPath, "utf-8"));
    const issues: { severity: "error" | "warning" | "info"; message: string }[] = [];

    const foundation = tokens.layers.foundation;

    // Check for empty categories
    if (Object.keys(foundation.colors).length === 0) {
      issues.push({ severity: "error", message: "No colors defined" });
    }
    if (Object.keys(foundation.typography).length === 0) {
      issues.push({ severity: "error", message: "No typography defined" });
    }
    if (Object.keys(foundation.spacing).length === 0) {
      issues.push({ severity: "error", message: "No spacing defined" });
    }

    // Check for semantic color naming
    const semanticColors = ["primary", "secondary", "background", "foreground", "success", "error", "warning"];
    const hasSemanticColors = semanticColors.some((c) => foundation.colors[c]);
    if (!hasSemanticColors && Object.keys(foundation.colors).length > 0) {
      issues.push({ severity: "warning", message: "Consider adding semantic color names (primary, background, etc.)" });
    }

    // Check color contrast (basic)
    const bgColor = foundation.colors["background"]?.value;
    const fgColor = foundation.colors["foreground"]?.value;
    if (bgColor && fgColor && bgColor === fgColor) {
      issues.push({ severity: "error", message: "Background and foreground colors are identical" });
    }

    // Check spacing consistency
    const spacingValues = Object.values(foundation.spacing).map((s) => s.value);
    const hasInconsistentUnits = new Set(spacingValues.map((v) => v.replace(/[\d.]/g, ""))).size > 1;
    if (hasInconsistentUnits) {
      issues.push({ severity: "warning", message: "Spacing uses inconsistent units (mix of px, rem, etc.)" });
    }

    // Check for common font families
    const typographyValues = Object.values(foundation.typography);
    const hasFontFamily = typographyValues.some((t) => t.fontFamily);
    if (!hasFontFamily && typographyValues.length > 0) {
      issues.push({ severity: "info", message: "Consider defining font families" });
    }

    log.success("validate_tokens", { issues_count: issues.length });
    return { success: true, issues };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("validate_tokens", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Get iteration history
 *
 * @param args.project_path - Path to the project directory
 * @param args.limit - Maximum iterations to return
 */
export async function get_iterations(args: {
  project_path: string;
  limit?: number;
}): Promise<{
  success: boolean;
  iterations?: DesignIteration[];
  error?: string;
}> {
  log.call("get_iterations", args);

  const { project_path, limit = 20 } = args;
  const tokensPath = join(project_path, TOKENS_FILE);

  try {
    if (!existsSync(tokensPath)) {
      return { success: false, error: `Design tokens file not found: ${tokensPath}` };
    }

    const tokens: DesignTokens = JSON.parse(readFileSync(tokensPath, "utf-8"));
    const iterations = tokens.progress.iterations.slice(-limit).reverse();

    log.success("get_iterations", { count: iterations.length });
    return { success: true, iterations };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("get_iterations", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Update the design progress file
 *
 * @param args.project_path - Path to the project directory
 * @param args.session_number - Session number
 * @param args.work_done - Work completed
 * @param args.decisions - Design decisions made
 * @param args.next_steps - Suggested next steps
 */
export async function update_design_progress(args: {
  project_path: string;
  session_number: number;
  work_done: string[];
  decisions?: string[];
  next_steps?: string[];
}): Promise<{
  success: boolean;
  error?: string;
}> {
  log.call("update_design_progress", args);

  const { project_path, session_number, work_done, decisions = [], next_steps = [] } = args;
  const progressPath = join(project_path, PROGRESS_FILE);

  try {
    if (!existsSync(progressPath)) {
      return { success: false, error: `Progress file not found: ${progressPath}` };
    }

    let content = readFileSync(progressPath, "utf-8");

    const sessionEntry = `
### Iteration ${session_number} - ${new Date().toISOString().split("T")[0]}

**Work Completed:**
${work_done.map((w) => `- ${w}`).join("\n")}

${decisions.length > 0 ? `**Design Decisions:**\n${decisions.map((d) => `- ${d}`).join("\n")}\n` : ""}
${next_steps.length > 0 ? `**Next Steps:**\n${next_steps.map((n) => `- ${n}`).join("\n")}\n` : ""}
---
`;

    const insertPoint = content.indexOf("## Progress Log\n");
    if (insertPoint !== -1) {
      const afterHeader = insertPoint + "## Progress Log\n".length;
      content = content.slice(0, afterHeader) + sessionEntry + content.slice(afterHeader);
    } else {
      content += sessionEntry;
    }

    writeFileSync(progressPath, content);

    log.success("update_design_progress", { session_number });
    return { success: true };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("update_design_progress", errorMsg);
    return { success: false, error: errorMsg };
  }
}
