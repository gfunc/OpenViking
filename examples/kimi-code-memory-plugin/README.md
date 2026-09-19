# OpenViking Memory Plugin for Kimi Code

Hook-based [OpenViking](https://github.com/volcengine/OpenViking) long-term
memory for the [Kimi Code CLI](https://www.kimi.com/coding). Every turn:

- **Recall** — before each prompt, relevant memories/skills from your OpenViking
  space are injected as an `<openviking-context>` block (server-assembled).
- **Capture** — after each turn, the conversation (user + assistant, tool calls
  included) is appended to a persistent OpenViking session `kc-<session_id>`,
  which OpenViking archives and distills into long-term memory.
- **Resume continuity** — on `SessionStart source=resume`, the archived session
  overview is prefetched and merged into the first prompt's recall block as a
  `[Session History Summary]`.
- **Subagents** — each subagent's transcript lands in its own
  `kc-<session_id>__subagent-<agent>` session.

Zero npm dependencies; plain Node (18+) ESM scripts that reuse
[`examples/memory-plugin-shared/lib/`](../memory-plugin-shared/) (synced into
`scripts/shared/` by `examples/memory-plugin-shared/sync.mjs`).

## Install

Local (repo checkout — recommended):

```bash
bash examples/kimi-code-memory-plugin/setup-helper/install.sh
```

One-liner (GitHub):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/volcengine/OpenViking/main/examples/kimi-code-memory-plugin/setup-helper/install.sh)
```

The installer is idempotent and will:

1. Copy `scripts/` to `~/.openviking/kimi-code-memory-plugin/scripts/`.
2. Back up `~/.kimi-code/config.toml` to `config.toml.YYYYmmdd-HHMMSS.bak`,
   then merge the [[hooks]] entries below (entries already present are skipped).
3. Merge tuning pins into `~/.openviking/ovcli.conf` under `plugin.kimi_code`,
   preserving your existing `url` / `api_key`.
4. NOT touch `~/.kimi-code/mcp.json` — Kimi Code talks to OpenViking's `/mcp`
   endpoint directly; register it once yourself if you want the agent to be
   able to actively read/search memories (not required for recall/capture).

Requires an OpenViking server reachable at the URL configured in
`~/.openviking/ovcli.conf` (default `http://127.0.0.1:1933`).

## Hooks wired

| Event | Matcher | Script | Timeout | What it does |
|---|---|---|---|---|
| `SessionStart` | `startup\|resume` | `session-start.mjs` | 10s | Stash `{source, session_id, ov_session_id}`; on resume prefetch the archived overview (best-effort, 10s) |
| `UserPromptSubmit` | — | `auto-recall.mjs` | 5s | Health gate → server-assembled context → plain-text `<openviking-context>` on stdout (kimi appends it to the model context); merges `[Session History Summary]` on first prompt after resume |
| `Stop` | — | `auto-capture.mjs` | 45s | Detached: parse `agents/main/wire.jsonl` → sanitize → append new turns to OV session `kc-<id>` → threshold commit. **Always exits 0 with empty stdout** (Stop is blockable in kimi) |
| `PreCompact` | `manual\|auto` | `pre-compact.mjs` | 30s | Synchronous commit so pending messages archive before compaction (return value ignored by kimi — the commit is the point) |
| `SessionEnd` | — | `session-end.mjs` | 30s | Detached final commit (retryable failures go to the pending queue) |
| `SubagentStart` | — | `subagent-start.mjs` | 10s | Persist `{ov_session_id, peer_id}` isolation state |
| `SubagentStop` | — | `subagent-stop.mjs` | 45s | Detached: capture the subagent's `agents/agent-*/wire.jsonl` into its own OV session and commit |

Deliberately **not** wired: `PostToolUse` (observation-only; its stdout is not
injected, so the claude-code plugin's skill-experience feature has no kimi
equivalent) and `SessionHeartbeat` (out of scope).

## Fail-open behavior

Kimi treats hook exit code 2 as "block" and other failures per-event; this
plugin never risks that:

- `auto-recall.mjs` exits 0 with **empty stdout** on every error/skip path
  (server down, malformed stdin, short query, bypassed session, timeout).
- Capture/commit hooks exit 0 silently; nothing they print could block a turn
  or leak into context (Stop stdout would be injected, so they print nothing).
- Debug tracing (JSON lines) goes to `~/.openviking/logs/kimi-hooks.log` when
  `OPENVIKING_DEBUG=1`.

## Configuration

Resolution: env var > `~/.openviking/ovcli.conf` `plugin.kimi_code` (or shared
`plugin.*`) > `~/.openviking/ov.conf` `kimi_code.*` > defaults.

Connection (`url`, `api_key`, `account`, `user`) comes from the shared
credentials resolver (env vars / `ovcli.conf`), the same one claude-code and
codex plugins use.

Pins written by the installer (all env-overridable):

| Key | Value | Why |
|---|---|---|
| `recallQueryExpansion` | `"off"` | Skip the server's query-expansion stage; keeps recall inside the 5s hook budget |
| `recallCompress` | `"off"` | No digest rewrite stage (same reason) |
| `recallContextTimeoutMs` | `3000` | Client-side fuse when those stages are re-enabled |
| `recallTokenBudget` | `2000` | Fallback injection budget |
| `scoreThreshold` | `0.35` | Recall relevance floor |
| `recallDedupTurns` | `5` | Cross-turn dedup window |
| `minQueryLength` | `3` | Skip recall for trivial prompts |
| `writePathAsync` | `true` | Stop/SessionEnd/SubagentStop detach a worker and return instantly |
| `recallTargetTypes` | `["memory","skill"]` | Auto-recall scopes to memories+skills (server `context_type`); `resources` in the mix let boilerplate-heavy imported corpora crowd out real memories. Override with `OPENVIKING_RECALL_TARGET_TYPES=memory,resource,skill`; deliberate resource lookups go through the MCP `ov_search` tools |

Common env vars: `OPENVIKING_URL`, `OPENVIKING_API_KEY`, `OPENVIKING_DEBUG`,
`OPENVIKING_AUTO_RECALL`, `OPENVIKING_AUTO_CAPTURE`, `OPENVIKING_MEMORY_ENABLED`,
`OPENVIKING_BYPASS_SESSION_PATTERNS` (CSV globs matched against session id and
cwd), `OPENVIKING_CAPTURE_ASSISTANT_TURNS`. See `scripts/config.mjs` for the
full list.

## Latency notes

- The kimi hook schema has no allow-list of extra output fields: for
  `UserPromptSubmit`, **any** stdout text is appended to the model context.
  The recall hook exploits that (plain-text injection) but must therefore keep
  its whole body under the hook `timeout` (5s). Internally it enforces a 4.5s
  deadline and exits silently if the server is slower.
- With the pins above, a warm recall is one `/health` + one
  `POST /api/v1/search/search` (mode `context`) round-trip; expansion and
  rewrite fuses are dropped from the server-side budget as well
  (`contextRequestTimeoutMs`).
- Capture hooks never run inline: `maybeDetach` spawns a detached worker and
  the hook process returns to kimi immediately. `PreCompact` is the one
  deliberate exception (synchronous, compaction follows the hook).

## State and transcripts

- `~/.kimi-code/session_index.jsonl` → `sessionDir` per session id; the main
  agent's transcript is `<sessionDir>/agents/main/wire.jsonl`, subagents live
  in `agents/agent-<n>/wire.jsonl`. There is no `transcript_path` in the hook
  payload; a missing/unreadable transcript makes capture no-op (exit 0).
- Plugin state lives under `~/.openviking/state/`: `kimi-session-start.json`
  (resume-summary stash, consumed once), `kc-capture-<session>.json` (capture
  cursor), `kc-subagent-<agent>.json` (subagent isolation).
- Pending-queue retries live under `~/.openviking/pending/` and are replayed
  on the next session start.

## Uninstall

Remove the `[[hooks]]` blocks whose `command` contains
`kimi-code-memory-plugin` from `~/.kimi-code/config.toml`, then delete
`~/.openviking/kimi-code-memory-plugin/` and the `plugin.kimi_code` section of
`~/.openviking/ovcli.conf` if desired.

## Tests

```bash
node --test examples/kimi-code-memory-plugin/tests/*.test.mjs
```

Covers the recall stdout contract (including negative controls: server down,
malformed stdin, short query, bypass), the wire.jsonl parser (injection
exclusion, malformed lines), sanitize, and config resolution.
