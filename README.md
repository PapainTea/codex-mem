# codex-mem

> Codex CLI 的跨会话持久记忆插件，基于 [claude-mem](https://github.com/thedotmack/claude-mem) Worker API，与 Claude Code 双向共享记忆。

<p align="center">
  <a href="README_EN.md"><img src="https://img.shields.io/badge/lang-English-blue" alt="English" /></a>
  &nbsp;
  <a href="https://linux.do"><img src="https://shorturl.at/ggSqS" height="20" alt="LINUX DO" /></a>
</p>

## 为什么需要这个

Codex CLI 的会话是无状态的 —— 每次开新对话，之前所有的上下文都丢了。codex-mem 解决这个问题：

- 自动记录你每个会话里做的每一件事
- 新会话开始时自动注入相关的历史上下文
- 随时搜索所有过去的工作记录

记忆存储在本地 `~/.claude-mem/claude-mem.db`（SQLite），与 **Claude Code 双向共享** —— Codex 里记录的内容在 Claude Code 里能搜到，反过来也一样。

## 功能一览

| 功能 | 实现方式 |
|------|---------|
| 自动记录工具调用 | PostToolUse hook 自动捕获每次工具执行 |
| 自动注入历史上下文 | SessionStart hook 在启动时加载相关记忆 |
| 记录用户 prompt | 每次回复前记录原始 prompt（保留原文语言） |
| 定期英文摘要 | 每 3-5 轮 prompt 生成英文总结，提升跨语言搜索命中率 |
| 跨平台搜索 | 9 个 MCP 工具 + curl / PowerShell 降级方案 |
| 跨工具记忆共享 | 与 Claude Code 的 claude-mem 共用同一个 SQLite 数据库 |
| Windows 安全冷启动 | 端口探测 + 单次启动 + 失败即停止 |
| 无需手动管理生命周期 | hooks 自动处理 session 初始化和观察记录 |

## 架构

```
Codex CLI
  ├─ SessionStart hook ─→ init session + inject past context
  ├─ PostToolUse hook  ─→ auto-capture every tool call
  ├─ Prompt recording  ─→ save raw prompts + English summaries
  └─ MCP bridge / curl ─→ search, save, query memory
         │
         ▼
  claude-mem Worker API (localhost:37777)
         │
         ▼
  ~/.claude-mem/claude-mem.db (SQLite, shared with Claude Code)
```

### 数据流

1. **会话开始** —— SessionStart hook 触发时：
   - 检测 Worker API 是否在运行（Windows 上会做端口绑定探测）
   - 如果需要，尝试一次冷启动（smart-install → bun-runner → worker-service）
   - 调用 `POST /api/sessions/init` 创建会话
   - 调用 `GET /api/context/inject` 获取相关历史记忆
   - 通过 `additional_context` JSON 输出注入到 Codex 上下文

2. **用户提问** —— 每次用户发送 prompt 时，模型会：
   - 在回复开头用 heredoc + node 将原始 prompt 记录为 observation（保留原文语言）
   - 每 3-5 轮 prompt 后额外生成一条英文摘要，提升跨语言搜索命中率

3. **工作过程中** —— 每次工具调用后，PostToolUse hook：
   - 从 stdin 读取工具执行数据
   - 调用 `POST /api/sessions/observations` 记录观察
   - 异步执行，不阻塞 Codex

4. **搜索 / 保存** —— 需要查找过去的工作时：
   - 模型使用 `mem_search` MCP 工具 → mcp-bridge.mjs → Worker API
   - 如果 MCP 被 Codex 审批设置拦截，降级使用 curl / PowerShell 直接调 API

## 前置条件

| 依赖 | 说明 |
|------|------|
| [Codex CLI](https://github.com/openai/codex) | 本插件扩展的宿主 CLI |
| [Claude Code](https://claude.ai/claude-code) + [claude-mem](https://github.com/thedotmack/claude-mem) | 提供 Worker API 和 SQLite 数据库 |
| Node.js >= 18 | 运行 MCP bridge 和 hook 辅助脚本 |
| Git Bash（仅 Windows） | hooks 是 bash 脚本；run-hook.cmd 会自动查找 Git Bash |

## 安装

### 1. 克隆仓库

```bash
git clone https://github.com/PapainTea/codex-mem.git
cd codex-mem
```

### 2. 安装依赖

```bash
npm install
```

### 3. 部署到 Codex 插件目录

Linux / macOS：
```bash
mkdir -p ~/.codex/.tmp/plugins/plugins/claude-mem
cp -r .codex-plugin hooks scripts skills package.json package-lock.json \
  ~/.codex/.tmp/plugins/plugins/claude-mem/
cd ~/.codex/.tmp/plugins/plugins/claude-mem && npm install --production
```

Windows（Git Bash）：
```bash
mkdir -p "$HOME/.codex/.tmp/plugins/plugins/claude-mem"
cp -r .codex-plugin hooks scripts skills package.json package-lock.json \
  "$HOME/.codex/.tmp/plugins/plugins/claude-mem/"
cd "$HOME/.codex/.tmp/plugins/plugins/claude-mem" && npm install --production
```

### 4. 注册 MCP 服务

```bash
codex mcp add claude-mem -- node "$HOME/.codex/.tmp/plugins/plugins/claude-mem/scripts/mcp-bridge.mjs"
```

### 5. 启用 hooks（实验性功能）

```bash
codex features enable codex_hooks
```

### 6. 验证

重启 Codex，启动时应该看到：
```
Loaded: 1 plugin · skills · hooks · 1 MCP server
```

## Windows 安全策略

在 Windows 上，Bun（claude-mem Worker 的运行时）存在已知的 TCP socket 泄漏问题：进程被杀后内核可能不释放端口，导致 `EADDRINUSE`，只有重启电脑才能恢复。

本插件实现了**失败即停止（fail-closed）**策略，避免雪上加霜：

| 场景 | 行为 |
|------|------|
| Worker 运行中且健康 | 直接使用 |
| Worker 未运行 + 端口空闲 | 尝试**一次**冷启动 |
| Worker 未运行 + 端口被占 | **什么都不做** —— 输出 `{}`，静默跳过 |
| 冷启动超时 | **什么都不做** —— 不重试，不循环 |
| MCP 工具失败 | 返回清晰错误信息，建议使用 Direct API 降级方案 |

端口探测使用 Node.js `net.createServer()` 测试端口是否真正可绑定，能检测到 `netstat` 可能遗漏的幽灵 socket。

## 搜索记忆

### 通过 MCP 工具（首选）

```
mem_search({ query: "认证中间件重构", limit: 20 })
mem_timeline({ query: "数据库迁移", depth_before: 10, depth_after: 10 })
mem_get_observations({ ids: [123, 456] })
```

### 通过 Direct API（MCP 被拦截时的降级方案）

curl（Git Bash）：
```bash
curl -s -G "http://127.0.0.1:37777/api/search" \
  --data-urlencode "query=认证中间件" \
  --data-urlencode "limit=20"
```

PowerShell：
```powershell
$q = [uri]::EscapeDataString("认证中间件")
Invoke-RestMethod "http://127.0.0.1:37777/api/search?query=$q&limit=20"
```

完整的 API 端点和示例见 [SKILL.md](skills/claude-mem/SKILL.md)。

## 文件结构

```
codex-mem/
├── .codex-plugin/
│   └── plugin.json           # 插件清单 —— 声明 hooks + skills
├── hooks/
│   ├── hooks.json            # Hook 定义（SessionStart + PostToolUse）
│   ├── session-start         # 初始化会话、冷启动 Worker、注入上下文
│   ├── post-tool-use         # 自动捕获工具调用观察记录
│   └── run-hook.cmd          # Windows polyglot wrapper（查找 Git Bash）
├── scripts/
│   ├── mcp-bridge.mjs        # MCP 服务 —— 9 个记忆工具，通过 stdio 通信
│   └── mcp-bridge.cmd        # Windows batch 启动器
├── skills/
│   └── claude-mem/
│       ├── SKILL.md          # 模型指令（prompt 记录、搜索、保存、降级方案）
│       └── agents/openai.yaml # MCP 工具声明
├── package.json              # 依赖（@modelcontextprotocol/sdk）
├── LICENSE                   # MIT
├── README.md                 # 本文件
└── README_EN.md              # English version
```

## MCP 工具参考

| 工具 | 描述 | 自动？ |
|------|------|--------|
| `mem_session_start` | 初始化记忆会话 | 是（hook） |
| `mem_post_tool_use` | 记录工具使用观察 | 是（hook） |
| `mem_session_end` | 结束会话，触发摘要生成 | 否（可选） |
| `mem_search` | 全文搜索所有记忆 | 否（手动） |
| `mem_timeline` | 查看某个事件前后的时间线 | 否（手动） |
| `mem_get_observations` | 按 ID 获取观察记录详情 | 否（手动） |
| `mem_save` | 手动保存笔记或决策 | 否（手动） |
| `mem_context` | 获取项目的近期上下文 | 否（手动） |
| `mem_stats` | 数据库统计（大小、数量、运行时间） | 否（手动） |

**自动？** = hooks 是否自动处理。标记"是"的工具仍然可以手动使用，但你不需要主动调用 —— hooks 会帮你做。

## 常见问题

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| MCP 工具返回 "Worker unavailable" | Worker API 没有运行 | 启动 Claude Code，或检查 `curl http://127.0.0.1:37777/api/readiness` |
| Hooks 不触发 | `codex_hooks` 功能未启用 | 执行 `codex features enable codex_hooks` |
| 会话启动卡住 | smart-install.js 正在下载 Bun/依赖 | 等待（仅首次，最长约 60 秒超时） |
| 端口 37777 被锁死 | Bun TCP socket 泄漏（Windows） | 重启电脑。不要尝试强制启动新的 Worker。 |
| mem_session_end 报 "No active session" | 之前的 init 失败了 | 检查 Worker 是否健康，先试 `mem_session_start` |
| 搜索没有结果 | 项目过滤条件错误或数据库为空 | 用 `mem_stats` 检查数据库是否有数据 |

## 已知限制

- **依赖 Worker** —— 需要 claude-mem Worker API 在 localhost:37777 运行。没有它，所有记忆操作会优雅失败但不会记录数据。
- **退出时无自动摘要** —— Codex 的 Stop hook 支持尚未验证；会话可能不会生成 AI 摘要。如需要请手动调用 `mem_session_end`。
- **PostToolUse 静默丢失** —— 如果 Worker 在会话中途崩溃，观察记录会静默丢失（不重试）。
- **Windows Bun socket 泄漏** —— 如果 Worker 进入僵死状态，只有重启电脑才能释放被锁定的端口。
- **codex_hooks 是实验性功能** —— hook 行为可能随 Codex 版本变化。

## 致谢

- [claude-mem](https://github.com/thedotmack/claude-mem) by Alex Newman —— Worker API 和记忆引擎
- [Codex CLI](https://github.com/openai/codex) by OpenAI —— 宿主 CLI
- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/sdk) —— MCP bridge 实现

## 许可证

[MIT](LICENSE)
