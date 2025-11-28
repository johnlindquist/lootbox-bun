/**
 * Deep Research Tool - Comprehensive multi-source research with iterative exploration
 *
 * Expands on basic research capabilities to provide:
 * - Multi-angle query generation from a single topic
 * - Parallel web searches across different perspectives
 * - Multi-agent synthesis (Claude, Codex, Gemini)
 * - Iterative gap identification and follow-up research
 * - Structured research reports with citations
 *
 * Architecture:
 * 1. Query Expansion: Break topic into multiple search angles
 * 2. Parallel Search: Run searches concurrently using Gemini
 * 3. Synthesis: Combine findings using multi-agent analysis
 * 4. Gap Analysis: Identify missing information
 * 5. Deep Dive: Follow-up research on key gaps
 * 6. Report: Produce structured output
 */

import { createLogger, extractErrorMessage, type ProgressCallback, spawnWithTimeout, getCodeMapContext } from "./shared/index.ts";
import { saveToolResponse } from "./shared/response_history.ts";

const log = createLogger("deep_research");

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

// ============================================================================
// CORE UTILITIES
// ============================================================================

interface SearchResult {
  query: string;
  success: boolean;
  content?: string;
  error?: string;
}

interface AgentAnalysis {
  agent: string;
  success: boolean;
  analysis?: string;
  error?: string;
  duration_ms: number;
}

/**
 * Run a Gemini web search query
 * Uses spawnWithTimeout for proper timeout handling
 */
async function runGeminiSearch(
  query: string,
  focus?: string,
  timeout = 60000
): Promise<SearchResult> {
  let prompt = `Search the web and provide comprehensive, up-to-date information about: ${query}`;
  if (focus) {
    prompt += `\n\nFocus on: ${focus}`;
  }
  prompt += `\n\nProvide detailed findings with:
- Key facts and data
- Recent developments
- Expert opinions or consensus
- Sources when available

Be thorough and include specific details.`;

  const result = await spawnWithTimeout({
    command: "gemini",
    args: ["-m", "pro", "-o", "text", prompt],
    timeoutMs: timeout,
  });

  if (result.timedOut) {
    return { query, success: false, error: `Search timed out after ${timeout / 1000}s` };
  }

  if (!result.success) {
    return { query, success: false, error: result.error || `Exit code ${result.exitCode}` };
  }

  return { query, success: true, content: result.stdout.trim() };
}

/**
 * Query a single agent for analysis
 * Uses spawnWithTimeout for proper timeout handling
 */
async function queryAgentForAnalysis(
  agent: "claude" | "codex" | "gemini",
  prompt: string,
  timeout = 120000
): Promise<AgentAnalysis> {
  const configs = {
    claude: {
      command: "claude",
      args: ["-p", "--model", "sonnet", "--output-format", "text"],
      name: "Claude",
    },
    codex: {
      command: "codex",
      args: ["exec", "-m", "gpt-4.1", "--json"],
      name: "Codex",
    },
    gemini: {
      command: "gemini",
      args: ["-m", "pro", "-o", "text"],
      name: "Gemini",
    },
  };

  const config = configs[agent];

  const result = await spawnWithTimeout({
    command: config.command,
    args: [...config.args, prompt],
    timeoutMs: timeout,
    env: { CI: "true", TERM: "dumb" },
  });

  if (result.timedOut) {
    return {
      agent: config.name,
      success: false,
      error: `Agent timed out after ${timeout / 1000}s`,
      duration_ms: result.durationMs,
    };
  }

  if (!result.success) {
    return {
      agent: config.name,
      success: false,
      error: result.error || `Exit code ${result.exitCode}`,
      duration_ms: result.durationMs,
    };
  }

  // Parse JSONL for codex
  let analysis = result.stdout.trim();
  if (agent === "codex") {
    const lines = analysis.split("\n").filter((l) => l.trim());
    const textParts: string[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.message) textParts.push(obj.message);
        else if (obj.content) textParts.push(obj.content);
        else if (obj.text) textParts.push(obj.text);
      } catch {
        if (!line.startsWith("{")) textParts.push(line);
      }
    }
    analysis = textParts.join("\n") || analysis;
  }

  return { agent: config.name, success: true, analysis, duration_ms: result.durationMs };
}

