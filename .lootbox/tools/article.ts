/**
 * Article Tool - Generate technical articles using Claude Opus
 *
 * Creates high-quality technical articles following egghead's style guide.
 * Uses Claude Opus with extended thinking for deep, nuanced writing.
 * Includes verification of code snippets and commands with research-backed corrections.
 *
 * Style: Declarative, technically precise, persuasive without hype.
 * Structure: Hook → Mental Model Shift → Core Sections → Demonstrations → Impact
 */

import { createLogger, extractErrorMessage, type ProgressCallback } from "./shared/index.ts";

const log = createLogger("article");

// Global progress callback for streaming updates
let globalProgressCallback: ProgressCallback | null = null;

export function setProgressCallback(callback: ProgressCallback | null): void {
  globalProgressCallback = callback;
}

function sendProgress(message: string): void {
  if (globalProgressCallback) {
    globalProgressCallback(message);
  }
}

// Style guide embedded for prompting
const STYLE_GUIDE = `
## Writing Style Guide

**Tone:** Declarative, technically precise, persuasive without hype. Focus on "what" and "why" over step-by-step tutorials.

**Structure:**
- Short, punchy paragraphs with clear hierarchy
- Use horizontal rules (---) to separate major conceptual shifts
- Lead with strong hooks that establish context
- Build arguments through demonstration, not claims

**Language:**
- Avoid em-dashes (use periods, commas, or parentheses instead)
- Use italics for *emphasis* on key concepts
- Use **bold** for critical terms or names
- Prefer active voice and present tense
- Keep sentences concise and direct

**Code Examples:**
- Minimal, focused snippets that illustrate concepts
- Include just enough to demonstrate the idea
- Avoid tutorial-style step-by-step unless essential
- Use comments sparingly, only for critical clarification

**Article Structure Pattern:**
1. Opening Hook - Establish the parallel or comparison that frames the article
2. Mental Model Shift - Explain the conceptual change being proposed
3. Core Sections - Build the argument with technical examples
4. Concrete Demonstrations - Show real code that proves the point
5. Ecosystem/Adoption - Evidence of real-world validation
6. Closing - Short, memorable statement about impact

**What to Avoid:**
- Generic development advice or obvious best practices
- Feature laundry lists without context
- Excessive praise or marketing language
- Tutorial-style instructions unless critical
- Made-up information about "tips" or "common tasks"
- Repeating information that's easily discovered
`;

// Example article excerpts for few-shot learning
const EXAMPLE_EXCERPTS = {
  "ai-sdk": `
## Example: AI SDK Article (Technical Comparison Style)

Opening hook establishes a paradigm parallel:
"React Defined the Web. The AI SDK Will Define AI."

Mental model shift:
"AI development today feels like JavaScript in 2012. In 2012, we were using jQuery to imperatively manipulate the DOM. We focused on the *how* (updating elements) rather than the *what* (the desired UI state). Today, we are imperatively manipulating the outputs of LLMs."

Technical demonstration with minimal code:
\`\`\`typescript
const { messages, sendMessage, isLoading } = useChat();
// The mechanics (fetch, SSE parsing, state updates) are handled. You focus on rendering.
\`\`\`

Strong closing:
"React taught us to think in components and state. The AI SDK is teaching us to think in streams and intelligent, dynamic interfaces."
`,

  "qol": `
## Example: QoL Article (Personal Discovery Style)

Opening hook uses familiar pattern:
"You've seen the thread. Someone asks: *'What's that one $5 purchase that changed your life?'* The answers are always the same. A bidet. A phone stand. A better can opener. Small things. Embarrassingly cheap. Life before and after."

Shifts to developer context:
"Developers have their own version. *'What's that one config change that changed your life?'*"

Builds through relatable examples:
"That \`set -o vi\` tip? Useless if you don't know vi. Life-changing if you do."

Meta-pattern revelation:
"This prompt is a template. The structure works for any personalized technical audit: Gather context before recommending. Phase the discovery to avoid overwhelm. Score for prioritization."

Personal closing with call to action:
"Somewhere in your setup is a $5 purchase waiting to happen. A config change you'll wish you'd made years ago."
`,

  "platform": `
## Example: Platform Article (Deep Technical Dive Style)

Opening with provocative quote:
"Using Claude Code out-of-the-box is like using VS Code with zero extensions. You're technically using it, but fundamentally missing it."

Mental model establishment:
"Claude Code isn't a smart CLI assistant that happens to be extensible. It's a programmable AI platform with isolation, extensibility, and automation as first-class features."

Layered structure with clear headers:
- Layer 1: Behavioral Customization
- Layer 2: Environment Isolation
- Layer 3: External Integration

Code examples are configuration-focused:
\`\`\`bash
claude --system-prompt "You are a security auditor. Review code for vulnerabilities."
\`\`\`

Impact closing:
"The question isn't whether to extend it. The question is what you'll build."
`,
};

