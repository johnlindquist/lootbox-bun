# Lootbox-Bun - Code Mode for LLMs

> **This is a Bun port of [jx-codes/lootbox](https://github.com/jx-codes/lootbox)**. Full credit goes to the original author for the concept and implementation. This fork converts the project from Deno to Bun runtime.

Code mode doesn't replace MCP - it orchestrates it.

Example: Fetch Jira issues, filter high-priority, store in KV
- MCP: 4 sequential tool calls
- Code mode: 1 script that calls 4 tools

The script is reusable. Now you have a "get-high-priority-jira"
tool. It's tools all the way up.

That's what Lootbox does.

## What it is

Lootbox is inspired by "Code Mode" - LLMs write TypeScript code to call APIs rather than using tool invocation. This leverages what LLMs are already good at: writing real code with types and IntelliSense. The repository includes example tools for key-value storage, SQLite, knowledge graphs, GraphQL, and filesystem operations that you can copy to your project.

https://blog.cloudflare.com/code-mode/

## Why Code Mode?

- **LLMs are better at writing code** than using artificial tool-calling syntax
- **Real-world TypeScript** is abundant in training data vs. contrived tool examples
- **Code execution allows chaining** multiple API calls without token overhead
- **Type safety and IntelliSense** provide better developer experience

## Prerequisites

- [Bun](https://bun.sh/) v1.0 or later
- Git (for cloning the repository)

## Quick Install

```bash
git clone https://github.com/johnlindquist/lootbox-bun
cd lootbox-bun
bun install
```

## Quick Start

### 1. Start Server

```bash
bun run src/lootbox-cli.ts server
```

### 2. Initialize Project

```bash
bun run src/lootbox-cli.ts init  # Creates .lootbox/ in current directory
```

The server starts with:

- WebSocket endpoint at `ws://localhost:3000/ws`
- Web UI at `http://localhost:3000/ui`
- OpenAPI docs at `http://localhost:3000/doc`

### 3. Discover Available Tools

```bash
# List all available tool namespaces
bun run src/lootbox-cli.ts tools

# Get TypeScript type definitions for specific namespaces
bun run src/lootbox-cli.ts tools types kv,sqlite,memory

# List available scripts with examples
bun run src/lootbox-cli.ts scripts
```

### 4. Execute Scripts

```bash
# Execute inline code
bun run src/lootbox-cli.ts exec 'console.log(await tools.kv.get({key: "test"}))'

# Execute from file
bun run src/lootbox-cli.ts script.ts

# Execute from stdin
cat script.ts | bun run src/lootbox-cli.ts
```

## MCP Bridge for Claude Code

Lootbox-Bun includes an MCP bridge that exposes your tools to Claude Code:

### Setup

1. Start the lootbox server:
```bash
bun run src/lootbox-cli.ts server --port 3456
```

2. Add to your Claude Code MCP settings (`~/.claude/claude_desktop_config.json` or similar):
```json
{
  "mcpServers": {
    "lootbox": {
      "command": "bun",
      "args": ["run", "/path/to/lootbox-bun/mcp-bridge.ts"],
      "env": {
        "LOOTBOX_URL": "ws://localhost:3456/ws"
      }
    }
  }
}
```

3. Your lootbox tools will now be available in Claude Code with the format `namespace__function` (e.g., `basic_memory__write_memory`).

## Included Tools

The repository includes several tools in `.lootbox/tools/` that demonstrate common use cases and provide useful functionality out of the box.

### Basic Memory Tool

**File**: `.lootbox/tools/basic_memory.ts`

Wraps the [basic-memory](https://github.com/basicmemory/basic-memory) CLI for persistent, local-first knowledge management. Memories are stored as markdown files with semantic search capabilities.

**Prerequisites**:
```bash
# Install basic-memory CLI (requires Python 3.10+)
pip install basic-memory
# or
pipx install basic-memory
```

**Available Functions**:
```typescript
// Write a memory with title and markdown content
await tools.basic_memory.write_memory({
  title: "Meeting Notes",
  content: "## Discussion\n...",
  folder: "work",      // optional, default: "memories"
  tags: "meeting,q4"   // optional comma-separated tags
})

// Read a memory by permalink
await tools.basic_memory.read_memory({ permalink: "meeting-notes" })

// Semantic search across memories
await tools.basic_memory.search_memories({ query: "meeting", page_size: 10 })

// List recent activity
await tools.basic_memory.list_memories({})

// Build context for a topic
await tools.basic_memory.build_context({ topic: "project architecture" })

// Sync and status
await tools.basic_memory.sync_memories({})
await tools.basic_memory.memory_status({})
```

---

### DeepWiki Tool

**File**: `.lootbox/tools/deepwiki.ts`

Provides AI-powered documentation understanding for any public GitHub repository via the [DeepWiki](https://deepwiki.com) service. Useful for investigating how open-source libraries and frameworks work.

**Prerequisites**:
```bash
# Requires @wong2/mcp-cli (installed automatically via bunx)
# No manual installation needed - runs via bunx on first use
```

**Available Functions**:
```typescript
// Get documentation table of contents for a repo
await tools.deepwiki.read_wiki_structure({ repo_name: "anthropics/claude-code" })

// Get full documentation content
await tools.deepwiki.read_wiki_contents({ repo_name: "facebook/react" })

// Ask any question about a repository (AI-powered)
await tools.deepwiki.ask_question({
  repo_name: "vercel/next.js",
  question: "How does the App Router handle server components?"
})
```

**Typical Workflow**:
1. Call `read_wiki_structure` first to see what documentation is available
2. Call `read_wiki_contents` for comprehensive context
3. Call `ask_question` for specific questions about the codebase

---

### MCP CLI Tool

**File**: `.lootbox/tools/mcp_cli.ts`

A wrapper for [@wong2/mcp-cli](https://github.com/wong2/mcp-cli) to investigate and interact with any MCP server. Useful for debugging MCP servers or accessing MCP endpoints that aren't configured locally.

**Prerequisites**:
```bash
# Requires @wong2/mcp-cli (installed automatically via bunx)
# No manual installation needed - runs via bunx on first use
```

**Available Functions**:
```typescript
// Call a tool on an MCP server via SSE endpoint
await tools.mcp_cli.call_tool_sse({
  endpoint: "https://mcp.deepwiki.com/sse",
  tool_name: "read_wiki_structure",
  tool_args: { repoName: "owner/repo" }
})

// Call a tool on an MCP server via HTTP endpoint
await tools.mcp_cli.call_tool_http({
  endpoint: "https://mcp.example.com/mcp",
  tool_name: "some_tool",
  tool_args: { key: "value" }
})

// Read a resource from an MCP server
await tools.mcp_cli.read_resource_sse({
  endpoint: "https://mcp.example.com/sse",
  resource_uri: "resource://some-resource"
})

// Get a prompt from an MCP server
await tools.mcp_cli.get_prompt_sse({
  endpoint: "https://mcp.example.com/sse",
  prompt_name: "my-prompt",
  prompt_args: { context: "..." }
})
```

---

### Creating Your Own Tools

Create TypeScript files in `.lootbox/tools/`:

```typescript
// .lootbox/tools/myapi.ts
export async function processData(args: {
  items: string[];
  threshold: number;
}): Promise<{ processed: number; results: string[] }> {
  const results = args.items.filter((item) => item.length > args.threshold);
  return { processed: results.length, results };
}
```

## Script Management

Lootbox includes a script management system for creating reusable, documented scripts.

### Scripts Directory

Scripts are stored in `.lootbox/scripts/` and can be organized in subdirectories.

### Creating Scripts

```bash
# Create a new script from template
bun run src/lootbox-cli.ts scripts init process-data

# This creates .lootbox/scripts/process-data.ts with template
```

### Script Format

Scripts support JSDoc comments for documentation and examples:

```typescript
/**
 * Process and format tags from JSON input
 * @example echo '{"tags": ["typescript", "bun"]}' | bun run src/lootbox-cli.ts memory/tags.ts
 * @example echo '{"tags": ["a", "b"], "filter": "a"}' | bun run src/lootbox-cli.ts memory/tags.ts
 */

const input = stdin().json();

if (!input || typeof input !== "object") {
  console.error(
    JSON.stringify({
      error: "Invalid input. Expected JSON object",
    })
  );
  throw new Error("Invalid input");
}

// Your script logic here
console.log(JSON.stringify(result, null, 2));
```

### Running Scripts

Use `bun run src/lootbox-cli.ts scripts` to list all available scripts with descriptions and examples from JSDoc.

```bash
# Scripts auto-resolve from .lootbox/scripts/
bun run src/lootbox-cli.ts process-data.ts

# Subdirectories work too
bun run src/lootbox-cli.ts memory/tags.ts

# Pipe data to scripts
echo '{"tags": ["a", "b"]}' | bun run src/lootbox-cli.ts memory/tags.ts
```

### stdin() Helper

When piping data to scripts, use the `stdin()` helper function:

**Methods**:

- `.text()` - Returns trimmed text content
- `.json()` - Returns parsed JSON object or null if invalid
- `.lines()` - Returns array of non-empty, trimmed lines
- `.raw()` - Returns raw input without processing

**Example**:

```typescript
// Process JSON input
const data = stdin().json();
console.log(data);

// Process text lines
const lines = stdin().lines();
lines.forEach((line) => console.log(line.toUpperCase()));

// Get raw text
const raw = stdin().raw();
```

## Configuration

Create `lootbox.config.json` in your project directory:

```json
{
  "port": 3000,
  "serverUrl": "ws://localhost:3000/ws",
  "lootboxRoot": ".lootbox",
  "lootboxDataDir": "./data",
  "mcpServers": {
    // WIP
  }
}
```

**Configuration Options:**

- `port` - Server port (default: 3000)
- `serverUrl` - Override WebSocket URL for custom host/protocol (optional, derived from port if not specified)
- `lootboxRoot` - Directory containing tools/, workflows/, scripts/ subdirectories (default: `.lootbox`)
- `lootboxDataDir` - Directory for runtime data storage (optional, defaults to `~/.local/share/lootbox` on Linux/Mac, `%LOCALAPPDATA%\lootbox` on Windows)
- `mcpServers` - External MCP server configurations (optional)

**Directory Resolution** (priority order):

1. Explicit `--lootbox-root` flag
2. `lootboxRoot` from config file
3. Local `.lootbox/` directory (if exists)
4. Global `~/.lootbox/` directory

**CLI Flags:**

- `--port <number>` - Custom server port
- `--lootbox-root <path>` - Custom tools directory
- `--lootbox-data-dir <path>` - Custom data directory
- `--server <url>` - Custom server URL for execution

## CLI Command Reference

### Execution

- `bun run src/lootbox-cli.ts script.ts` - Execute TypeScript file
- `bun run src/lootbox-cli.ts exec 'code'` - Execute inline code
- `cat script.ts | bun run src/lootbox-cli.ts` - Execute from stdin

### Tools & Scripts Discovery

- `bun run src/lootbox-cli.ts tools` - List all tool namespaces (local + MCP)
- `bun run src/lootbox-cli.ts tools types <namespaces>` - Get TypeScript types (comma-separated)
- `bun run src/lootbox-cli.ts scripts` - List available scripts with examples
- `bun run src/lootbox-cli.ts scripts init <name>` - Create new script from template

### Server & Init

- `bun run src/lootbox-cli.ts server` - Start server (default port 3000)
- `bun run src/lootbox-cli.ts server --port <port> --lootbox-root <dir> --lootbox-data-dir <dir>` - Start with custom settings
- `bun run src/lootbox-cli.ts init` - Create `.lootbox/` directory structure

### Help

- `bun run src/lootbox-cli.ts --help` - Human-friendly help
- `bun run src/lootbox-cli.ts --llm-help` - LLM-focused command reference
- `bun run src/lootbox-cli.ts --config-help` - Configuration documentation
- `bun run src/lootbox-cli.ts --version` - Show version number

## MCP Server Integration

Integrate external MCP servers alongside local tools. MCP tools are namespaced with `mcp_{servername}` prefix.

### Configuration

```json
{
  "mcpServers": {
    // WIP may not work properly with all mcp servers
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    }
  }
}
```

### Usage

Access MCP tools with `mcp_{servername}` namespace prefix:

```typescript
// Filesystem MCP server
await tools.mcp_filesystem.read_file({ path: "/etc/hosts" });
await tools.mcp_filesystem.list_directory({ path: "/tmp" });

// GitHub MCP server
await tools.mcp_github.create_issue({
  repo: "owner/repo",
  title: "Bug Report",
  body: "Description...",
});

// Mix MCP tools with local tools
const data = await tools.kv.get({ key: "config" });
await tools.mcp_github.create_issue({
  repo: "owner/repo",
  title: data.value.title,
});
```

### Discovery

MCP server namespaces appear alongside local tools when running `bun run src/lootbox-cli.ts tools`, prefixed with `mcp_` (e.g., `mcp_filesystem`, `mcp_github`).

## Workflows

Execute multi-step workflows with Handlebars templating, loops, and session tracking.

**Commands:**

- `bun run src/lootbox-cli.ts workflow start <file>` - Start workflow
- `bun run src/lootbox-cli.ts workflow step` - Execute/show current step
- `bun run src/lootbox-cli.ts workflow step --end-loop="reason"` - End loop early (after min iterations)
- `bun run src/lootbox-cli.ts workflow status` - Check current position
- `bun run src/lootbox-cli.ts workflow reset` - Reset to beginning
- `bun run src/lootbox-cli.ts workflow abort --abort="reason"` - Abort with reason

### Workflow File Format (YAML)

Workflows are YAML files located in `.lootbox/workflows/` or current directory.

**Basic Structure**:

```yaml
steps:
  - title: Step 1 - Setup
    prompt: |
      Initialize the project structure.

  - title: Step 2 - Implementation
    prompt: |
      Implement the core features.

  - title: "Loop: Testing (iteration {{loop}}/{{totalSteps}})"
    loop:
      min: 2
      max: 5
    prompt: |
      Run tests and fix issues.
      {{#if (eq loop 1)}}
      This is the first iteration.
      {{else}}
      This is iteration {{loop}}.
      {{/if}}
```

### Handlebars Templating

Workflows support Handlebars templates with built-in helpers:

**Template Variables**:

- `{{step}}` - Current step number (1-based)
- `{{totalSteps}}` - Total number of steps
- `{{loop}}` - Current loop iteration (only in loop steps, 1-based)

**Helpers**:

- `{{eq a b}}` - Equal comparison
- `{{ne a b}}` - Not equal
- `{{lt a b}}` - Less than
- `{{gt a b}}` - Greater than
- `{{lte a b}}` - Less than or equal
- `{{gte a b}}` - Greater than or equal

**Example with Conditionals**:

```yaml
steps:
  - title: "Step {{step}} of {{totalSteps}}"
    prompt: |
      {{#if (eq step 1)}}
      This is the first step.
      {{else if (eq step totalSteps)}}
      This is the final step.
      {{else}}
      This is an intermediate step.
      {{/if}}
```

### Loop Mechanics

Loop steps repeat with configurable min/max iterations. When max iterations reached, automatically advances to next step.

```yaml
- title: "Review Loop ({{loop}}/{{max}})"
  loop:
    min: 2 # Minimum iterations before --end-loop allowed
    max: 5 # Maximum iterations (auto-advances)
  prompt: |
    Review the code. Current iteration: {{loop}}
```

### Session Tracking

Each workflow run has a unique session ID for tracking workflow events:

- Session ID generated on `workflow start`
- Persisted in `.lootbox-workflow.json` state file
- Used for workflow logging and analytics
- Visible with `bun run src/lootbox-cli.ts workflow status`

### Workflow State

Workflow state stored in `.lootbox-workflow.json` includes:

- Current step index
- Loop iteration count
- Session ID
- Workflow file path

State automatically managed - deleted on completion or abort.

## Tool Requirements

All tools must follow these patterns:

```typescript
// ✅ Correct - with single parameter (object)
export async function functionName(args: ArgsType): Promise<ReturnType> {
  // Implementation
}

// ✅ Correct - no parameters
export async function getInfo(): Promise<InfoResult> {
  return { version: "0.0.54" };
}

// ✅ Correct - with TypeScript interfaces
export interface CreateArgs {
  name: string;
  value: number;
}

export interface CreateResult {
  success: boolean;
  id: string;
}

export async function create(args: CreateArgs): Promise<CreateResult> {
  return { success: true, id: "123" };
}

// ❌ Wrong - not exported
async function privateFunction(args: any) {}

// ❌ Wrong - multiple parameters
export function wrongSignature(x: number, y: string) {}
```

**Requirements:**

- Must be exported using `export` keyword
- Must have 0 or 1 parameter only
- If 1 parameter, it must be an object type
- Multiple positional parameters are not supported
- Should use TypeScript interfaces for type safety
- Should be async (return Promise) for consistency

**Best Practices:**

- Export TypeScript interfaces for args and results
- Use JSDoc comments for function documentation
- Keep functions focused on single responsibility
- Handle errors with clear error messages
- Return structured objects, not primitives

## HTTP API Endpoints

| Endpoint             | Method | Description                                       |
| -------------------- | ------ | ------------------------------------------------- |
| `/health`            | GET    | Server health check                               |
| `/namespaces`        | GET    | List available tool namespaces and MCP servers    |
| `/types`             | GET    | All TypeScript type definitions for all tools     |
| `/types/:namespaces` | GET    | Types for specific namespaces (comma-separated)   |
| `/client.ts`         | GET    | Generated TypeScript client with type definitions |
| `/ui`                | GET    | Interactive status dashboard (HTML)               |
| `/doc`               | GET    | OpenAPI/Swagger documentation (HTML)              |
| `/ws`                | WS     | WebSocket endpoint for script execution           |

### Examples

```bash
# Get all namespaces
curl http://localhost:3000/namespaces

# Get types for specific namespaces
curl http://localhost:3000/types/kv,sqlite,memory

# Get all types
curl http://localhost:3000/types

# Download TypeScript client
curl http://localhost:3000/client.ts > client.ts

# Health check
curl http://localhost:3000/health
```

## Development

### Development Mode

Development mode enables hot-reloading and debugging:

```bash
# Start server in development mode
bun run src/lootbox-cli.ts server

# This enables:
# - Automatic restarts on file changes
# - Verbose logging
# - Development-specific features
```

### Building

```bash
# Install dependencies
bun install

# Build UI (if applicable)
bun run ui:build

# Run directly
bun run src/lootbox-cli.ts server
```

### Code Quality

```bash
# Type check
bun run typecheck

# Or use tsc directly
bunx tsc --noEmit
```

## Architecture

```
┌─────────────┐          ┌─────────────────┐          ┌─────────────────┐
│   Clients   │          │     lootbox     │          │      Tools      │
│             │          │                 │          │                 │
│ • Web UI    │◄────────►│ • Auto-discover │◄────────►│ • .lootbox/tools│
│ • CLI       │    WS    │ • Type gen      │   Load   │ • MCP Servers   │
│ • LLM/MCP   │   HTTP   │ • Sandboxing    │          │                 │
└─────────────┘          └─────────────────┘          └─────────────────┘
```

**Key Features:**

- WebSocket RPC server with auto-discovery
- Sandboxed script execution with timeout
- Full TypeScript type safety
- MCP server integration

## Technical Details

### Worker-Based Execution

- **Fast Startup**: Workers stay warm, eliminating cold-start overhead

### Script Sandboxing

- **Isolated Execution**: User scripts run in separate Bun processes
- **Limited Permissions**: Scripts only have network access
- **10-Second Timeout**: Automatic termination for long-running scripts
- **Injected Client**: `tools` object automatically available

### Type System

- **AST Analysis**: Uses `ts-morph` to extract TypeScript types
- **Namespace Prefixing**: Prevents conflicts (e.g., `Kv_GetArgs`)
- **JSDoc Support**: Extracts documentation comments
- **Selective Generation**: Filter types by namespace

### Security Considerations

**Local-First Design**: Lootbox runs on your local machine in trusted environments.

- **Tool Functions**: Run with full access - only include trusted code
- **User Scripts**: Sandboxed with network access only
- **No Authentication**: Designed for localhost use
- **MCP Servers**: External processes with configurable permissions

## Credits

This project is a Bun port of the original [lootbox](https://github.com/jx-codes/lootbox) by [jx-codes](https://github.com/jx-codes). The original implementation was built for Deno and this fork converts it to use the Bun runtime.

### Original Inspiration

This project implements ideas from:

- Cloudflare's "Code Mode: the better way to use MCP"
- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)

## License

MIT License - See LICENSE file for details.
