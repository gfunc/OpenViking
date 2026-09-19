# OpenViking 记忆插件：Kimi Code 版

基于 Hook 的 [OpenViking](https://github.com/volcengine/OpenViking) 长期记忆
集成，面向 [Kimi Code CLI](https://www.kimi.com/coding)。每个回合：

- **召回（Recall）**：每次提交 prompt 前，从你的 OpenViking 空间检索相关
  记忆/技能，以 `<openviking-context>` 文本块注入模型上下文（服务端组装）。
- **捕获（Capture）**：每回合结束后，把对话（用户 + 助手，含工具调用）追加
  到持久化的 OpenViking 会话 `kc-<session_id>`，由 OpenViking 归档并提炼为
  长期记忆。
- **续接（Resume）**：`SessionStart source=resume` 时预取历史归档概要，合并
  进本会话首个 prompt 的召回块（`[Session History Summary]`）。
- **子代理（Subagent）**：每个子代理的转写落到独立的
  `kc-<session_id>__subagent-<agent>` 会话。

零 npm 依赖；纯 Node（18+）ESM 脚本，复用
[`examples/memory-plugin-shared/lib/`](../memory-plugin-shared/)（由
`examples/memory-plugin-shared/sync.mjs` 同步到 `scripts/shared/`）。

## 安装

本地（仓库检出，推荐）：

```bash
bash examples/kimi-code-memory-plugin/setup-helper/install.sh
```

一行安装（GitHub）：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/volcengine/OpenViking/main/examples/kimi-code-memory-plugin/setup-helper/install.sh)
```

安装器幂等，会依次：

1. 将 `scripts/` 拷贝到 `~/.openviking/kimi-code-memory-plugin/scripts/`。
2. 先备份 `~/.kimi-code/config.toml` 为 `config.toml.YYYYmmdd-HHMMSS.bak`，
   再合并下述 [[hooks]] 条目（已存在的条目自动跳过）。
3. 将调优参数合并进 `~/.openviking/ovcli.conf` 的 `plugin.kimi_code`，
   保留已有的 `url` / `api_key`。
4. 不会改 `~/.kimi-code/mcp.json` —— Kimi Code 直接对接 OpenViking 的
   `/mcp` 端点；如需让代理主动读取/检索记忆，可自行注册一次
   （召回/捕获不依赖它）。

要求能访问 `~/.openviking/ovcli.conf` 中配置的 OpenViking 服务
（默认 `http://127.0.0.1:1933`）。

## Hook 一览

| 事件 | matcher | 脚本 | 超时 | 行为 |
|---|---|---|---|---|
| `SessionStart` | `startup\|resume` | `session-start.mjs` | 10s | 暂存 `{source, session_id, ov_session_id}`；resume 时预取归档概要（尽力而为，10s） |
| `UserPromptSubmit` | — | `auto-recall.mjs` | 5s | 健康检查 → 服务端组装上下文 → 以纯文本 `<openviking-context>` 输出（kimi 会将其追加进模型上下文）；resume 后首个 prompt 合并 `[Session History Summary]` |
| `Stop` | — | `auto-capture.mjs` | 45s | 分离进程：解析 `agents/main/wire.jsonl` → 清洗 → 追加新回合到 OV 会话 `kc-<id>` → 阈值提交。**始终以空 stdout 退出 0**（kimi 的 Stop 可被阻断） |
| `PreCompact` | `manual\|auto` | `pre-compact.mjs` | 30s | 同步提交，确保压缩前待处理消息先归档（kimi 忽略返回值——提交本身就是目的） |
| `SessionEnd` | — | `session-end.mjs` | 30s | 分离进程做最终提交（可重试失败进 pending 队列） |
| `SubagentStart` | — | `subagent-start.mjs` | 10s | 持久化 `{ov_session_id, peer_id}` 隔离状态 |
| `SubagentStop` | — | `subagent-stop.mjs` | 45s | 分离进程：捕获子代理 `agents/agent-*/wire.jsonl` 到其独立 OV 会话并提交 |

刻意**不**接入：`PostToolUse`（仅观测，stdout 不注入，claude-code 插件的
skill-experience 特性在 kimi 侧没有对应物）与 `SessionHeartbeat`（超出范围）。

## Fail-open 设计

kimi 对 hook 的退出码约定：0 = 放行，2 = 阻断，其余按事件处理。本插件绝不
冒这个险：

- `auto-recall.mjs` 在所有错误/跳过路径（服务不可达、stdin 非法、查询过短、
  会话命中 bypass、超时）下都以 **空 stdout 退出 0**。
- 捕获/提交类 hook 一律静默退出 0——Stop 的 stdout 会被注入上下文，因此
  什么都不打印。
- `OPENVIKING_DEBUG=1` 时，JSON 行调试日志写入
  `~/.openviking/logs/kimi-hooks.log`。

## 配置

优先级：环境变量 > `~/.openviking/ovcli.conf` 的 `plugin.kimi_code`
（或共享 `plugin.*`）> `~/.openviking/ov.conf` 的 `kimi_code.*` > 默认值。

连接字段（`url`、`api_key`、`account`、`user`）走共享凭据解析器
（环境变量 / `ovcli.conf`），与 claude-code、codex 插件一致。

安装器写入的固定参数（均可用环境变量覆盖）：

| 键 | 值 | 原因 |
|---|---|---|
| `recallQueryExpansion` | `"off"` | 跳过服务端查询扩展阶段，保证召回在 5s hook 预算内 |
| `recallCompress` | `"off"` | 不做摘要改写阶段（同上） |
| `recallContextTimeoutMs` | `3000` | 上述阶段重新启用时的客户端熔断 |
| `recallTokenBudget` | `2000` | 兜底注入预算 |
| `scoreThreshold` | `0.35` | 召回相关度下限 |
| `recallDedupTurns` | `5` | 跨回合去重窗口 |
| `minQueryLength` | `3` | 过短的 prompt 不召回 |
| `writePathAsync` | `true` | Stop/SessionEnd/SubagentStop 分离子进程，立即返回 |

常用环境变量：`OPENVIKING_URL`、`OPENVIKING_API_KEY`、`OPENVIKING_DEBUG`、
`OPENVIKING_AUTO_RECALL`、`OPENVIKING_AUTO_CAPTURE`、
`OPENVIKING_MEMORY_ENABLED`、`OPENVIKING_BYPASS_SESSION_PATTERNS`
（逗号分隔 glob，匹配 session id 与 cwd）、
`OPENVIKING_CAPTURE_ASSISTANT_TURNS`。完整清单见 `scripts/config.mjs`。

## 延迟说明

- kimi 的 hook 输出没有额外字段白名单：对 `UserPromptSubmit`，
  **任何** stdout 文本都会被追加进模型上下文。召回 hook 正是利用这一点
  （纯文本注入），因此必须把全部工作压进 hook `timeout`（5s）。内部另设
  4.5s 硬截止，服务端过慢则静默退出。
- 在上述固定参数下，热召回 = 一次 `/health` + 一次
  `POST /api/v1/search/search`（mode `context`）；服务端预算中同样剔除了
  扩展与改写熔断（`contextRequestTimeoutMs`）。
- 捕获类 hook 从不内联执行：`maybeDetach` 拉起分离 worker 后 hook 进程
  立即返回 kimi。唯一例外是 `PreCompact`（刻意同步，hook 返回后即开始压缩）。

## 状态与转写

- `~/.kimi-code/session_index.jsonl` 提供 session id → `sessionDir` 映射；
  主代理转写在 `<sessionDir>/agents/main/wire.jsonl`，子代理在
  `agents/agent-<n>/wire.jsonl`。hook 载荷中没有 `transcript_path`；
  转写缺失/不可读时捕获直接空操作（退出 0）。
- 插件状态位于 `~/.openviking/state/`：`kimi-session-start.json`
  （resume 概要暂存，一次性消费）、`kc-capture-<session>.json`（捕获游标）、
  `kc-subagent-<agent>.json`（子代理隔离）。
- pending 队列重试位于 `~/.openviking/pending/`，下次 session start 时回放。

## 卸载

从 `~/.kimi-code/config.toml` 删除 `command` 含
`kimi-code-memory-plugin` 的 `[[hooks]]` 块；随后按需删除
`~/.openviking/kimi-code-memory-plugin/` 与 `~/.openviking/ovcli.conf` 中
的 `plugin.kimi_code` 段。

## 测试

```bash
node --test examples/kimi-code-memory-plugin/tests/*.test.mjs
```

覆盖召回 stdout 契约（含负向用例：服务不可达、stdin 非法、查询过短、
bypass）、wire.jsonl 解析（排除 injection、跳过坏行）、清洗与配置解析。