type ArticleStyle = keyof typeof EXAMPLE_EXCERPTS;

interface CodeSnippet {
  language: string;
  code: string;
  startIndex: number;
  endIndex: number;
  lineNumber: number;
}

interface VerificationIssue {
  snippet: CodeSnippet;
  issue: string;
  severity: "error" | "warning" | "info";
  suggestion?: string;
  research?: string;
}

interface VerificationResult {
  success: boolean;
  snippets_found: number;
  issues: VerificationIssue[];
  research_performed: boolean;
  duration_ms: number;
}

interface ArticleResult {
  success: boolean;
  article?: string;
  title?: string;
  word_count?: number;
  duration_ms: number;
  saved_to?: string;
  verification?: VerificationResult;
  error?: string;
}

/**
 * Parse Claude stream-json output to extract text
 */
function parseClaudeOutput(rawOutput: string): string {
  const lines = rawOutput.split("\n").filter((line) => line.trim());
  const textParts: string[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "assistant" && obj.message?.content) {
        for (const block of obj.message.content) {
          if (block.type === "text") {
            textParts.push(block.text);
          }
        }
      } else if (obj.type === "content_block_delta" && obj.delta?.text) {
        textParts.push(obj.delta.text);
      } else if (obj.type === "result" && obj.result) {
        textParts.push(obj.result);
      }
    } catch {
      if (line.trim() && !line.startsWith("{")) {
        textParts.push(line);
      }
    }
  }

  return textParts.join("") || rawOutput;
}

/**
 * Parse Gemini stream-json output to extract text
 */
function parseGeminiOutput(rawOutput: string): string {
  const lines = rawOutput.split("\n").filter((line) => line.trim());
  const textParts: string[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.text) {
        textParts.push(obj.text);
      } else if (obj.content) {
        textParts.push(obj.content);
      } else if (obj.message) {
        textParts.push(obj.message);
      }
    } catch {
      if (line.trim() && !line.startsWith("{")) {
        textParts.push(line);
      }
    }
  }

  return textParts.join("") || rawOutput;
}

/**
 * Extract code snippets from markdown article
 */
function extractCodeSnippets(article: string): CodeSnippet[] {
  const snippets: CodeSnippet[] = [];
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  let match;

  while ((match = codeBlockRegex.exec(article)) !== null) {
    const language = match[1] || "unknown";
    const code = match[2].trim();
    const startIndex = match.index;
    const endIndex = match.index + match[0].length;

    // Calculate line number
    const lineNumber = article.substring(0, startIndex).split("\n").length;

    snippets.push({
      language,
      code,
      startIndex,
      endIndex,
      lineNumber,
    });
  }

  return snippets;
}

/**
 * Run a CLI command and return output
 */
