/**
 * Gemini Image Analysis Tool - Analyze images using Gemini Pro's vision capabilities
 *
 * This tool wraps the Gemini CLI to provide image analysis, description,
 * and visual understanding capabilities.
 */

import { existsSync, copyFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import {
  createLogger,
  extractErrorMessage,
  type ProgressCallback,
} from "./shared/index.ts";

/** Temporary directory for image files - uses project folder to stay within gemini sandbox */
const IMAGE_TMP_DIR = join(process.cwd(), "tmp_images");

// Create logger for this tool
const log = createLogger("gemini_image");

// Global progress callback - set by the worker when streaming is enabled
let globalProgressCallback: ProgressCallback | null = null;

/**
 * Set the progress callback for streaming updates
 * Called by the worker infrastructure when a streaming call is made
 */
export function setProgressCallback(callback: ProgressCallback | null): void {
  globalProgressCallback = callback;
}

/**
 * Send a progress update if streaming is enabled
 */
function sendProgress(message: string): void {
  if (globalProgressCallback) {
    globalProgressCallback(message);
  }
}

/**
 * Check if a string is a URL
 */
function isUrl(path: string): boolean {
  return path.startsWith("http://") || path.startsWith("https://");
}

/**
 * Prepare a local file for Gemini CLI by copying it to the project's tmp directory.
 * This keeps the file within gemini's sandbox (the project workspace).
 * Returns the path to use with the CLI.
 */
function prepareLocalFile(filePath: string): string {
  // Ensure tmp directory exists within project
  if (!existsSync(IMAGE_TMP_DIR)) {
    mkdirSync(IMAGE_TMP_DIR, { recursive: true });
  }

  // Generate a unique filename to avoid collisions
  const timestamp = Date.now();
  const filename = `${timestamp}_${basename(filePath)}`;
  const destPath = join(IMAGE_TMP_DIR, filename);

  // Copy file to project tmp
  copyFileSync(filePath, destPath);
  log.info(`Copied file to project tmp: ${destPath}`);

  return destPath;
}

/**
 * Execute a Gemini CLI command with an image and return the result
 * Supports both local files and remote URLs
 */
async function runGeminiWithImage(
  image_path: string,
  prompt: string,
  options: { timeout?: number } = {}
): Promise<{ success: boolean; output: string; error?: string }> {
  const { timeout = 120000 } = options;

  try {
    log.info(`Analyzing image: ${image_path}`);
    sendProgress("Starting Gemini image analysis...");

    const startTime = Date.now();

    // Start a progress reporter that sends updates every 5 seconds
    const progressInterval = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      sendProgress(`Gemini processing image... (${elapsed}s elapsed)`);
    }, 5000);

    // Track temp file for cleanup
    let tempFilePath: string | null = null;

    try {
      // For local files, copy to project directory to bypass sandbox
      // For URLs, pass them directly as positional arguments
      let effectivePath: string;
      if (isUrl(image_path)) {
        effectivePath = image_path;
      } else {
        effectivePath = prepareLocalFile(image_path);
        tempFilePath = effectivePath;
      }
      const args = ["gemini", "-m", "pro", "-o", "text", effectivePath, prompt];

      const proc = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        return { success: false, output: "", error: stderr || `Exit code ${exitCode}` };
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      sendProgress(`Gemini completed in ${elapsed}s`);
      return { success: true, output: stdout.trim() };
    } finally {
      clearInterval(progressInterval);
      // Clean up temp file
      if (tempFilePath && existsSync(tempFilePath)) {
        try {
          unlinkSync(tempFilePath);
          log.info(`Cleaned up temp file: ${tempFilePath}`);
        } catch {
          // Silent fail on cleanup
        }
      }
    }
  } catch (error) {
    return { success: false, output: "", error: extractErrorMessage(error) };
  }
}

/**
 * Analyze an image with custom instructions.
 * Accepts both local file paths and remote URLs.
 *
 * @param args.image_path - Path to local image file or URL to remote image
 * @param args.instructions - What to analyze or look for in the image (defaults to detailed description)
 */
