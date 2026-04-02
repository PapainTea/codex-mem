#!/usr/bin/env node
/**
 * claude-mem MCP Bridge for Codex CLI
 *
 * Uses official @modelcontextprotocol/sdk for reliable STDIO transport.
 * Bridges Codex CLI to claude-mem's Worker API (localhost:37777).
 * Shares the same memory database as Claude Code sessions.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { appendFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const LOG_FILE = join(homedir(), '.claude-mem', 'mcp-bridge.log');
function log(msg) {
  try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

log('MCP bridge starting...');

const WORKER_BASE = process.env.CLAUDE_MEM_WORKER_URL || 'http://127.0.0.1:37777';
const IS_WINDOWS = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Session State
// ---------------------------------------------------------------------------

let currentSessionId = null;
let currentProject = null;

function generateSessionId() {
  return `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function workerPost(path, body) {
  log(`POST ${path} body=${JSON.stringify(body).slice(0, 200)}`);
  try {
    const resp = await fetch(`${WORKER_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { error: `HTTP ${resp.status}: ${text}` };
    }
    const ct = resp.headers.get('content-type') || '';
    const result = ct.includes('json') ? await resp.json() : { text: await resp.text() };
    log(`POST ${path} response=${JSON.stringify(result).slice(0, 200)}`);
    return result;
  } catch (err) {
    log(`POST ${path} ERROR: ${err.message}`);
    if (IS_WINDOWS) {
      return {
        error:
          `Worker unavailable on Windows: ${err.message}. ` +
          `Automatic restart is disabled for safety. ` +
          `Use Direct API fallback if Worker is already running, or start Worker manually.`
      };
    }
    return { error: `Worker unreachable: ${err.message}. Is claude-mem worker running?` };
  }
}

async function workerGet(path, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const query = qs.toString();
  try {
    const resp = await fetch(`${WORKER_BASE}${path}${query ? '?' + query : ''}`);
    if (!resp.ok) {
      const text = await resp.text();
      return { error: `HTTP ${resp.status}: ${text}` };
    }
    const ct = resp.headers.get('content-type') || '';
    return ct.includes('json') ? await resp.json() : { text: await resp.text() };
  } catch (err) {
    if (IS_WINDOWS) {
      return {
        error:
          `Worker unavailable on Windows: ${err.message}. ` +
          `Automatic restart is disabled for safety. ` +
          `Use Direct API fallback if Worker is already running, or start Worker manually.`
      };
    }
    return { error: `Worker unreachable: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatSearchResults(data) {
  const parts = [];
  if (data.observations?.length) {
    parts.push('## Observations');
    for (const o of data.observations.slice(0, 10)) {
      parts.push(`- [#${o.id}] ${o.title || 'Untitled'} (${o.project || '?'}, ${o.created_at || ''})`);
      if (o.narrative) parts.push(`  ${o.narrative.slice(0, 200)}`);
    }
  }
  if (data.sessions?.length) {
    parts.push('## Sessions');
    for (const s of data.sessions.slice(0, 5)) {
      parts.push(`- [S${s.id}] ${s.title || 'Untitled'} (${s.project || '?'}, ${s.observation_count || 0} obs)`);
    }
  }
  if (data.prompts?.length) {
    parts.push('## Prompts');
    for (const p of data.prompts.slice(0, 5)) {
      parts.push(`- [P${p.id}] ${(p.prompt_text || '').slice(0, 100)}`);
    }
  }
  return parts.length ? parts.join('\n') : 'No results found.';
}

function formatTimeline(data) {
  if (!data.timeline?.length) return 'No timeline entries found.';
  return data.timeline.map((entry, i) => {
    const marker = i === data.anchorIndex ? ' >>>' : '    ';
    const prefix = entry.type === 'observation' ? `O#${entry.id}` : entry.type === 'session' ? `S#${entry.id}` : `P#${entry.id}`;
    return `${marker} [${prefix}] ${entry.title || 'Untitled'} (${entry.created_at || ''})`;
  }).join('\n');
}

// ---------------------------------------------------------------------------
// MCP Server Setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'claude-mem-bridge',
  version: '1.0.0',
});

// -- mem_session_start --
server.tool(
  'mem_session_start',
  'Start a new memory session. Call this at the beginning of every conversation.',
  { project: z.string().describe('Project path or name'), prompt: z.string().optional().describe('Initial user prompt') },
  async ({ project, prompt }) => {
    const newSessionId = generateSessionId();
    const result = await workerPost('/api/sessions/init', {
      contentSessionId: newSessionId,
      project,
      prompt: prompt || '',
    });
    if (result.error) {
      // Don't leave phantom session state on failed init
      return { content: [{ type: 'text', text: result.error }] };
    }
    currentSessionId = newSessionId;
    currentProject = project;
    return { content: [{ type: 'text', text: `Session started: ${currentSessionId}\nProject: ${currentProject}` }] };
  }
);

// -- mem_post_tool_use --
server.tool(
  'mem_post_tool_use',
  'Record a tool usage observation. Call after each significant tool call.',
  {
    tool_name: z.string().describe('Name of the tool'),
    tool_input: z.string().optional().describe('Brief summary of input'),
    tool_response: z.string().optional().describe('Brief summary of result'),
    cwd: z.string().optional().describe('Working directory'),
  },
  async ({ tool_name, tool_input, tool_response, cwd }) => {
    if (!currentSessionId) {
      const newSessionId = generateSessionId();
      const initResult = await workerPost('/api/sessions/init', {
        contentSessionId: newSessionId,
        project: cwd || 'unknown',
        prompt: '',
      });
      if (initResult.error) {
        return { content: [{ type: 'text', text: initResult.error }] };
      }
      currentSessionId = newSessionId;
      currentProject = cwd || 'unknown';
    }
    const result = await workerPost('/api/sessions/observations', {
      contentSessionId: currentSessionId,
      tool_name,
      tool_input: tool_input || '',
      tool_response: tool_response || '',
      cwd: cwd || '',
    });
    if (result.error) return { content: [{ type: 'text', text: result.error }] };
    return { content: [{ type: 'text', text: `Observation ${result.status || 'queued'}: ${tool_name}` }] };
  }
);

// -- mem_session_end --
server.tool(
  'mem_session_end',
  'End the current memory session and trigger a summary.',
  { last_assistant_message: z.string().optional().describe('Your final summary message') },
  async ({ last_assistant_message }) => {
    if (!currentSessionId) return { content: [{ type: 'text', text: 'No active session.' }] };
    await workerPost('/api/sessions/summarize', {
      contentSessionId: currentSessionId,
      last_assistant_message: last_assistant_message || '',
    });
    const result = await workerPost('/api/sessions/complete', { contentSessionId: currentSessionId });
    if (result.error) return { content: [{ type: 'text', text: result.error }] };
    // Only clear state after successful complete — allows retry on failure
    const sid = currentSessionId;
    currentSessionId = null;
    currentProject = null;
    return { content: [{ type: 'text', text: `Session ended: ${sid}\nSummary queued.` }] };
  }
);

// -- mem_search --
server.tool(
  'mem_search',
  'Search across all memories (observations, sessions, prompts).',
  {
    query: z.string().describe('Search query'),
    project: z.string().optional().describe('Filter by project'),
    limit: z.number().optional().describe('Max results (default: 20)'),
  },
  async ({ query, project, limit }) => {
    const result = await workerGet('/api/search', { query, project, limit: limit || 20 });
    if (result.error) return { content: [{ type: 'text', text: result.error }] };
    return { content: [{ type: 'text', text: formatSearchResults(result) }] };
  }
);

// -- mem_timeline --
server.tool(
  'mem_timeline',
  'Get a timeline of events around a specific observation or session.',
  {
    anchor: z.string().optional().describe('Observation ID, session ID (S123), or ISO timestamp'),
    query: z.string().optional().describe('Search first, then show timeline around best match'),
    depth_before: z.number().optional().describe('Records before anchor (default: 10)'),
    depth_after: z.number().optional().describe('Records after anchor (default: 10)'),
    project: z.string().optional().describe('Filter by project'),
  },
  async ({ anchor, query, depth_before, depth_after, project }) => {
    const result = await workerGet('/api/timeline', { anchor, query, depth_before: depth_before || 10, depth_after: depth_after || 10, project });
    if (result.error) return { content: [{ type: 'text', text: result.error }] };
    return { content: [{ type: 'text', text: formatTimeline(result) }] };
  }
);

// -- mem_get_observations --
server.tool(
  'mem_get_observations',
  'Get full details for specific observation IDs.',
  { ids: z.array(z.number()).describe('Array of observation IDs') },
  async ({ ids }) => {
    const result = await workerPost('/api/observations/batch', { ids });
    if (result.error) return { content: [{ type: 'text', text: result.error }] };
    const text = Array.isArray(result)
      ? result.map(o => `[#${o.id}] ${o.title || 'Untitled'}\n${o.narrative || o.text || ''}`).join('\n---\n')
      : JSON.stringify(result, null, 2);
    return { content: [{ type: 'text', text }] };
  }
);

// -- mem_save --
server.tool(
  'mem_save',
  'Manually save a memory/observation.',
  {
    text: z.string().describe('Observation text to save'),
    title: z.string().optional().describe('Optional title'),
    project: z.string().optional().describe('Project name'),
  },
  async ({ text, title, project }) => {
    const result = await workerPost('/api/memory/save', { text, title, project: project || currentProject });
    if (result.error) return { content: [{ type: 'text', text: result.error }] };
    return { content: [{ type: 'text', text: `Memory saved: #${result.id} - ${result.title || 'Untitled'}` }] };
  }
);

// -- mem_context --
server.tool(
  'mem_context',
  'Get recent memory context for a project.',
  { project: z.string().describe('Project name or path') },
  async ({ project }) => {
    const result = await workerGet('/api/context/inject', { projects: project });
    if (result.error) return { content: [{ type: 'text', text: result.error }] };
    return { content: [{ type: 'text', text: result.text || JSON.stringify(result) }] };
  }
);

// -- mem_stats --
server.tool(
  'mem_stats',
  'Get memory database statistics.',
  {},
  async () => {
    const result = await workerGet('/api/stats');
    if (result.error) return { content: [{ type: 'text', text: result.error }] };
    const w = result.worker || {};
    const d = result.database || {};
    return {
      content: [{
        type: 'text',
        text: [
          `Worker: v${w.version || '?'} | uptime: ${Math.floor((w.uptime || 0) / 60)}m | sessions: ${w.activeSessions || 0}`,
          `Database: ${d.observations || 0} observations | ${d.sessions || 0} sessions | ${d.summaries || 0} summaries`,
          `Size: ${((d.size || 0) / 1024 / 1024).toFixed(1)} MB`,
        ].join('\n'),
      }],
    };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

log('Connecting STDIO transport...');
const transport = new StdioServerTransport();
await server.connect(transport);
log('MCP bridge connected and ready.');