async function runCommand(
  command: string,
  args: string[],
  timeout: number = 60000
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn([command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CI: "true", TERM: "dumb" },
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        proc.kill();
        reject(new Error("Command timeout"));
      }, timeout);
    });

    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      timeoutPromise,
    ]);

    return {
      success: exitCode === 0,
      stdout: stdout as string,
      stderr: stderr as string,
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
 * Verify TypeScript/JavaScript syntax
 */
async function verifyTypeScriptSyntax(code: string): Promise<{ valid: boolean; error?: string }> {
  // Try to parse with Bun's built-in transpiler
  try {
    // Wrap in async function to handle top-level await
    const wrappedCode = `(async () => { ${code} })`;
    new Bun.Transpiler({ loader: "tsx" }).transformSync(wrappedCode);
    return { valid: true };
  } catch (error) {
    // Try without wrapping (might be a complete module)
    try {
      new Bun.Transpiler({ loader: "tsx" }).transformSync(code);
      return { valid: true };
    } catch (innerError) {
      return { valid: false, error: extractErrorMessage(innerError) };
    }
  }
}

/**
 * Verify bash command exists and syntax
 */
async function verifyBashCommand(code: string): Promise<{ valid: boolean; error?: string; warnings?: string[] }> {
  const warnings: string[] = [];
  const lines = code.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));

  for (const line of lines) {
    // Extract the main command (first word, handling env vars and redirects)
    const cmdMatch = line.match(/^(?:[\w]+=\S+\s+)*(\w[\w-]*)/);
    if (!cmdMatch) continue;

    const cmd = cmdMatch[1];

    // Skip common shell builtins and control structures
    const builtins = [
      "if", "then", "else", "fi", "for", "do", "done", "while", "case", "esac",
      "function", "return", "exit", "export", "source", "alias", "unalias",
      "cd", "pwd", "echo", "printf", "read", "test", "[", "[[", "true", "false",
      "set", "unset", "shift", "eval", "exec", "trap", "wait", "kill",
    ];

    if (builtins.includes(cmd)) continue;

    // Check if command exists using `which`
    const result = await runCommand("which", [cmd], 5000);
    if (!result.success) {
      warnings.push(`Command '${cmd}' may not exist or may not be in PATH`);
    }
  }

  return {
    valid: warnings.length === 0,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Research an issue using Gemini
 */
async function researchIssue(
  code: string,
  language: string,
  issue: string
): Promise<string> {
  log.info(`Researching issue for ${language} code...`);
  sendProgress(`[Verify] Researching: ${issue.substring(0, 50)}...`);

  const prompt = `I'm writing a technical article and need to verify this ${language} code snippet:

\`\`\`${language}
${code}
\`\`\`

Issue detected: ${issue}

Please:
1. Verify if this code/command is correct for current versions (2024-2025)
2. If incorrect, provide the corrected version
3. Explain what was wrong and why
4. Note any deprecations or version-specific considerations

Be concise and technical. Focus on accuracy.`;

  try {
    const result = await runCommand(
      "gemini",
      ["-m", "flash", "-o", "stream-json", prompt],
      60000
    );

    if (result.success) {
      return parseGeminiOutput(result.stdout);
    } else {
      log.error("researchIssue", result.stderr);
      return `Research failed: ${result.stderr}`;
    }
  } catch (error) {
    return `Research error: ${extractErrorMessage(error)}`;
  }
}

/**
 * Verify a single code snippet
 */
async function verifySnippet(
  snippet: CodeSnippet,
  doResearch: boolean
): Promise<VerificationIssue | null> {
  const { language, code } = snippet;
  const lang = language.toLowerCase();

  // TypeScript/JavaScript verification
  if (["typescript", "ts", "javascript", "js", "tsx", "jsx"].includes(lang)) {
    const result = await verifyTypeScriptSyntax(code);
    if (!result.valid) {
      const issue: VerificationIssue = {
        snippet,
        issue: result.error || "Syntax error",
        severity: "error",
      };

      if (doResearch) {
        issue.research = await researchIssue(code, language, result.error || "Syntax error");
      }

      return issue;
    }
  }

  // Bash/Shell verification
  if (["bash", "sh", "shell", "zsh"].includes(lang)) {
    const result = await verifyBashCommand(code);
    if (!result.valid && result.warnings) {
      const issue: VerificationIssue = {
        snippet,
        issue: result.warnings.join("; "),
        severity: "warning",
      };

      if (doResearch) {
        issue.research = await researchIssue(code, language, result.warnings.join("; "));
      }

      return issue;
    }
  }

  // JSON verification
  if (["json", "jsonc"].includes(lang)) {
    try {
      // Remove comments for jsonc
      const cleanJson = code.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      JSON.parse(cleanJson);
    } catch (error) {
      const issue: VerificationIssue = {
        snippet,
        issue: `Invalid JSON: ${extractErrorMessage(error)}`,
        severity: "error",
      };

      if (doResearch) {
        issue.research = await researchIssue(code, language, extractErrorMessage(error));
      }

      return issue;
    }
  }

  return null;
}

/**
 * Verify all code snippets in an article
 *
 * @param args.article - The article content to verify
 * @param args.research - Whether to research issues found (default: true)
 * @param args.timeout_seconds - Timeout for research operations (default: 120)
 */
export async function verify(args: {
  article: string;
  research?: boolean;
  timeout_seconds?: number;
}): Promise<VerificationResult> {
  log.call("verify", { article_length: args.article.length, research: args.research });

  const { article, research = true, timeout_seconds = 120 } = args;
  const startTime = Date.now();

  if (!article || article.trim().length === 0) {
    return {
      success: false,
      snippets_found: 0,
      issues: [],
      research_performed: false,
      duration_ms: 0,
    };
  }

  sendProgress(`[Verify] Extracting code snippets...`);
  const snippets = extractCodeSnippets(article);
  log.info(`Found ${snippets.length} code snippets`);

  if (snippets.length === 0) {
    return {
      success: true,
      snippets_found: 0,
      issues: [],
      research_performed: false,
      duration_ms: Date.now() - startTime,
    };
  }

  sendProgress(`[Verify] Checking ${snippets.length} code snippets...`);
  const issues: VerificationIssue[] = [];

  for (let i = 0; i < snippets.length; i++) {
    const snippet = snippets[i];
    sendProgress(`[Verify] Checking snippet ${i + 1}/${snippets.length} (${snippet.language})...`);

    const issue = await verifySnippet(snippet, research);
    if (issue) {
      issues.push(issue);
      log.warn(`Issue in ${snippet.language} at line ${snippet.lineNumber}: ${issue.issue}`);
    }
  }

  const duration_ms = Date.now() - startTime;
  log.success("verify", { snippets_found: snippets.length, issues: issues.length, duration_ms });

  return {
    success: true,
    snippets_found: snippets.length,
    issues,
    research_performed: research && issues.length > 0,
    duration_ms,
  };
}

/**
 * Apply corrections to an article based on verification issues
 */
async function applyCorrections(
  article: string,
  issues: VerificationIssue[],
  timeout: number
): Promise<string> {
  if (issues.length === 0) return article;

  sendProgress(`[Verify] Applying corrections for ${issues.length} issues...`);

  // Build correction prompt
  const issueDescriptions = issues.map((issue, i) => {
    return `
### Issue ${i + 1} (Line ${issue.snippet.lineNumber}, ${issue.snippet.language})
**Original code:**
\`\`\`${issue.snippet.language}
${issue.snippet.code}
\`\`\`

**Problem:** ${issue.issue}
${issue.research ? `\n**Research findings:**\n${issue.research}` : ""}
`;
  }).join("\n");

  const prompt = `Correct the following article based on the code verification issues found.

## Original Article
${article}

## Issues Found
${issueDescriptions}

## Instructions
1. Fix each code snippet based on the issues and research findings
2. Maintain the article's style and structure
3. Only change the code that has issues - preserve everything else
4. If research suggests a different approach, use it
5. Do NOT add meta-commentary about the corrections

Return the complete corrected article:`;

  const claudeArgs = [
    "-p",
    "--model", "opus",
    "--append-system-prompt", "You are a technical editor. Correct code errors while preserving the article's voice.",
    "--output-format", "stream-json",
    prompt,
  ];

  const proc = Bun.spawn(["claude", ...claudeArgs], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CI: "true", TERM: "dumb" },
  });

  let response = "";
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  const resetTimeout = () => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeout);
  };

  resetTimeout();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      response += decoder.decode(value, { stream: true });
      resetTimeout();
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  if (timedOut) {
    log.error("applyCorrections", "Timeout");
    return article; // Return original on timeout
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    log.error("applyCorrections", "Claude failed");
    return article; // Return original on failure
  }

  return parseClaudeOutput(response.trim());
}

