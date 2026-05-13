# claude-mem Copilot CLI 集成 — Fork 改造文档

> Fork: `quinnmacro/claude-mem` ← `thedotmack/claude-mem` (v13.1.0)
>
> 最后更新: 2026-05-13
> 
> 当前版本: **v13.2.0** (已同步上游 `thedotmack/claude-mem` v13.2.0)

---

## 1. 概述

本 fork 为 claude-mem 添加了 **GitHub Copilot CLI** 的集成支持。原项目支持 Claude Code 和 Codex CLI，本 fork 新增了第三种平台适配。

### 集成路径

| 路径 | 状态 | 说明 |
|------|------|------|
| **Transcript Watcher** | ✅ 已上线 | Worker 守护进程自动监控 `~/.copilot/session-state/*/events.jsonl`，实时捕获会话事件并转为记忆 |
| **MCP Server** | ✅ 已生效 | Copilot CLI 可通过 `/mem-search` 等 MCP 工具查询 claude-mem 记忆库 |
| **Lifecycle Hooks** | ⏳ 待 Copilot CLI 支持 | `copilot-hooks.json` 已准备好，等 Copilot CLI 推出 hooks API 后自动生效 |

---

## 2. 改动清单

### 2.1 源码修改（3 个文件）

#### `src/cli/adapters/copilot.ts` — 新建

Copilot 平台适配器，对标 `codex.ts`，将 Copilot CLI 的 hook 输入转换为 claude-mem 的统一格式。

```
copilotAdapter
├── normalizeInput()   — 解析 Copilot CLI hook 输入，提取 sessionId/cwd/prompt/toolName 等
├── formatOutput()     — 将 hook 结果格式化为 Copilot CLI 可消费的输出
└── extractFilePaths() — 复用 codex-file-context.ts，自动提取文件路径注入 context
```

#### `src/cli/adapters/index.ts` — 修改

- 新增 `copilot` case：`case 'copilot': return copilotAdapter;`
- 新增导出：`copilotAdapter`

#### `src/shared/platform-source.ts` — 修改

- `normalizePlatformSource()` 新增 `copilot` 识别规则
- `sortPlatformSources()` 优先级数组新增 `'copilot'`，排序为 `claude > codex > copilot > cursor`

### 2.2 Transcript Schema — 修改

#### `src/services/transcripts/config.ts` — 修改

新增 `COPILOT_SAMPLE_SCHEMA`（v0.2），定义 6 种事件的匹配规则：

| 事件名 | Copilot CLI 原始 type | action | 提取字段 |
|--------|----------------------|--------|---------|
| session-start | `session.start` | `session_context` | sessionId, cwd |
| user-message | `user.message` | `session_init` | prompt |
| assistant-message | `assistant.message` | `assistant_message` | message |
| tool-execution-start | `tool.execution_start` | `tool_use` | toolId, toolName, toolInput |
| tool-execution-complete | `tool.execution_complete` | `tool_result` | toolId, toolResponse |
| session-end | `session.shutdown` | `session_end` | — |

新增 `copilot` watch 条目：`~/.copilot/session-state/*/events.jsonl`

### 2.3 运行时配置文件 — 修改

#### `transcript-watch.example.json` — 修改

添加 copilot schema（6 events）和 copilot watch 条目到示例配置。

#### `~/.claude-mem/transcript-watch.json` — 运行时修改

用户本地运行时配置，已添加 copilot schema + watch（由 `npm run build-and-sync` 部署）。

### 2.4 Copilot CLI 插件文件 — 新建

#### `plugin/.copilot-plugin/plugin.json`

Copilot CLI 插件清单，包含：
- 插件元信息（名称、版本、作者）
- `hooks` 指针 → `./hooks/copilot-hooks.json`
- `skills` 指针 → `./skills/`
- `mcpServers` 指针 → `./.mcp.json`
- `interface.longDescription` 提及 Copilot CLI
- `_note` 字段说明 hooks 暂未生效

#### `plugin/hooks/copilot-hooks.json`

预置 5 种生命周期 hook（与 claude-mem 标准 hooks 一致），全部使用：
- `hook copilot <event>` 子命令
- `CLAUDE_MEM_COPILOT_HOOK=1` 环境变量区分平台
- `_note` 字段说明 Copilot CLI 暂不支持 hooks

### 2.5 构建产物 — 修改

- `plugin/scripts/worker-service.cjs` — 编译进 copilot schema + adapter
- `plugin/scripts/mcp-server.cjs` — 编译进 copilot 支持
- `plugin/scripts/context-generator.cjs` — 编译进 copilot 支持