// ============================================================================
// QUERY EXPANSION
// ============================================================================

interface ExpandedQueries {
  original: string;
  angles: Array<{
    angle: string;
    query: string;
    rationale: string;
  }>;
}

/**
 * Expand a research topic into multiple search angles
 */
async function expandTopicToQueries(
  topic: string,
  numAngles: number = 5
): Promise<ExpandedQueries> {
  sendProgress("Expanding topic into search angles...");

  const prompt = `Given this research topic: "${topic}"

Generate ${numAngles} different search angles to comprehensively research this topic.

For each angle, provide:
1. A brief label (2-4 words)
2. A specific search query
3. Why this angle is valuable

Format as JSON:
{
  "angles": [
    { "angle": "Historical Context", "query": "history of ${topic}", "rationale": "Understanding origins and evolution" },
    ...
  ]
}

Focus on angles that:
- Cover different perspectives (technical, practical, theoretical)
- Include current state and recent developments
- Address common questions and concerns
- Explore expert opinions and research`;

  const result = await runGeminiSearch(prompt, "query generation");

  if (!result.success || !result.content) {
    // Fallback to basic angles
    return {
      original: topic,
      angles: [
        { angle: "Overview", query: `${topic} comprehensive overview`, rationale: "General understanding" },
        { angle: "Latest Developments", query: `${topic} latest news 2024 2025`, rationale: "Recent updates" },
        { angle: "Expert Analysis", query: `${topic} expert analysis research`, rationale: "Authoritative sources" },
        { angle: "Practical Applications", query: `${topic} practical use cases examples`, rationale: "Real-world context" },
        { angle: "Challenges", query: `${topic} challenges problems limitations`, rationale: "Critical perspective" },
      ],
    };
  }

  try {
    // Extract JSON from response
    const jsonMatch = result.content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { original: topic, angles: parsed.angles || [] };
    }
  } catch {
    log.warn("Failed to parse expanded queries, using fallback");
  }

  // Fallback
  return {
    original: topic,
    angles: [
      { angle: "Overview", query: `${topic} comprehensive overview`, rationale: "General understanding" },
      { angle: "Latest Developments", query: `${topic} latest news 2024 2025`, rationale: "Recent updates" },
      { angle: "Expert Analysis", query: `${topic} expert analysis research`, rationale: "Authoritative sources" },
    ],
  };
}

// ============================================================================
// MAIN RESEARCH FUNCTIONS
// ============================================================================

interface DeepResearchResult {
  success: boolean;
  topic: string;
  summary: string;
  sections: Array<{
    title: string;
    content: string;
    sources?: string[];
  }>;
  key_findings: string[];
  knowledge_gaps: string[];
  recommendations: string[];
  methodology: {
    queries_executed: number;
    sources_analyzed: number;
    agents_consulted: string[];
  };
  total_duration_ms: number;
  error?: string;
}

/**
 * Conduct deep, comprehensive research on a topic
 *
 * This is the main entry point for thorough research. It:
 * 1. Expands the topic into multiple search angles
 * 2. Runs parallel searches across all angles
 * 3. Synthesizes findings using multiple AI agents
 * 4. Identifies knowledge gaps
 * 5. Produces a structured research report
 *
 * @param args.topic - The topic to research
 * @param args.depth - Research depth: "quick" (3 angles), "standard" (5), "thorough" (8)
 * @param args.focus - Optional focus area to emphasize
 * @param args.include_gaps - If true, identifies knowledge gaps (default: true)
 * @param args.timeout_seconds - Timeout for the entire research process
 */