/**
 * Generate a technical article with automatic verification and correction
 *
 * @param args.topic - The main topic or prompt for the article (required)
 * @param args.title - Optional title override (Claude will generate if not provided)
 * @param args.style - Which example style to follow: "ai-sdk" | "qol" | "platform" (default: ai-sdk)
 * @param args.research_context - Optional pre-gathered research or context to include
 * @param args.target_length - Target word count: "short" (~800) | "medium" (~1500) | "long" (~2500) (default: medium)
 * @param args.output_path - Optional file path to save the article
 * @param args.verify - Whether to verify code snippets (default: true)
 * @param args.auto_correct - Whether to auto-correct issues found (default: true)
 * @param args.timeout_seconds - Timeout in seconds (default: 600 for full pipeline)
 */
export async function generate(args: {
  topic: string;
  title?: string;
  style?: ArticleStyle;
  research_context?: string;
  target_length?: "short" | "medium" | "long";
  output_path?: string;
  verify?: boolean;
  auto_correct?: boolean;
  timeout_seconds?: number;
}): Promise<ArticleResult> {
  log.call("generate", { ...args, research_context: args.research_context ? "[provided]" : undefined });

  const {
    topic,
    title,
    style = "ai-sdk",
    research_context,
    target_length = "medium",
    output_path,
    verify: doVerify = true,
    auto_correct = true,
    timeout_seconds = 600,
  } = args;

  if (!topic || topic.trim().length === 0) {
    const err = "Topic is required";
    log.error("generate", err);
    return { success: false, duration_ms: 0, error: err };
  }

  const startTime = Date.now();
  const timeout = timeout_seconds * 1000;

  // Build the target word count
  const wordCounts = { short: 800, medium: 1500, long: 2500 };
  const targetWords = wordCounts[target_length];

  // Get the relevant example excerpt
  const exampleExcerpt = EXAMPLE_EXCERPTS[style] || EXAMPLE_EXCERPTS["ai-sdk"];

  // Build the generation prompt
  const prompt = buildArticlePrompt({
    topic,
    title,
    style,
    exampleExcerpt,
    research_context,
    targetWords,
  });

  sendProgress(`[Article] Generating ${target_length} article (${targetWords} words) on: ${topic.substring(0, 50)}...`);

  try {
    // Use Claude Opus with extended thinking for quality writing
    const claudeArgs = [
      "-p",
      "--model", "opus",
      "--append-system-prompt", "You are an expert technical writer. Think deeply about structure, clarity, and impact before writing. Ensure all code examples are accurate and use current APIs.",
      "--output-format", "stream-json",
      prompt,
    ];

    log.debug(`Running: claude ${claudeArgs.slice(0, -1).join(" ")} [prompt]`);

    const proc = Bun.spawn(["claude", ...claudeArgs], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        CI: "true",
        TERM: "dumb",
      },
    });

    // Stream stdout and collect response
    let response = "";
    let charCount = 0;
    const progressInterval = 5000;

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;

    const resetTimeout = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeout);
    };

    resetTimeout();

    let progressCount = 0;
    const progressReporter = setInterval(() => {
      progressCount++;
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const status = charCount === 0 ? "thinking..." : `${charCount} chars written`;
      sendProgress(`[Article] ${elapsed}s elapsed, ${status}`);
      log.debug(`Progress #${progressCount}: ${elapsed}s, ${status}`);
    }, progressInterval);

    sendProgress(`[Article] Claude Opus is writing...`);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        response += chunk;
        charCount += chunk.length;
        resetTimeout();

        if (charCount === chunk.length) {
          sendProgress(`[Article] Receiving content...`);
        }
      }
    } finally {
      clearInterval(progressReporter);
      if (timeoutId) clearTimeout(timeoutId);
    }

    if (timedOut) {
      throw new Error(`Timeout after ${timeout / 1000}s`);
    }

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const errorMsg = stderr || `Exit code ${exitCode}`;
      log.error("generate", errorMsg);
      return { success: false, duration_ms: Date.now() - startTime, error: errorMsg };
    }

    // Parse the output
    let article = parseClaudeOutput(response.trim());

    if (!article || article.length < 100) {
      log.error("generate", "Article too short or empty");
      return { success: false, duration_ms: Date.now() - startTime, error: "Generated article is too short or empty" };
    }

    // Verification and correction phase
    let verification: VerificationResult | undefined;

    if (doVerify) {
      sendProgress(`[Article] Verifying code snippets...`);
      verification = await verify({ article, research: true, timeout_seconds: 120 });

      if (verification.issues.length > 0 && auto_correct) {
        sendProgress(`[Article] Found ${verification.issues.length} issues, applying corrections...`);
        article = await applyCorrections(article, verification.issues, timeout);

        // Re-verify after corrections
        sendProgress(`[Article] Re-verifying corrected article...`);
        const reVerification = await verify({ article, research: false, timeout_seconds: 60 });

        // Update verification result
        verification = {
          ...verification,
          snippets_found: reVerification.snippets_found,
          issues: reVerification.issues, // Should be fewer/none after correction
        };
      }
    }

    // Extract title from the article if not provided
    const extractedTitle = title || extractTitle(article);

    // Count words
    const word_count = article.split(/\s+/).filter((w) => w.length > 0).length;

    // Save to file if path provided
    let saved_to: string | undefined;
    if (output_path) {
      try {
        await Bun.write(output_path, article);
        saved_to = output_path;
        sendProgress(`[Article] Saved to ${output_path}`);
      } catch (writeErr) {
        log.error("generate", `Failed to save: ${extractErrorMessage(writeErr)}`);
      }
    }

    const duration_ms = Date.now() - startTime;
    log.success("generate", { title: extractedTitle, word_count, duration_ms, issues: verification?.issues.length });
    sendProgress(`[Article] Complete: ${word_count} words in ${(duration_ms / 1000).toFixed(1)}s`);

    return {
      success: true,
      article,
      title: extractedTitle,
      word_count,
      duration_ms,
      saved_to,
      verification,
    };
  } catch (error) {
    const duration_ms = Date.now() - startTime;
    const errorMsg = extractErrorMessage(error);
    log.error("generate", errorMsg);
    return { success: false, duration_ms, error: errorMsg };
  }
}