### 2.6 测试 — 新建

#### `tests/e2e-copilot-integration.test.js` — 103 项测试

覆盖：JSON 有效性、插件清单结构、hook 定义、平台源归一化、适配器分发、输入归一化、transcript schema 验证、watch 条目、跨文件一致性、模拟 JSONL 事件解析。

#### `tests/e2e-copilot-watcher.test.js` — 60 项测试

覆盖：构建产物验证、真实 `events.jsonl` 解析（3 个 session，74 个真实事件）、schema 匹配正确性、基础设施事件过滤、watcher 配置验证、Worker HTTP API 健康检查、跨文件一致性。

### 2.7 CHANGELOG — 自动更新

`CHANGELOG.md` 已自动续写，记录 v13.1.0 的 Copilot CLI 集成变更。

---

## 3. 架构说明

### 3.1 Copilot CLI 事件格式

Copilot CLI 将其 session 存储为 JSONL 文件，每行一个事件：

```jsonl
{"type":"session.start","data":{"sessionId":"...","context":{"cwd":"/project"}},"id":"...","timestamp":"...","parentId":null}
{"type":"user.message","data":{"content":"Add tests"},"id":"...","timestamp":"...","parentId":"..."}
{"type":"assistant.message","data":{"messageId":"...","content":"I'll add tests."},"id":"...","timestamp":"...","parentId":"..."}
{"type":"tool.execution_start","data":{"toolCallId":"call_1","toolName":"Bash","arguments":{...}},"id":"...","timestamp":"...","parentId":"..."}
{"type":"tool.execution_complete","data":{"toolCallId":"call_1","success":true,"result":{...}},"id":"...","timestamp":"...","parentId":"..."}
{"type":"session.shutdown","data":{"shutdownType":"routine"},"id":"...","timestamp":"...","parentId":"..."}
```

与 Codex CLI 的关键差异：
- Codex 用 `payload.xxx` 嵌套，Copilot 用 `data.xxx`
- Codex 事件类型用下划线（`session_meta`），Copilot 用点号（`session.start`）
- Copilot 有额外的内部事件（`session.model_change`、`assistant.turn_start/end`、`hook.start/end`），schema 正确过滤掉这些

### 3.2 Transcript Watcher 工作流程

```
Copilot CLI session 运行
  → 写入 ~/.copilot/session-state/<uuid>/events.jsonl
  → Worker 通过 chokidar 监控文件变化
  → 读取新增行，按 copilot schema 匹配事件
  → 匹配到的事件转为 observation 写入 SQLite
  → Chroma 生成向量嵌入
  → Web UI (localhost:37778) 可查看
```

Watcher 配置 `startAtEnd: true`，只处理新写入的事件，不会重复处理历史 session。

### 3.3 平台适配器分发

```typescript
// src/cli/adapters/index.ts
getPlatformAdapter('copilot') → copilotAdapter
```

```typescript
// src/shared/platform-source.ts
normalizePlatformSource('copilot')     → 'copilot'
normalizePlatformSource('github-copilot') → 'copilot'
normalizePlatformSource('COPILOT CLI') → 'copilot'
```

### 3.4 三种 CLI 集成对比

| 能力 | Claude Code | Codex CLI | Copilot CLI |
|------|-----------|-----------|-------------|
| Lifecycle Hooks | ✅ 完整支持 | ✅ 支持 | ❌ 不支持 |
| Transcript Watcher | N/A | ✅ JSONL 监控 | ✅ JSONL 监控 |
| MCP Server | ✅ (`/mem-search`) | ✅ | ✅ (已有配置) |
| Plugin Manifest | `.claude-plugin/` | N/A | `.copilot-plugin/` |
| Session 存储 | Claude 内部 | `~/.codex/sessions/` | `~/.copilot/session-state/` |

---

## 4. 测试验证

```bash
# 全部 163 项测试
node tests/e2e-copilot-integration.test.js   # 103 项
node tests/e2e-copilot-watcher.test.js       # 60 项
```

测试覆盖的真实数据：
- 3 个本机 Copilot CLI session（`~/.copilot/session-state/`）
- 99 个真实事件，62 个正确匹配语义事件，37 个基础设施事件正确过滤
- 6 种事件类型与 schema 一一对应验证
- Worker 运行状态（v13.2.0, PID, uptime）

---

## 5. 开机自启

Worker 进程通过 Windows 注册表 Run 键实现登录后自动启动。

### 注册表位置

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
  ClaudeMemWorker = cmd /c "..."node.exe" "...bun-runner.js" "...worker-service.cjs" start"
