# codex-mem

> Persistent cross-session memory for [Codex CLI](https://github.com/openai/codex), powered by [claude-mem](https://github.com/thedotmack/claude-mem). Memory is shared bidirectionally with Claude Code.

## Why

Codex CLI sessions are stateless — every time you start a new conversation, all context from previous sessions is lost. codex-mem fixes this by:

- Automatically recording what you do in every session
- Injecting relevant past context when a new session starts
- Letting you search across all past work from any session

Your memory is stored locally in `~/.claude-mem/claude-mem.db` (SQLite) and is **shared with Claude Code**. Anything Codex captures is searchable in Claude Code, and vice versa.

## Features

| Feature | How |
|---------|-----|
| Auto-capture tool calls | PostToolUse hook records every tool execution |
| Auto-inject past context | SessionStart hook loads relevant memories at startup |
| Record user prompts | Each response records the raw prompt (preserves original language) |
| Periodic English summaries | Every 3-5 prompts, an English summary is saved for cross-language search |
| Cross-platform search | 9 MCP tools + curl/PowerShell Direct API fallback |
| Cross-tool memory sharing | Same SQLite DB used by Claude Code's claude-mem |
| Windows-safe cold start | Bind probe + single-attempt + fail-closed strategy |
| No manual lifecycle | Hooks handle session init and observation capture |

## Architecture

```
┌───────────────────────────────────────────────────────┐
│                      Codex CLI                        │
│                                                       │
│  ┌────────────┐  ┌────────────┐  ┌────────────────┐  │
│  │SessionStart│  │PostToolUse │  │  MCP Bridge    │  │
│  │   Hook     │  │   Hook     │  │  (9 tools)     │  │
│  └─────┬──────┘  └─────┬──────┘  └───────┬────────┘  │
│        │               │                 │           │
│        │ POST          │ POST            │ HTTP      │
│        │ /sessions/    │ /sessions/      │ GET/POST  │
│        │ init          │ observations    │           │
└────────┼───────────────┼─────────────────┼───────────┘
         │               │                 │
         ▼               ▼                 ▼
┌───────────────────────────────────────────────────────┐
│    claude-mem Worker API (localhost:37777)             │
│    Managed by Claude Code's claude-mem plugin         │
├───────────────────────────────────────────────────────┤
│  ~/.claude-mem/claude-mem.db (SQLite)                 │
│  Observations / Sessions / Summaries / Prompts        │
│  <-- Shared with Claude Code sessions -->             │
└───────────────────────────────────────────────────────┘
```

### Data Flow

1. **Session Start** — When Codex starts a session, the SessionStart hook:
   - Checks if the Worker API is running (with port bind probe on Windows)
   - Cold-starts the Worker if needed (smart-install → bun-runner → worker-service)
   - Calls `POST /api/sessions/init` to create a session
   - Calls `GET /api/context/inject` to fetch relevant past memories
   - Injects the context into Codex via `additional_context` JSON output

2. **During Work** — After every tool call (file edits, bash commands, searches, etc.), the PostToolUse hook:
   - Reads tool execution data from stdin
   - Calls `POST /api/sessions/observations` to record it
   - Runs asynchronously — never blocks Codex

3. **Search / Save** — When you need to look up past work:
   - Model uses `mem_search` MCP tool → mcp-bridge.mjs → Worker API
   - If MCP is blocked by Codex approval settings, falls back to curl/PowerShell

## Prerequisites

| Requirement | Why |
|-------------|-----|
| [Codex CLI](https://github.com/openai/codex) | The host CLI this plugin extends |
| [Claude Code](https://claude.ai/claude-code) + [claude-mem](https://github.com/thedotmack/claude-mem) | Provides the Worker API and SQLite database |
| Node.js >= 18 | Runs MCP bridge and hook helper scripts |
| Git Bash (Windows only) | Hooks are bash scripts; run-hook.cmd finds Git Bash automatically |

## Installation

### 1. Clone

```bash
git clone https://github.com/PapainTea/codex-mem.git
cd codex-mem
```

### 2. Install dependencies

```bash
npm install
```

### 3. Deploy to Codex plugin directory

Linux / macOS:
```bash
mkdir -p ~/.codex/.tmp/plugins/plugins/claude-mem
cp -r .codex-plugin hooks scripts skills package.json package-lock.json \
  ~/.codex/.tmp/plugins/plugins/claude-mem/
cd ~/.codex/.tmp/plugins/plugins/claude-mem && npm install --production
```

Windows (Git Bash):
```bash
mkdir -p "$HOME/.codex/.tmp/plugins/plugins/claude-mem"
cp -r .codex-plugin hooks scripts skills package.json package-lock.json \
  "$HOME/.codex/.tmp/plugins/plugins/claude-mem/"
cd "$HOME/.codex/.tmp/plugins/plugins/claude-mem" && npm install --production
```

### 4. Register MCP server

```bash
codex mcp add claude-mem -- node "$HOME/.codex/.tmp/plugins/plugins/claude-mem/scripts/mcp-bridge.mjs"
```

### 5. Enable hooks (experimental feature)

```bash
codex features enable codex_hooks
```

### 6. Verify

Restart Codex. On startup you should see:
```
Loaded: 1 plugin · skills · hooks · 1 MCP server
```

## Windows Safety

On Windows, Bun (used by the claude-mem Worker) has a known TCP socket leak: when a Bun process is killed, the kernel may not release the TCP port, causing `EADDRINUSE` that persists until reboot. ([bun#issue](https://github.com/oven-sh/bun/issues))

This plugin implements a **fail-closed** strategy to avoid making things worse:

| Scenario | Behavior |
|----------|----------|
| Worker running + healthy | Use directly |
| Worker not running + port free | **One** cold start attempt (smart-install → bun-runner → worker-service) |
| Worker not running + port occupied | **Do nothing** — output `{}`, skip silently |
| Cold start times out | **Do nothing** — no retry, no loop |
| MCP tool fails | Return clear error message, suggest Direct API fallback |

The bind probe uses Node.js `net.createServer()` to test if the port is actually bindable, detecting ghost sockets that `netstat` might miss.

## Searching Memory

### Via MCP Tools (preferred)

```
mem_search({ query: "auth middleware refactor", limit: 20 })
mem_timeline({ query: "database migration", depth_before: 10, depth_after: 10 })
mem_get_observations({ ids: [123, 456] })
```

### Via Direct API (fallback when MCP is blocked)

curl (Git Bash):
```bash
curl -s -G "http://127.0.0.1:37777/api/search" \
  --data-urlencode "query=auth middleware" \
  --data-urlencode "limit=20"
```

PowerShell:
```powershell
$q = [uri]::EscapeDataString("auth middleware")
Invoke-RestMethod "http://127.0.0.1:37777/api/search?query=$q&limit=20"
```

See [SKILL.md](skills/claude-mem/SKILL.md) for the full list of API endpoints and examples.

## File Structure

```
codex-mem/
├── .codex-plugin/
│   └── plugin.json           # Plugin manifest — declares hooks + skills
├── hooks/
│   ├── hooks.json            # Hook definitions (SessionStart + PostToolUse)
│   ├── session-start         # Init session, cold start Worker, inject context
│   ├── post-tool-use         # Auto-capture tool call observations
│   └── run-hook.cmd          # Windows polyglot wrapper (finds Git Bash)
├── scripts/
│   ├── mcp-bridge.mjs        # MCP server — 9 memory tools over stdio
│   └── mcp-bridge.cmd        # Windows batch launcher
├── skills/
│   └── claude-mem/
│       ├── SKILL.md          # Model instructions (search, save, fallback)
│       └── agents/openai.yaml # MCP tool declarations
├── package.json              # Dependencies (@modelcontextprotocol/sdk)
├── LICENSE                   # MIT
└── README.md
```

## MCP Tools Reference

| Tool | Description | Auto? |
|------|-------------|-------|
| `mem_session_start` | Initialize a memory session | Yes (hook) |
| `mem_post_tool_use` | Record a tool usage observation | Yes (hook) |
| `mem_session_end` | End session, trigger summary | No (optional) |
| `mem_search` | Full-text search across all memories | No (manual) |
| `mem_timeline` | Timeline view around a specific event | No (manual) |
| `mem_get_observations` | Fetch full details by observation ID | No (manual) |
| `mem_save` | Manually save a note or decision | No (manual) |
| `mem_context` | Get recent context for a project | No (manual) |
| `mem_stats` | Database statistics (size, counts, uptime) | No (manual) |

**Auto?** = Whether hooks handle this automatically. Tools marked "Yes" are still available for manual use but you don't need to call them — hooks do it for you.

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| MCP tools return "Worker unavailable" | Worker API not running | Start Claude Code, or check `curl http://127.0.0.1:37777/api/readiness` |
| Hooks not firing | `codex_hooks` feature not enabled | Run `codex features enable codex_hooks` |
| Session start hangs | smart-install.js downloading Bun/dependencies | Wait (first-time only, max ~60s timeout) |
| Port 37777 locked after crash | Bun TCP socket leak (Windows) | Reboot. Do not try to force-start another Worker. |
| "No active session" on mem_session_end | Previous init failed | Check Worker is healthy, try `mem_session_start` first |
| Search returns nothing | Wrong project filter or empty DB | Try `mem_stats` to check DB has data |

## Known Limitations

- **Worker dependency** — Requires claude-mem Worker API running on localhost:37777. Without it, all memory operations fail gracefully but no data is captured.
- **No auto-summarize on exit** — Codex's Stop hook support is unverified; sessions may not get AI-generated summaries. Use `mem_session_end` manually if needed.
- **PostToolUse silent failure** — If Worker crashes mid-session, observations are silently lost (no retry).
- **Windows Bun socket leak** — If Worker enters a zombie state, only a reboot clears the locked port.
- **codex_hooks is experimental** — Hook behavior may change across Codex versions.

## Credits

- [claude-mem](https://github.com/thedotmack/claude-mem) by Alex Newman — the Worker API and memory engine
- [Codex CLI](https://github.com/openai/codex) by OpenAI — the host CLI
- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/sdk) — MCP bridge implementation

## License

[MIT](LICENSE)
