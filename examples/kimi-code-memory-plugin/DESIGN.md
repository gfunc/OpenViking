# Kimi Code memory plugin — design notes

Why the plugin is shaped the way it is. The commit surface (which OpenViking
session is appended by which hook) mirrors the claude-code and codex plugins;
this document records where Kimi Code differs and what that changes.

## Vocabulary

- **kimi `session_id`** — the kimi session id (`session_<uuid>`-shaped in
  current builds). Stable across resumes of the same session.
- **OV session** — `kc-<kimi-session-id>` for the main agent,
  `kc-<kimi-session-id>__subagent-<agent>` for subagents. Appended on every
  `Stop`, committed at PreCompact / SessionEnd / threshold / subagent end.
  `/messages` auto-creates the OV session, so the plugin never calls create.
- **wire.jsonl** — per-agent transcript under
  `<sessionDir>/agents/<agent>/wire.jsonl`. JSON-lines event log; only
  `context.append_message` records carry conversation turns.
- **session_index.jsonl** — `~/.kimi-code/session_index.jsonl`, one JSON
  object per line: `{ sessionId, sessionDir, workDir }`. This is how hook
  payloads (which carry no `transcript_path`) are mapped to transcripts.

## Kimi vs Claude Code hook surfaces

| Aspect | Claude Code | Kimi Code | Consequence |
|---|---|---|---|
| Hook registration | `hooks/hooks.json` in the plugin, `matcher` + `hooks[]` nesting | `[[hooks]]` tables in `~/.kimi-code/config.toml` with only `event`, `matcher`, `command`, `timeout` (1–600s) | Installer must TOML-merge and stays field-minimal |
| Injection channel | `{"decision":"approve","hookSpecificOutput":{"additionalContext":...}}` JSON on stdout | **plain stdout text** on `UserPromptSubmit` is appended verbatim | No JSON envelopes anywhere; recall emits the `<openviking-context>` block itself |
| Stop stdout | `{decision:"approve"}` + optional `systemMessage` | Stop is blockable; stdout text would be injected | Capture hooks print **nothing**, always |
| Transcript | `transcript_path` in the payload | **absent** (unconfirmed either way → assumed absent) | Resolve via `session_index.jsonl`; missing ⇒ capture no-ops |
| Transcript format | JSONL of message records | wire.jsonl event log (`context.append_message`, loop events, usage, …) | Dedicated parser (`lib/kimi-transcript.mjs`) |
| Injection marker in transcript | user messages carry `<system-reminder>` text | separate records with `origin.kind` (`injection`, `system_trigger`, `skill_activation`, `task`, …) | Filter on `origin.kind === "user"` instead of text matching |
| SessionStart injection | `additionalContext` on SessionStart stdout | SessionStart stdout is not injected | Resume summary is **stashed** at SessionStart and merged into the first UserPromptSubmit recall |
| PreCompact | fires before compaction; return value unused | fires with matcher `manual\|auto`; return value ignored | Same synchronous commit; the commit is the point |
| Subagent hooks | `SubagentStart`/`SubagentStop` with `agent_id`, `agent_transcript_path` | same event names; payload field names undocumented | Parse defensively (`agent_id`/`agentId`/`agent_name`/…); resolve transcript from `agents/agent-*` |
| Parallel hooks | same event hooks run sequentially | multiple hooks per event run in **parallel**; hook cwd = project dir | Never rely on hook ordering; state files are atomic (tmp + rename) |

## Data flow

```
SessionStart (startup|resume)
  └─ stash ~/.openviking/state/kimi-session-start.json
       {source, session_id, ov_session_id, archive_overview?}   (overview: resume only, 10s best-effort)

UserPromptSubmit
  └─ auto-recall.mjs (≤5s budget, internal 4.5s deadline)
       gates: enabled → bypass → minQueryLength(3) → /health
       recall: POST /api/v1/search/search mode=context
               → POST /api/v1/search/recall (legacy fallback)
               → raw find (last resort)          [shared recall-core]
       stash: first prompt after resume ⇒ consume stash,
              prepend "[Session History Summary]" inside the envelope
       out:   plain-text <openviking-context> … </openviking-context>
              (empty ⇒ empty stdout; any failure ⇒ exit 0 silent)

Stop
  └─ auto-capture.mjs (detached worker; silent)
       resolve wire.jsonl via session_index.jsonl
       turns = user(origin.kind=="user") + assistant(text + toolCalls)
       sanitize: strip <openviking-context>/<system-reminder>/
                 <relevant-memories>/[Subagent Context]
       incremental slice by per-session cursor; shrink defense
       POST /sessions/kc-<id>/messages (batch) → commit at pending_tokens ≥ 20k

PreCompact (manual|auto)  — SYNCHRONOUS commit (compaction follows the hook)
SessionEnd                — detached final commit, pending-queue on retryable failure
SubagentStart             — stash isolation state (kc-<id>__subagent-<agent>)
SubagentStop              — detached: capture agents/agent-*/wire.jsonl, push + commit
```