export async function analyze_image(args: {
  image_path: string;
  instructions?: string;
}): Promise<{ success: boolean; analysis?: string; error?: string }> {
  log.call("analyze_image", args);
  const { image_path, instructions } = args;

  // Validate local file exists
  if (!isUrl(image_path) && !existsSync(image_path)) {
    const err = `Image file not found: ${image_path}`;
    log.error("analyze_image", err);
    return { success: false, error: err };
  }

  // Default prompt for detailed description
  const prompt = instructions ||
    "Describe this image in explicit detail. Include:\n" +
    "1. Overall scene and composition\n" +
    "2. Main subjects and their positions\n" +
    "3. Colors, lighting, and atmosphere\n" +
    "4. Background elements and context\n" +
    "5. Any text, symbols, or notable features\n" +
    "6. Mood or emotional tone conveyed\n" +
    "Be thorough and specific in your description.";

  const result = await runGeminiWithImage(image_path, prompt);

  if (result.success) {
    log.success("analyze_image", result.output);
    return { success: true, analysis: result.output };
  }
  log.error("analyze_image", result.error || "Unknown error");
  return { success: false, error: result.error };
}

/**
 * Extract text from an image using OCR capabilities.
 *
 * @param args.image_path - Path to local image file or URL to remote image
 * @param args.format - Output format: "plain", "structured", "json"
 */
export async function extract_text(args: {
  image_path: string;
  format?: "plain" | "structured" | "json";
}): Promise<{ success: boolean; text?: string; error?: string }> {
  log.call("extract_text", args);
  const { image_path, format = "plain" } = args;

  // Validate local file exists
  if (!isUrl(image_path) && !existsSync(image_path)) {
    const err = `Image file not found: ${image_path}`;
    log.error("extract_text", err);
    return { success: false, error: err };
  }

  let prompt = "Extract all text visible in this image.";
  if (format === "structured") {
    prompt += " Preserve the layout and structure of the text as much as possible.";
  } else if (format === "json") {
    prompt += " Return the result as a JSON object with text regions and their content.";
  }

  const result = await runGeminiWithImage(image_path, prompt);

  if (result.success) {
    log.success("extract_text", result.output);
    return { success: true, text: result.output };
  }
  log.error("extract_text", result.error || "Unknown error");
  return { success: false, error: result.error };
}

/**
 * Identify objects, people, or elements in an image.
 *
 * @param args.image_path - Path to local image file or URL to remote image
 * @param args.focus - Specific type to identify: "objects", "people", "text", "logos", "all"
 */
export async function identify_elements(args: {
  image_path: string;
  focus?: "objects" | "people" | "text" | "logos" | "all";
}): Promise<{ success: boolean; elements?: string; error?: string }> {
  log.call("identify_elements", args);
  const { image_path, focus = "all" } = args;

  // Validate local file exists
  if (!isUrl(image_path) && !existsSync(image_path)) {
    const err = `Image file not found: ${image_path}`;
    log.error("identify_elements", err);
    return { success: false, error: err };
  }

  let prompt = "";
  switch (focus) {
    case "objects":
      prompt = "List all objects visible in this image. For each object, describe its position and any notable characteristics.";
      break;
    case "people":
      prompt = "Describe any people visible in this image. Include details about their appearance, position, actions, and any visible characteristics.";
      break;
    case "text":
      prompt = "Identify and list all text visible in this image, noting its location and context.";
      break;
    case "logos":
      prompt = "Identify any logos, brands, or company symbols visible in this image. Describe their location and any text associated with them.";
      break;
    default:
      prompt = "Identify and list all notable elements in this image including objects, people, text, logos, and other significant features. Organize by category.";
  }

  const result = await runGeminiWithImage(image_path, prompt);

  if (result.success) {
    log.success("identify_elements", result.output);
    return { success: true, elements: result.output };
  }
  log.error("identify_elements", result.error || "Unknown error");
  return { success: false, error: result.error };
}