/**
 * Build the article generation prompt
 */
function buildArticlePrompt(opts: {
  topic: string;
  title?: string;
  style: ArticleStyle;
  exampleExcerpt: string;
  research_context?: string;
  targetWords: number;
}): string {
  const parts: string[] = [];

  parts.push(`Write a technical article on the following topic:`);
  parts.push(`\n**Topic:** ${opts.topic}\n`);

  if (opts.title) {
    parts.push(`**Title:** ${opts.title}\n`);
  }

  parts.push(`**Target Length:** Approximately ${opts.targetWords} words\n`);

  parts.push(`---\n`);
  parts.push(STYLE_GUIDE);
  parts.push(`---\n`);
  parts.push(opts.exampleExcerpt);
  parts.push(`---\n`);

  if (opts.research_context) {
    parts.push(`## Research Context\n`);
    parts.push(`Use the following research to inform your article:\n`);
    parts.push(opts.research_context);
    parts.push(`\n---\n`);
  }

  parts.push(`## Instructions\n`);
  parts.push(`1. Write the complete article in markdown format`);
  parts.push(`2. Start with a compelling title as an H1 heading`);
  parts.push(`3. Follow the style guide exactly (no em-dashes, short paragraphs, etc.)`);
  parts.push(`4. Match the style of the example excerpt provided`);
  parts.push(`5. Include code examples only where they demonstrate key concepts`);
  parts.push(`6. IMPORTANT: Ensure all code examples use current, valid syntax and APIs`);
  parts.push(`7. End with a strong, memorable closing statement`);
  parts.push(`8. Do NOT include meta-commentary about the article itself`);
  parts.push(`\nWrite the article now:`);

  return parts.join("\n");
}

