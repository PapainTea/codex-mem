# codex-mem

Persistent memory plugin for [Codex CLI](https://github.com/openai/codex) that shares memory with [Claude Code](https://claude.ai/claude-code) via the [claude-mem](https://github.com/thedotmack/claude-mem) Worker API.

## What It Does

- **Auto-captures** every tool call as an observation via PostToolUse hook
- **Auto-injects** relevant past context at session start via SessionStart hook
- **Shares memory** with Claude Code sessions — anything captured in Codex is searchable in Claude Code and vice versa
- **Provides search tools** via MCP bridge (9 tools) with curl/PowerShell fallback

## Prerequisites

- [Codex CLI](https://github.com/openai/codex) installed
- [Claude Code](https://claude.ai/claude-code) with [claude-mem plugin](https://github.com/thedotmack/claude-mem) installed
- Node.js >= 18
- Git Bash (Windows — hooks require bash)

## Installation

### 1. Clone the plugin

```bash
git clone https://github.com/PapainTea/codex-mem.git
```

### 2. Install dependencies

```bash
cd codex-mem
npm install
```

### 3. Copy to Codex plugin directory

```bash
# Linux/macOS
cp -r . ~/.codex/.tmp/plugins/plugins/claude-mem/

# Windows (Git Bash)
cp -r . "$HOME/.codex/.tmp/plugins/plugins/claude-mem/"
```

### 4. Register MCP server in Codex

```bash
codex mcp add claude-mem -- node "<path-to-codex-mem>/scripts/mcp-bridge.mjs"
```

### 5. Enable hooks (experimental)

```bash
codex features enable codex_hooks
```

### 6. Verify

Restart Codex. You should see the claude-mem skill loaded and hooks active.

## How It Works

```
Codex CLI
  ├─ SessionStart hook → init session + inject past context
  ├─ PostToolUse hook  → auto-capture every tool call
  └─ MCP bridge / curl → search, save, query memory
         │
         ▼
  claude-mem Worker API (localhost:37777)
         │
         ▼
  ~/.claude-mem/claude-mem.db (SQLite, shared with Claude Code)
```

### Windows Safety

On Windows, Bun (used by the Worker) has a known TCP socket leak bug that can cause zombie processes and port lockups. This plugin implements a **fail-closed** strategy:

- **Single cold start only** — if Worker is not running and the port is free, one startup attempt is made
- **No auto-restart** — if Worker crashes or the port is locked, the plugin does not retry
- **Bind probe** — uses `net.createServer()` to detect ghost sockets before attempting startup
- **Graceful degradation** — if Worker is unavailable, hooks silently skip and MCP tools return clear error messages

## File Structure

```
.codex-plugin/
  plugin.json          — Plugin manifest (hooks + skills)
hooks/
  hooks.json           — Hook definitions (SessionStart + PostToolUse)
  session-start        — Bash: init session, cold start Worker, inject context
  post-tool-use        — Bash: capture tool call observations
  run-hook.cmd         — Windows polyglot wrapper (finds Git Bash)
scripts/
  mcp-bridge.mjs       — MCP server (9 memory tools via stdio)
  mcp-bridge.cmd       — Windows batch wrapper
skills/
  claude-mem/
    SKILL.md           — Instructions for Codex model
    agents/openai.yaml — Agent/tool declarations
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `mem_search` | Search across observations, sessions, prompts |
| `mem_timeline` | Get timeline around a specific event |
| `mem_get_observations` | Fetch full details for observation IDs |
| `mem_save` | Manually save a note/decision |
| `mem_context` | Get recent context for a project |
| `mem_stats` | Database statistics |
| `mem_session_start` | Manually start a session (hooks do this automatically) |
| `mem_post_tool_use` | Manually record an observation (hooks do this automatically) |
| `mem_session_end` | End session and trigger summary (optional) |

If MCP tools are blocked by Codex approval settings, the SKILL.md instructs the model to fall back to direct HTTP calls via curl or PowerShell.

## License

MIT