/**
 * Compare two images and describe differences or similarities.
 *
 * @param args.image_path_1 - First image path or URL
 * @param args.image_path_2 - Second image path or URL
 * @param args.comparison_type - Type of comparison: "differences", "similarities", "both"
 */
export async function compare_images(args: {
  image_path_1: string;
  image_path_2: string;
  comparison_type?: "differences" | "similarities" | "both";
}): Promise<{ success: boolean; comparison?: string; error?: string }> {
  log.call("compare_images", args);
  const { image_path_1, image_path_2, comparison_type = "both" } = args;

  // Validate local files exist
  if (!isUrl(image_path_1) && !existsSync(image_path_1)) {
    const err = `First image file not found: ${image_path_1}`;
    log.error("compare_images", err);
    return { success: false, error: err };
  }
  if (!isUrl(image_path_2) && !existsSync(image_path_2)) {
    const err = `Second image file not found: ${image_path_2}`;
    log.error("compare_images", err);
    return { success: false, error: err };
  }

  let prompt = "";
  switch (comparison_type) {
    case "differences":
      prompt = "Compare these two images and describe only the differences between them.";
      break;
    case "similarities":
      prompt = "Compare these two images and describe what they have in common.";
      break;
    default:
      prompt = "Compare these two images. First describe what they have in common, then describe the differences between them.";
  }

  // Track temp files for cleanup
  const tempFiles: string[] = [];

  // For comparison, we need to pass both images as positional arguments
  // For local files, copy to project directory to bypass sandbox
  const buildArgs = (): string[] => {
    let effectivePath1: string;
    let effectivePath2: string;

    if (isUrl(image_path_1)) {
      effectivePath1 = image_path_1;
    } else {
      effectivePath1 = prepareLocalFile(image_path_1);
      tempFiles.push(effectivePath1);
    }

    if (isUrl(image_path_2)) {
      effectivePath2 = image_path_2;
    } else {
      effectivePath2 = prepareLocalFile(image_path_2);
      tempFiles.push(effectivePath2);
    }

    return ["gemini", "-m", "pro", "-o", "text", effectivePath1, effectivePath2, prompt];
  };

  try {
    sendProgress("Starting Gemini image comparison...");
    const startTime = Date.now();

    const progressInterval = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      sendProgress(`Gemini comparing images... (${elapsed}s elapsed)`);
    }, 5000);

    try {
      const proc = Bun.spawn(buildArgs(), {
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const err = stderr || `Exit code ${exitCode}`;
        log.error("compare_images", err);
        return { success: false, error: err };
      }

      const output = stdout.trim();
      log.success("compare_images", output);
      return { success: true, comparison: output };
    } finally {
      clearInterval(progressInterval);
      // Clean up temp files
      for (const tempFile of tempFiles) {
        if (existsSync(tempFile)) {
          try {
            unlinkSync(tempFile);
            log.info(`Cleaned up temp file: ${tempFile}`);
          } catch {
            // Silent fail on cleanup
          }
        }
      }
    }
  } catch (error) {
    const err = extractErrorMessage(error);
    log.error("compare_images", err);
    return { success: false, error: err };
  }
}

/**
 * Answer a specific question about an image.
 *
 * @param args.image_path - Path to local image file or URL to remote image
 * @param args.question - The question to answer about the image
 */
export async function ask_about_image(args: {
  image_path: string;
  question: string;
}): Promise<{ success: boolean; answer?: string; error?: string }> {
  log.call("ask_about_image", args);
  const { image_path, question } = args;

  // Validate local file exists
  if (!isUrl(image_path) && !existsSync(image_path)) {
    const err = `Image file not found: ${image_path}`;
    log.error("ask_about_image", err);
    return { success: false, error: err };
  }

  const result = await runGeminiWithImage(image_path, question);

  if (result.success) {
    log.success("ask_about_image", result.output);
    return { success: true, answer: result.output };
  }
  log.error("ask_about_image", result.error || "Unknown error");
  return { success: false, error: result.error };
}