/**
 * Extract the title from an article's first H1 heading
 */
function extractTitle(article: string): string {
  const match = article.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "Untitled Article";
}

/**
 * List available article styles
 */
export async function list_styles(): Promise<{
  success: boolean;
  styles: Array<{
    name: string;
    description: string;
  }>;
}> {
  log.call("list_styles", {});

  const styles = [
    {
      name: "ai-sdk",
      description: "Technical comparison style. Establishes paradigm parallels, shows mental model shifts, uses minimal code examples. Best for: comparing technologies, explaining new tools.",
    },
    {
      name: "qol",
      description: "Personal discovery style. Uses familiar patterns, builds through relatable examples, reveals meta-patterns. Best for: productivity tips, workflow improvements, developer experience.",
    },
    {
      name: "platform",
      description: "Deep technical dive style. Layered structure with clear sections, configuration-focused examples, comprehensive coverage. Best for: platform documentation, feature deep-dives.",
    },
  ];

  log.success("list_styles", styles);
  return { success: true, styles };
}

/**
 * Get the style guide content
 */
export async function get_style_guide(): Promise<{
  success: boolean;
  style_guide: string;
}> {
  log.call("get_style_guide", {});
  log.success("get_style_guide", "returned");
  return { success: true, style_guide: STYLE_GUIDE };
}

