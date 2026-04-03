# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in codex-mem, please report it responsibly:

1. **Do NOT open a public issue.**
2. Email the maintainer or use [GitHub Security Advisories](https://github.com/PapainTea/codex-mem/security/advisories/new).
3. Include a description of the vulnerability, steps to reproduce, and potential impact.

You should receive a response within 72 hours. If the vulnerability is confirmed, a fix will be prioritized and a patch release issued.

## Scope

This plugin runs locally and communicates only with `localhost:37777` (the claude-mem Worker API). It does not make external network requests. Memory data is stored in `~/.claude-mem/claude-mem.db` on your local filesystem.

### What this plugin does NOT do

- Does not send data to any remote server
- Does not store credentials (API keys are managed by claude-mem, not this plugin)
- Does not execute arbitrary code from the network
- Does not modify files outside the plugin directory and `~/.claude-mem/`
