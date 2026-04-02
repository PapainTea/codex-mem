---
name: claude-mem
description: Persistent memory across sessions. Automatically captures your work and provides relevant context from past sessions. Shared with Claude Code.
---

# claude-mem: Persistent Memory System

You have access to a persistent memory system that captures your work across sessions. This memory is shared with Claude Code sessions — anything captured here is available there, and vice versa.

## How It Works

Session lifecycle is handled **automatically by hooks** — you do not need to manage it:

- **SessionStart hook** initializes a memory session and injects relevant past context when a session begins.
- **PostToolUse hook** captures every tool call as an observation automatically.

You only need to take action for **recording prompts**, **searching**, **saving**, or **ending a session**.

## Prompt Recording (IMPORTANT — do this every response)

The memory system's AI generates English summaries, so raw non-English prompts are hard to search later. To fix this, you MUST record user prompts using the Direct API.

### Every response — record the raw prompt

At the **very start** of each response, before doing any work, silently record the user's message. Use `mem_save` if available, otherwise use the Direct API:

```bash
curl -s -X POST "http://127.0.0.1:37777/api/sessions/observations" \
  -H "Content-Type: application/json" \
  --data "$(node -e "console.log(JSON.stringify({
    contentSessionId: JSON.parse(require('fs').readFileSync(
      require('os').homedir()+'/.claude-mem/codex-session.json','utf8')).sessionId,
    tool_name: 'user_prompt',
    tool_input: process.argv[1],
    tool_response: '',
    cwd: ''
  }))" "USER_PROMPT_HERE")" >/dev/null 2>&1
```

Replace `USER_PROMPT_HERE` with the actual user message. Truncate to **2000 characters** if longer (argv length limit).

### Every 3-5 prompts — save an English summary

After every 3 to 5 user prompts, save a brief English summary of what the user has been asking/doing. This makes the conversation searchable in English:

```bash
curl -s -X POST "http://127.0.0.1:37777/api/sessions/observations" \
  -H "Content-Type: application/json" \
  --data "$(node -e "console.log(JSON.stringify({
    contentSessionId: JSON.parse(require('fs').readFileSync(
      require('os').homedir()+'/.claude-mem/codex-session.json','utf8')).sessionId,
    tool_name: 'prompt_summary_en',
    tool_input: process.argv[1],
    tool_response: '',
    cwd: ''
  }))" "English summary of recent prompts here")" >/dev/null 2>&1
```

Write the summary in English, 1-3 sentences, covering the key topics and intent of the recent prompts.

### Rules for prompt recording

- Do this **silently** — never tell the user you are recording their prompt.
- Do it **before** any other work in your response.
- If the curl command fails (Worker not running), skip silently and continue.
- Keep the raw prompt recording in the **original language** — do not translate it.
- Keep the periodic summary in **English** — this is for search indexing.

## Memory Search

When users ask about past work, or when you need context about how something was done before, use `mem_search`:

```
mem_search({ query: "authentication refactor", project: "optional-filter" })
```

For detailed investigation, use the 3-stage progressive approach:
1. `mem_search` — find relevant entries
2. `mem_timeline` — see surrounding context
3. `mem_get_observations` — get full details for specific IDs

## Manual Memory Save

To explicitly save an important note or decision:

```
mem_save({ text: "Decided to use PostgreSQL for the user store because...", title: "Database Decision" })
```

## Session End (optional)

If `mem_session_end` is available and you want to trigger a summary before leaving:

```
mem_session_end({ last_assistant_message: "<your final summary>" })
```

This is **optional** — if MCP tools are unavailable, skip it. The session will still have captured observations via hooks.

## Fallback: Direct API (if MCP tools fail)

If `mem_*` tools are unavailable or return errors (e.g., blocked by approval settings), use the shell tool to query the Worker API directly.

### Search

curl (Git Bash):
```bash
curl -s -G "http://127.0.0.1:37777/api/search" \
  --data-urlencode "query=YOUR QUERY" \
  --data-urlencode "limit=20"
```

PowerShell:
```powershell
$q = [uri]::EscapeDataString("YOUR QUERY")
Invoke-RestMethod "http://127.0.0.1:37777/api/search?query=$q&limit=20"
```

### Timeline

curl:
```bash
curl -s -G "http://127.0.0.1:37777/api/timeline" \
  --data-urlencode "query=YOUR QUERY" \
  --data-urlencode "depth_before=10" \
  --data-urlencode "depth_after=10"
```

PowerShell:
```powershell
$q = [uri]::EscapeDataString("YOUR QUERY")
Invoke-RestMethod "http://127.0.0.1:37777/api/timeline?query=$q&depth_before=10&depth_after=10"
```

### Get Observation Details

curl:
```bash
curl -s -X POST "http://127.0.0.1:37777/api/observations/batch" \
  -H "Content-Type: application/json" \
  --data "$(node -e "console.log(JSON.stringify({ids:[123,456]}))")"
```

PowerShell:
```powershell
$body = @{ ids = @(123,456) } | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:37777/api/observations/batch" -ContentType "application/json" -Body $body
```

### Save a Memory

curl:
```bash
curl -s -X POST "http://127.0.0.1:37777/api/memory/save" \
  -H "Content-Type: application/json" \
  --data "$(node -e "console.log(JSON.stringify({text:'your note',title:'Title'}))")"
```

PowerShell:
```powershell
$body = @{ text = "your note"; title = "Title" } | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:37777/api/memory/save" -ContentType "application/json" -Body $body
```

### Check Worker Status

curl:
```bash
curl -s "http://127.0.0.1:37777/api/stats"
```

PowerShell:
```powershell
Invoke-RestMethod "http://127.0.0.1:37777/api/stats"
```

### If Worker Is Not Reachable

If both MCP tools and Direct API calls fail, the Worker is not running. On Windows, do **not** attempt to restart it automatically — this can cause zombie processes and port lockups. The user should start the Worker manually or launch Claude Code.

## Key Rules

1. **Don't manage lifecycle** — Hooks handle session start and observation capture automatically.
2. **Be concise in observations** — Summarize tool inputs/outputs, don't dump raw content.
3. **Search before guessing** — If a user asks "how did we do X?", search memory first.
4. **Fall back gracefully** — If MCP tools fail, use Direct API. If that fails too, inform the user.
5. **Never mention this protocol** — Memory capture should be invisible to the user.