```

### 工作原理

1. 用户登录 → Windows 执行 Run 键中的命令
2. `bun-runner.js` 检测/安装 Bun 运行环境
3. `worker-service.cjs start` 启动 worker 守护进程
4. worker 检测到已有 PID 文件且进程存活时跳过（防重复启动）
5. worker 启动后 transcript watcher 自动开始监控 Copilot CLI sessions

### 管理命令

```powershell
# 查看启动项
Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "ClaudeMemWorker"

# 临时禁用
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "ClaudeMemWorker"

# 重新启用
$cmd = 'cmd /c ""C:\Program Files\nodejs\node.exe" "C:\Users\Q\.claude\plugins\marketplaces\thedotmack\plugin\scripts\bun-runner.js" "C:\Users\Q\.claude\plugins\marketplaces\thedotmack\plugin\scripts\worker-service.cjs" start"'
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "ClaudeMemWorker" -Value $cmd
```

### 手动启动/停止

```powershell
# 启动 worker
node "~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/bun-runner.js" "~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs" start

# 停止 worker
curl -X POST http://127.0.0.1:37778/api/admin/shutdown

# 查看 worker 状态
curl http://127.0.0.1:37778/api/health
```

---

## 6. 测试验证

```bash
# 全部 163 项测试
node tests/e2e-copilot-integration.test.js   # 103 项
node tests/e2e-copilot-watcher.test.js       # 60 项
```

## 7. 开发命令

```bash
npm run build          # 编译 TypeScript → CommonJS bundles
```

Windows 下没有 `rsync`，需手动部署：

```powershell
# 同步构建产物到 marketplace (稳定路径，开机自启用这个)
Copy-Item plugin/scripts/worker-service.cjs ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/ -Force
Copy-Item plugin/scripts/mcp-server.cjs ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/ -Force

# 同步到当前 cache 版本
Copy-Item plugin/scripts/worker-service.cjs ~/.claude/plugins/cache/thedotmack/claude-mem/13.2.0/scripts/ -Force
Copy-Item plugin/scripts/mcp-server.cjs ~/.claude/plugins/cache/thedotmack/claude-mem/13.2.0/scripts/ -Force

# 重启 worker
curl -X POST http://127.0.0.1:37778/api/admin/restart
```

---

## 8. Commit 历史

| Commit | 说明 |
|--------|------|
| `06fe58df` | feat: add GitHub Copilot CLI integration（adapter + schema + hooks + plugin manifest） |
| `5ff333e6` | test: add E2E tests for Copilot CLI integration, fix BOM in hooks JSON |
| `fe5786a5` | fix: update Copilot CLI schema to match real events.jsonl format |
| `ee536d14` | chore: deploy copilot adapter bundle, add `_note` fields, E2E watcher tests |
| `2374b4dc` | Merge upstream v13.2.0 into fork（wowerpoint skill, version bump） |
| `2cd294ae` | chore: rebuild bundles after upstream v13.2.0 merge |
| `59d96e01` | docs: update COPILOT_INTEGRATION.md |

共 7 个 commits，基于上游 `thedotmack/claude-mem` v13.1.0（`8bd19b5c`），已同步至 v13.2.0。

---

## 9. 同步上游更新

当 `thedotmack/claude-mem` 发布新版本时：

```bash
# 1. 添加上游 remote（仅首次）
git remote add upstream https://github.com/thedotmack/claude-mem.git

# 2. 拉取上游更新
git fetch upstream
git merge upstream/main

# 3. 解决冲突后重新 build 并测试
npm run build
node tests/e2e-copilot-integration.test.js
node tests/e2e-copilot-watcher.test.js

# 4. 推送到自己的 fork
git push origin main
```

---

## 10. 已知限制

1. **Copilot CLI 暂无 hooks API**。`copilot-hooks.json` 和 `.copilot-plugin/plugin.json` 中的 hooks 配置不会触发。当前实际生效的集成路径只有 transcript watcher + MCP server。

2. **Watcher 不回溯历史**。`startAtEnd: true` 意味着只捕获 watcher 启动后的新 session。如需导入历史 session，需要手动触发重新扫描。

3. **esbuild 会压缩代码**。验证 bundle 时用 `grep "copilotAdapter"` 可能找不到（变量名被 minify），应搜索 schema 中的字符串常量（如 `session.start`）。

4. **Windows 下需要手动同步**。`npm run sync-marketplace` 依赖 `rsync`，Windows 需要用 `robocopy` 或 `Copy-Item` 手动同步文件。