## Transcript mapping (wire.jsonl → turns)

Record shape:

```json
{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"..."}],"toolCalls":[],"origin":{"kind":"user"}},"time":1783472654768}
```

- `role` `user` is kept **only** when `message.origin.kind === "user"`.
  Observed non-user kinds (all dropped): `injection`, `system_trigger`,
  `skill_activation`, `task`, `background_task`, `shell_command`,
  `compaction_summary`. This is stricter and more reliable than the claude
  plugin's text-level `<system-reminder>` stripping — kimi isolates injected
  content into separate records — but both layers are applied (belt and
  suspenders): sanitize still strips injected wrappers from kept text.
- `role` `assistant` records carry no `origin`; `content` blocks of type
  `think` are dropped (reasoning traces), `text` blocks kept, and
  `toolCalls` (`{type:"function", id, name, arguments}`) are serialized as
  `[tool-call <name>] <arguments>` lines — a simplified version of how the
  codex capture serializes tool parts.
- `role` `tool` records (tool results) are dropped; the extractor's signal
  lives in the assistant's prose, mirroring the other plugins.
- `parseSessionIndex` / `lookupSessionDir` / `parseWireTranscript` /
  `extractTurns` are pure functions in `lib/kimi-transcript.mjs` and are
  unit-tested against fixtures.

## First-turn resume merge

Kimi's SessionStart stdout is not injected, so the archive overview cannot be
delivered the way claude does it. Instead:

1. `session-start.mjs` (10s budget) prefetches `latest_archive_overview` via
   `GET /api/v1/sessions/kc-<id>/context` and stashes it with the session id.
2. `auto-recall.mjs` on the next UserPromptSubmit reads the stash; if it
   belongs to this session and `source === "resume"`, the overview is inserted
   right after the `<openviking-context>` opening tag as
   `[Session History Summary]` — inside the recall envelope when recall
   produced a block, in a bare envelope otherwise. The stash is deleted
   before any network work so the merge is strictly one-shot.

The overview is consumed from the stash, not re-fetched inside the recall
hook, so the 5s recall budget never pays for the extra round-trip.

## Config pins

`recallQueryExpansion: "off"` must reach the wire as an explicit
`query_expansion: "off"`: `loadConfig` sets `recallQueryExpansionConfigured`
when the key is present in `plugin.kimi_code` (or env), and shared
`buildContextSearchBody` only emits `query_expansion` when that flag is true.
With expansion and rewrite both off, shared `contextRequestTimeoutMs` drops
both server fuses from the budget, so the plain retrieval runs inside the
3s `timeoutMs` with the hook deadline as the outer guard.

The harness key is passed to `loadPluginSettings` as the literal
`"kimi_code"`. (`HARNESS_KEYS` in the shared module lists loaders that
shipped before this plugin; adding a key there is a shared-file change this
plugin deliberately avoids — a literal key resolves identically.)

## Failure posture

- Recall: exit 0, empty stdout on every skip/error path; internal deadline
  exits the process rather than risking the hook timeout.
- Capture/commit: detached workers, silent exit 0; retryable failures enqueue
  to `~/.openviking/pending/` for the next SessionStart replay
  (session-start does not replay the pending queue in this plugin — the next
  claude/codex/ov session start, or a manual `ov` run, will; kept out of
  scope to stay inside kimi's 10s SessionStart budget).
- Cursor state (`kc-capture-<session>.json`) advances only after durable
  sends (onSent) or successful enqueues, so a crash never loses turns — it
  re-captures them instead.