/**
 * Revise an existing article with specific feedback
 *
 * @param args.article - The existing article content to revise
 * @param args.feedback - Specific feedback or instructions for revision
 * @param args.verify - Whether to verify code snippets after revision (default: true)
 * @param args.output_path - Optional file path to save the revised article
 * @param args.timeout_seconds - Timeout in seconds (default: 300)
 */
export async function revise(args: {
  article: string;
  feedback: string;
  verify?: boolean;
  output_path?: string;
  timeout_seconds?: number;
}): Promise<ArticleResult> {
  log.call("revise", { feedback: args.feedback.substring(0, 100), output_path: args.output_path });

  const { article, feedback, verify: doVerify = true, output_path, timeout_seconds = 300 } = args;

  if (!article || article.trim().length === 0) {
    return { success: false, duration_ms: 0, error: "Article content is required" };
  }

  if (!feedback || feedback.trim().length === 0) {
    return { success: false, duration_ms: 0, error: "Feedback is required" };
  }

  const startTime = Date.now();
  const timeout = timeout_seconds * 1000;

  const prompt = `Revise the following article based on the feedback provided.

## Style Guide
${STYLE_GUIDE}

## Original Article
${article}

## Revision Feedback
${feedback}

## Instructions
1. Apply the feedback while maintaining the style guide
2. Return the complete revised article in markdown format
3. Preserve the overall structure unless the feedback specifically asks to change it
4. Ensure all code examples use current, valid syntax and APIs
5. Do NOT include meta-commentary about the revisions

Write the revised article now:`;

  sendProgress(`[Article] Revising with feedback: ${feedback.substring(0, 50)}...`);

  try {
    const claudeArgs = [
      "-p",
      "--model", "opus",
      "--append-system-prompt", "You are an expert technical editor. Revise carefully while preserving voice and style.",
      "--output-format", "stream-json",
      prompt,
    ];

    const proc = Bun.spawn(["claude", ...claudeArgs], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CI: "true", TERM: "dumb" },
    });

    let response = "";
    let charCount = 0;

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;

    const resetTimeout = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeout);
    };

    resetTimeout();

    const progressReporter = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      sendProgress(`[Article] Revising... ${elapsed}s elapsed, ${charCount} chars`);
    }, 5000);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        response += chunk;
        charCount += chunk.length;
        resetTimeout();
      }
    } finally {
      clearInterval(progressReporter);
      if (timeoutId) clearTimeout(timeoutId);
    }

    if (timedOut) {
      throw new Error(`Timeout after ${timeout / 1000}s`);
    }

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return { success: false, duration_ms: Date.now() - startTime, error: stderr || `Exit code ${exitCode}` };
    }

    let revisedArticle = parseClaudeOutput(response.trim());

    // Verify and correct if enabled
    let verification: VerificationResult | undefined;
    if (doVerify) {
      sendProgress(`[Article] Verifying revised article...`);
      verification = await verify({ article: revisedArticle, research: true, timeout_seconds: 120 });

      if (verification.issues.length > 0) {
        sendProgress(`[Article] Found ${verification.issues.length} issues, applying corrections...`);
        revisedArticle = await applyCorrections(revisedArticle, verification.issues, timeout);
      }
    }

    const extractedTitle = extractTitle(revisedArticle);
    const word_count = revisedArticle.split(/\s+/).filter((w) => w.length > 0).length;

    let saved_to: string | undefined;
    if (output_path) {
      try {
        await Bun.write(output_path, revisedArticle);
        saved_to = output_path;
      } catch (writeErr) {
        log.error("revise", `Failed to save: ${extractErrorMessage(writeErr)}`);
      }
    }

    const duration_ms = Date.now() - startTime;
    log.success("revise", { title: extractedTitle, word_count, duration_ms });

    return {
      success: true,
      article: revisedArticle,
      title: extractedTitle,
      word_count,
      duration_ms,
      saved_to,
      verification,
    };
  } catch (error) {
    const duration_ms = Date.now() - startTime;
    return { success: false, duration_ms, error: extractErrorMessage(error) };
  }
}