export async function deep_research(args: {
  topic: string;
  depth?: "quick" | "standard" | "thorough";
  focus?: string;
  include_gaps?: boolean;
  timeout_seconds?: number;
  /** Include codebase structure context (default: true) */
  include_codemap?: boolean;
}): Promise<DeepResearchResult> {
  log.call("deep_research", args);
  const {
    topic,
    depth = "standard",
    focus,
    include_gaps = true,
    timeout_seconds = 300,
    include_codemap = true,
  } = args;

  if (!topic || topic.trim().length === 0) {
    return {
      success: false,
      topic: "",
      summary: "",
      sections: [],
      key_findings: [],
      knowledge_gaps: [],
      recommendations: [],
      methodology: { queries_executed: 0, sources_analyzed: 0, agents_consulted: [] },
      total_duration_ms: 0,
      error: "Topic is required",
    };
  }

  const startTime = Date.now();
  const numAngles = depth === "quick" ? 3 : depth === "standard" ? 5 : 8;

  // Get code map context for codebase awareness (if enabled)
  let codebaseSection = "";
  if (include_codemap) {
    sendProgress("Loading codebase structure...");
    const codeMapContext = await getCodeMapContext();
    if (codeMapContext) {
      codebaseSection = `\n\n<codebase-structure>\n${codeMapContext}\n</codebase-structure>`;
      log.info(`Loaded code map context (${codeMapContext.length} chars)`);
    } else {
      log.info("No code map available (not a git repo or generation failed)");
    }
  }

  sendProgress(`Starting deep research on: ${topic} (${depth} depth, ${numAngles} angles)`);

  // Step 1: Expand topic into search angles
  const expandedQueries = await expandTopicToQueries(topic, numAngles);
  sendProgress(`Generated ${expandedQueries.angles.length} research angles`);

  // Step 2: Run parallel searches
  sendProgress("Executing parallel web searches...");
  const searchPromises = expandedQueries.angles.map((angle, i) => {
    sendProgress(`[Search ${i + 1}/${expandedQueries.angles.length}] ${angle.angle}`);
    return runGeminiSearch(angle.query, focus);
  });

  const searchResults = await Promise.all(searchPromises);
  const successfulSearches = searchResults.filter((r) => r.success);
  sendProgress(`Completed ${successfulSearches.length}/${searchResults.length} searches`);

  if (successfulSearches.length === 0) {
    return {
      success: false,
      topic,
      summary: "",
      sections: [],
      key_findings: [],
      knowledge_gaps: [],
      recommendations: [],
      methodology: {
        queries_executed: searchResults.length,
        sources_analyzed: 0,
        agents_consulted: [],
      },
      total_duration_ms: Date.now() - startTime,
      error: "All searches failed",
    };
  }

  // Step 3: Compile findings into sections
  const sections = expandedQueries.angles.map((angle, i) => ({
    title: angle.angle,
    content: searchResults[i].success
      ? searchResults[i].content || ""
      : `Search failed: ${searchResults[i].error}`,
    sources: [] as string[],
  }));

  // Step 4: Multi-agent synthesis
  sendProgress("Synthesizing findings with multi-agent analysis...");
  const combinedFindings = successfulSearches
    .map((r, i) => `## ${expandedQueries.angles[i]?.angle || `Finding ${i + 1}`}\n${r.content}`)
    .join("\n\n---\n\n");

  const synthesisPrompt = `You are a research analyst. Analyze these research findings on "${topic}" and provide:${codebaseSection}

## Research Findings:
${combinedFindings}

## Your Analysis Should Include:

1. **Executive Summary** (2-3 paragraphs)
   - Key takeaways
   - Current state of knowledge
   - Emerging trends

2. **Key Findings** (bullet points)
   - Most important discoveries
   - Consensus views
   - Notable data points

3. **Knowledge Gaps** (if any information is missing or unclear)
   - What questions remain unanswered?
   - What areas need more research?

4. **Recommendations** (actionable insights)
   - What should someone interested in this topic do next?
   - Key resources to explore

Be specific, cite findings from the research, and distinguish between established facts and emerging/uncertain information.`;

  // Query agents in parallel for synthesis
  const synthesisPromises = [
    queryAgentForAnalysis("claude", synthesisPrompt),
    queryAgentForAnalysis("gemini", synthesisPrompt),
  ];

  const synthesisResults = await Promise.all(synthesisPromises);
  const successfulSyntheses = synthesisResults.filter((r) => r.success);
  sendProgress(`Synthesis complete: ${successfulSyntheses.length} agents responded`);

  // Combine syntheses
  let summary = "";
  const key_findings: string[] = [];
  const knowledge_gaps: string[] = [];
  const recommendations: string[] = [];

  if (successfulSyntheses.length > 0) {
    // Use the first successful synthesis as the primary summary
    const primary = successfulSyntheses[0];
    summary = primary.analysis || "";

    // Extract structured data if possible
    const findingsMatch = summary.match(/\*\*Key Findings\*\*[\s\S]*?(?=\*\*|##|$)/i);
    const gapsMatch = summary.match(/\*\*Knowledge Gaps\*\*[\s\S]*?(?=\*\*|##|$)/i);
    const recsMatch = summary.match(/\*\*Recommendations\*\*[\s\S]*?(?=\*\*|##|$)/i);

    // Parse bullet points from matches
    const parseBullets = (text: string | undefined): string[] => {
      if (!text) return [];
      return text
        .split("\n")
        .filter((line) => line.trim().match(/^[-*•]\s/))
        .map((line) => line.replace(/^[-*•]\s*/, "").trim())
        .filter((line) => line.length > 0);
    };

    key_findings.push(...parseBullets(findingsMatch?.[0]));
    if (include_gaps) {
      knowledge_gaps.push(...parseBullets(gapsMatch?.[0]));
    }
    recommendations.push(...parseBullets(recsMatch?.[0]));
  }

  // Step 5: Gap analysis (optional follow-up)
  if (include_gaps && knowledge_gaps.length > 0 && depth !== "quick") {
    sendProgress(`Identified ${knowledge_gaps.length} knowledge gaps, conducting follow-up research...`);
    // Take top 2 gaps and do quick follow-up
    const topGaps = knowledge_gaps.slice(0, 2);
    const gapSearches = await Promise.all(
      topGaps.map((gap) => runGeminiSearch(`${topic} ${gap}`, "filling knowledge gap"))
    );

    const gapFindings = gapSearches
      .filter((r) => r.success)
      .map((r, i) => ({
        title: `Gap Analysis: ${topGaps[i]}`,
        content: r.content || "",
      }));

    sections.push(...gapFindings);
  }

  const total_duration_ms = Date.now() - startTime;
  sendProgress(`Deep research complete in ${(total_duration_ms / 1000).toFixed(1)}s`);

  log.success("deep_research", { topic, sections: sections.length, duration: total_duration_ms });

  // Save response to history
  const resultObj = {
    success: true,
    topic,
    summary,
    sections,
    key_findings,
    knowledge_gaps,
    recommendations,
    methodology: {
      queries_executed: searchResults.length + (include_gaps ? Math.min(knowledge_gaps.length, 2) : 0),
      sources_analyzed: successfulSearches.length,
      agents_consulted: successfulSyntheses.map((s) => s.agent),
    },
    total_duration_ms,
  };

  // Build markdown content for history
  const historyContent = `## Summary\n\n${summary}\n\n## Key Findings\n\n${key_findings.map(f => `- ${f}`).join("\n")}\n\n## Knowledge Gaps\n\n${knowledge_gaps.map(g => `- ${g}`).join("\n")}\n\n## Recommendations\n\n${recommendations.map(r => `- ${r}`).join("\n")}\n\n## Sections\n\n${sections.map(s => `### ${s.title}\n\n${s.content}`).join("\n\n")}`;

  try {
    await saveToolResponse({
      tool: "deep_research",
      topic,
      content: historyContent,
      query: focus || topic,
      tags: ["research", depth],
      duration_ms: total_duration_ms,
      agents: successfulSyntheses.map((s) => s.agent),
      extras: { depth, queries_executed: resultObj.methodology.queries_executed },
    });
  } catch (e) {
    log.warn("Failed to save response to history", e);
  }

  return resultObj;
}

/**
 * Quick research - faster but less comprehensive
 *
 * Use this when you need a rapid overview rather than exhaustive research.
 * Runs 3 parallel searches and provides a concise summary.
 *
 * @param args.topic - The topic to research
 * @param args.focus - Optional focus area
 */
export async function quick_research(args: {
  topic: string;
  focus?: string;
}): Promise<{
  success: boolean;
  topic: string;
  summary: string;
  key_points: string[];
  sources_count: number;
  duration_ms: number;
  error?: string;
}> {
  log.call("quick_research", args);
  const { topic, focus } = args;

  if (!topic) {
    return {
      success: false,
      topic: "",
      summary: "",
      key_points: [],
      sources_count: 0,
      duration_ms: 0,
      error: "Topic is required",
    };
  }

  const startTime = Date.now();
  sendProgress(`Quick research on: ${topic}`);

  // Run 3 focused searches in parallel
  const queries = [
    `${topic} overview summary`,
    `${topic} latest developments news`,
    `${topic} ${focus || "key insights"}`,
  ];

  const searchResults = await Promise.all(queries.map((q) => runGeminiSearch(q)));
  const successful = searchResults.filter((r) => r.success);

  if (successful.length === 0) {
    return {
      success: false,
      topic,
      summary: "",
      key_points: [],
      sources_count: 0,
      duration_ms: Date.now() - startTime,
      error: "All searches failed",
    };
  }

  // Quick synthesis
  const combined = successful.map((r) => r.content).join("\n\n---\n\n");
  const synthesisPrompt = `Synthesize these research findings on "${topic}" into a concise summary (3-4 paragraphs) and list 5-7 key points as bullets:

${combined}`;

  const synthesis = await queryAgentForAnalysis("gemini", synthesisPrompt);

  // Parse key points
  const key_points: string[] = [];
  if (synthesis.success && synthesis.analysis) {
    const bullets = synthesis.analysis.match(/^[-*•]\s.+$/gm);
    if (bullets) {
      key_points.push(...bullets.map((b) => b.replace(/^[-*•]\s*/, "")));
    }
  }

  return {
    success: true,
    topic,
    summary: synthesis.analysis || combined.substring(0, 2000),
    key_points,
    sources_count: successful.length,
    duration_ms: Date.now() - startTime,
  };
}

/**
 * Explore subtopics - deep dive into specific aspects
 *
 * After initial research, use this to drill into specific subtopics
 * that need more investigation.
 *
 * @param args.main_topic - The main research topic for context
 * @param args.subtopic - The specific subtopic to explore
 * @param args.context - Optional context from previous research
 */
export async function explore_subtopic(args: {
  main_topic: string;
  subtopic: string;
  context?: string;
}): Promise<{
  success: boolean;
  subtopic: string;
  findings: string;
  related_topics: string[];
  duration_ms: number;
  error?: string;
}> {
  log.call("explore_subtopic", args);
  const { main_topic, subtopic, context } = args;

  if (!subtopic) {
    return {
      success: false,
      subtopic: "",
      findings: "",
      related_topics: [],
      duration_ms: 0,
      error: "Subtopic is required",
    };
  }

  const startTime = Date.now();
  sendProgress(`Exploring subtopic: ${subtopic}`);

  // Construct detailed query
  const query = `${subtopic} in context of ${main_topic}`;
  const focusedQuery = context
    ? `Given this context: ${context.substring(0, 500)}...\n\nResearch: ${query}`
    : query;

  // Deep search on subtopic
  const result = await runGeminiSearch(focusedQuery, "detailed analysis");

  if (!result.success) {
    return {
      success: false,
      subtopic,
      findings: "",
      related_topics: [],
      duration_ms: Date.now() - startTime,
      error: result.error,
    };
  }

  // Extract related topics for further exploration
  const relatedPrompt = `Based on this research about "${subtopic}", identify 3-5 related subtopics that would be worth exploring:

${result.content}

List them as simple bullet points.`;

  const relatedResult = await runGeminiSearch(relatedPrompt, "related topics");
  const related_topics: string[] = [];

  if (relatedResult.success && relatedResult.content) {
    const bullets = relatedResult.content.match(/^[-*•]\s.+$/gm);
    if (bullets) {
      related_topics.push(...bullets.slice(0, 5).map((b) => b.replace(/^[-*•]\s*/, "").trim()));
    }
  }

  return {
    success: true,
    subtopic,
    findings: result.content || "",
    related_topics,
    duration_ms: Date.now() - startTime,
  };
}

/**
 * Compare and contrast - research multiple topics/options side by side
 *
 * Useful for decision-making, comparing technologies, or understanding differences.
 *
 * @param args.items - Items to compare (2-4 items)
 * @param args.criteria - Comparison criteria
 * @param args.context - Optional context for the comparison
 */
export async function compare_topics(args: {
  items: string[];
  criteria?: string[];
  context?: string;
}): Promise<{
  success: boolean;
  items: string[];
  comparison_table: string;
  winner_analysis: string;
  recommendations: string;
  duration_ms: number;
  error?: string;
}> {
  log.call("compare_topics", args);
  const { items, criteria, context } = args;

  if (!items || items.length < 2) {
    return {
      success: false,
      items: [],
      comparison_table: "",
      winner_analysis: "",
      recommendations: "",
      duration_ms: 0,
      error: "At least 2 items required for comparison",
    };
  }

  const startTime = Date.now();
  sendProgress(`Comparing: ${items.join(" vs ")}`);

  // Research each item in parallel
  const searchPromises = items.map((item) =>
    runGeminiSearch(`${item} features capabilities pros cons`, "comparison research")
  );

  const searchResults = await Promise.all(searchPromises);
  const successful = searchResults.filter((r) => r.success);

  if (successful.length < 2) {
    return {
      success: false,
      items,
      comparison_table: "",
      winner_analysis: "",
      recommendations: "",
      duration_ms: Date.now() - startTime,
      error: "Could not gather enough data for comparison",
    };
  }

  // Build comparison prompt
  let comparisonPrompt = `Compare these ${items.length} options: ${items.join(", ")}

Research findings:
${items.map((item, i) => `## ${item}\n${searchResults[i].success ? searchResults[i].content : "No data"}`).join("\n\n")}`;

  if (criteria && criteria.length > 0) {
    comparisonPrompt += `\n\nCompare specifically on these criteria:\n${criteria.map((c) => `- ${c}`).join("\n")}`;
  }

  if (context) {
    comparisonPrompt += `\n\nContext for this comparison: ${context}`;
  }

  comparisonPrompt += `\n\nProvide:
1. A comparison table (markdown format)
2. Winner analysis - which is best for different use cases
3. Recommendations based on different scenarios`;

  const comparison = await queryAgentForAnalysis("claude", comparisonPrompt);

  if (!comparison.success) {
    // Fallback to gemini
    const fallback = await queryAgentForAnalysis("gemini", comparisonPrompt);
    if (!fallback.success) {
      return {
        success: false,
        items,
        comparison_table: "",
        winner_analysis: "",
        recommendations: "",
        duration_ms: Date.now() - startTime,
        error: comparison.error || "Comparison synthesis failed",
      };
    }
    return {
      success: true,
      items,
      comparison_table: fallback.analysis || "",
      winner_analysis: "",
      recommendations: "",
      duration_ms: Date.now() - startTime,
    };
  }

  // Parse sections from response
  const response = comparison.analysis || "";
  const tableMatch = response.match(/\|[\s\S]*?\|[\s\S]*?(?=\n\n|$)/);
  const winnerMatch = response.match(/winner analysis[\s\S]*?(?=recommendation|$)/i);
  const recsMatch = response.match(/recommendation[\s\S]*$/i);

  return {
    success: true,
    items,
    comparison_table: tableMatch?.[0] || response,
    winner_analysis: winnerMatch?.[0] || "",
    recommendations: recsMatch?.[0] || "",
    duration_ms: Date.now() - startTime,
  };
}

/**
 * Research timeline - explore how a topic has evolved over time
 *
 * @param args.topic - The topic to trace historically
 * @param args.time_range - Time range to cover (e.g., "5 years", "decade", "history")
 */
export async function research_timeline(args: {
  topic: string;
  time_range?: string;
}): Promise<{
  success: boolean;
  topic: string;
  timeline: Array<{
    period: string;
    events: string;
  }>;
  trends: string;
  future_outlook: string;
  duration_ms: number;
  error?: string;
}> {
  log.call("research_timeline", args);
  const { topic, time_range = "past decade" } = args;

  if (!topic) {
    return {
      success: false,
      topic: "",
      timeline: [],
      trends: "",
      future_outlook: "",
      duration_ms: 0,
      error: "Topic is required",
    };
  }

  const startTime = Date.now();
  sendProgress(`Researching timeline: ${topic} over ${time_range}`);

  // Research historical evolution
  const queries = [
    `${topic} history evolution ${time_range}`,
    `${topic} major milestones breakthroughs`,
    `${topic} future predictions outlook`,
  ];

  const results = await Promise.all(queries.map((q) => runGeminiSearch(q)));
  const successful = results.filter((r) => r.success);

  if (successful.length === 0) {
    return {
      success: false,
      topic,
      timeline: [],
      trends: "",
      future_outlook: "",
      duration_ms: Date.now() - startTime,
      error: "Timeline research failed",
    };
  }

  // Synthesize into timeline
  const synthesisPrompt = `Create a timeline analysis of "${topic}" over ${time_range}:

Research:
${successful.map((r) => r.content).join("\n\n---\n\n")}

Provide:
1. Timeline (chronological list of key events/developments with years)
2. Major trends observed
3. Future outlook and predictions

Format the timeline as a list of periods with their key events.`;

  const synthesis = await queryAgentForAnalysis("gemini", synthesisPrompt);

  // Parse timeline
  const timeline: Array<{ period: string; events: string }> = [];
  if (synthesis.success && synthesis.analysis) {
    // Try to extract year-based entries
    const yearMatches = synthesis.analysis.matchAll(/(\d{4}s?|\d{4}-\d{4}|[A-Za-z]+ \d{4})[:\s-]+([^\n]+)/g);
    for (const match of yearMatches) {
      timeline.push({ period: match[1], events: match[2].trim() });
    }
  }

  // Extract trends and outlook
  const trendsMatch = synthesis.analysis?.match(/trends?[\s\S]*?(?=future|outlook|$)/i);
  const outlookMatch = synthesis.analysis?.match(/(future|outlook)[\s\S]*$/i);

  return {
    success: true,
    topic,
    timeline: timeline.length > 0 ? timeline : [{ period: time_range, events: synthesis.analysis || "" }],
    trends: trendsMatch?.[0] || "",
    future_outlook: outlookMatch?.[0] || "",
    duration_ms: Date.now() - startTime,
  };
}

/**
 * Expert opinions - gather and synthesize expert perspectives on a topic
 *
 * @param args.topic - The topic to find expert opinions on
 * @param args.perspective - Type of experts to focus on (academic, industry, policy, etc.)
 */
export async function gather_expert_opinions(args: {
  topic: string;
  perspective?: "academic" | "industry" | "policy" | "all";
}): Promise<{
  success: boolean;
  topic: string;
  experts_found: string[];
  consensus_view: string;
  dissenting_opinions: string[];
  key_debates: string[];
  duration_ms: number;
  error?: string;
}> {
  log.call("gather_expert_opinions", args);
  const { topic, perspective = "all" } = args;

  if (!topic) {
    return {
      success: false,
      topic: "",
      experts_found: [],
      consensus_view: "",
      dissenting_opinions: [],
      key_debates: [],
      duration_ms: 0,
      error: "Topic is required",
    };
  }

  const startTime = Date.now();
  sendProgress(`Gathering expert opinions on: ${topic}`);

  // Build perspective-specific queries
  const perspectiveQueries: Record<string, string[]> = {
    academic: [`${topic} academic research experts`, `${topic} peer reviewed studies findings`],
    industry: [`${topic} industry leaders opinions`, `${topic} practitioner insights`],
    policy: [`${topic} policy experts analysis`, `${topic} regulatory perspective`],
    all: [
      `${topic} expert opinions analysis`,
      `${topic} thought leaders perspectives`,
      `${topic} debates controversies`,
    ],
  };

  const queries = perspectiveQueries[perspective] || perspectiveQueries.all;
  const results = await Promise.all(queries.map((q) => runGeminiSearch(q)));
  const successful = results.filter((r) => r.success);

  if (successful.length === 0) {
    return {
      success: false,
      topic,
      experts_found: [],
      consensus_view: "",
      dissenting_opinions: [],
      key_debates: [],
      duration_ms: Date.now() - startTime,
      error: "Could not gather expert opinions",
    };
  }

  // Synthesize expert views
  const synthesisPrompt = `Analyze these findings about expert opinions on "${topic}":

${successful.map((r) => r.content).join("\n\n---\n\n")}

Extract:
1. Names of specific experts mentioned (if any)
2. The consensus view among experts
3. Any dissenting or minority opinions
4. Key debates or unresolved questions

Be specific about who said what when possible.`;

  const synthesis = await queryAgentForAnalysis("claude", synthesisPrompt);

  // Parse structured data
  const experts_found: string[] = [];
  const dissenting_opinions: string[] = [];
  const key_debates: string[] = [];

  if (synthesis.success && synthesis.analysis) {
    // Extract expert names (look for patterns like "Dr. X", "Professor Y", names with titles)
    const nameMatches = synthesis.analysis.match(/(Dr\.|Prof\.|Professor)\s+[\w\s]+(?=,|\.|said|argues)/gi);
    if (nameMatches) {
      experts_found.push(...[...new Set(nameMatches)].slice(0, 10));
    }

    // Extract dissenting opinions
    const dissentSection = synthesis.analysis.match(/dissenting[\s\S]*?(?=debate|key|$)/i);
    if (dissentSection) {
      const bullets = dissentSection[0].match(/^[-*•]\s.+$/gm);
      if (bullets) {
        dissenting_opinions.push(...bullets.map((b) => b.replace(/^[-*•]\s*/, "")));
      }
    }

    // Extract debates
    const debatesSection = synthesis.analysis.match(/debates?[\s\S]*$/i);
    if (debatesSection) {
      const bullets = debatesSection[0].match(/^[-*•]\s.+$/gm);
      if (bullets) {
        key_debates.push(...bullets.map((b) => b.replace(/^[-*•]\s*/, "")));
      }
    }
  }

  return {
    success: true,
    topic,
    experts_found,
    consensus_view: synthesis.analysis || "",
    dissenting_opinions,
    key_debates,
    duration_ms: Date.now() - startTime,
  };
}

/**
 * Generate research report - create a formatted research document
 *
 * Takes research results and formats them into a structured report.
 *
 * @param args.research - The research results to format
 * @param args.format - Output format: "markdown", "outline", "executive_summary"
 * @param args.include_methodology - Whether to include research methodology
 */
export async function generate_report(args: {
  research: DeepResearchResult;
  format?: "markdown" | "outline" | "executive_summary";
  include_methodology?: boolean;
}): Promise<{
  success: boolean;
  report: string;
  word_count: number;
  error?: string;
}> {
  log.call("generate_report", args);
  const { research, format = "markdown", include_methodology = true } = args;

  if (!research || !research.success) {
    return {
      success: false,
      report: "",
      word_count: 0,
      error: "Valid research results required",
    };
  }

  sendProgress("Generating research report...");

  let report = "";

  if (format === "executive_summary") {
    report = `# Executive Summary: ${research.topic}

${research.summary}

## Key Findings
${research.key_findings.map((f) => `- ${f}`).join("\n")}

## Recommendations
${research.recommendations.map((r) => `- ${r}`).join("\n")}
`;
  } else if (format === "outline") {
    report = `# Research Outline: ${research.topic}

## Summary
${research.summary.split("\n")[0]}

## Sections
${research.sections.map((s) => `### ${s.title}`).join("\n")}

## Key Findings (${research.key_findings.length})
${research.key_findings.map((f, i) => `${i + 1}. ${f}`).join("\n")}

## Knowledge Gaps (${research.knowledge_gaps.length})
${research.knowledge_gaps.map((g, i) => `${i + 1}. ${g}`).join("\n")}

## Recommendations (${research.recommendations.length})
${research.recommendations.map((r, i) => `${i + 1}. ${r}`).join("\n")}
`;
  } else {
    // Full markdown report
    report = `# Research Report: ${research.topic}

## Executive Summary
${research.summary}

---

${research.sections.map((s) => `## ${s.title}\n\n${s.content}`).join("\n\n---\n\n")}

---

## Key Findings

${research.key_findings.map((f) => `- ${f}`).join("\n")}

## Knowledge Gaps

${research.knowledge_gaps.length > 0 ? research.knowledge_gaps.map((g) => `- ${g}`).join("\n") : "No significant gaps identified."}

## Recommendations

${research.recommendations.map((r) => `- ${r}`).join("\n")}
`;

    if (include_methodology) {
      report += `
---

## Methodology

- **Queries Executed:** ${research.methodology.queries_executed}
- **Sources Analyzed:** ${research.methodology.sources_analyzed}
- **AI Agents Consulted:** ${research.methodology.agents_consulted.join(", ")}
- **Total Research Time:** ${(research.total_duration_ms / 1000).toFixed(1)} seconds
`;
    }
  }

  const word_count = report.split(/\s+/).length;

  return {
    success: true,
    report,
    word_count,
  };
}
