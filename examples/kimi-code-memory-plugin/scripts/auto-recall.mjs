#!/usr/bin/env node

/**
 * Auto-Recall Hook Script for Kimi Code (UserPromptSubmit).
 *
 * Kimi Code output contract (fail-open by design):
 *   - exit 0 with PLAIN stdout text → the text is appended to the model context
 *   - exit 0 with empty stdout      → nothing injected
 *   - exit 2 / crash / timeout      → kimi treats it as failure; every error
 *     path here exits 0 silently instead
 * Do NOT emit Claude-style JSON ({decision, hookSpecificOutput}) — kimi would
 * inject it as literal text.
 *
 * Flow: stdin payload (prompt via input.prompt ?? user_prompt ?? text, parsed
 * defensively) → bypass/short-query/health gates → server-assembled context
 * (POST /api/v1/search/search mode=context, /recall fallback, raw find
 * fallback) → <openviking-context> block on plain stdout.
 *
 * On the first prompt after a `resume` SessionStart, the archived session
 * overview stashed by session-start.mjs is merged into the block as a
 * "[Session History Summary]" section, and the stash is consumed (deleted).
 */

import { isPluginEnabled, loadConfig } from "./config.mjs";
import { createLogger } from "./debug-log.mjs";
import { readJsonState, removeState } from "./lib/state.mjs";
import { deriveOvSessionId, isBypassed, makeFetchJSON } from "./lib/ov-session.mjs";
import { resolveEffectivePeerId } from "./shared/workspace-peer.mjs";
import { buildRecallBlock } from "./shared/recall-core.mjs";

const SESSION_START_STATE = "kimi-session-start.json";

main().catch(() => process.exit(0));

async function main() {
  // Every exit path is exit code 0. Nothing may crash the prompt.
  try {
    if (isPluginEnabled()) await run();
  } catch { /* fail-open */ }
  process.exit(0);
}

async function run() {
  const cfg = loadConfig();
  const { log, logError } = createLogger("auto-recall");
  const fetchJSON = makeFetchJSON(cfg);
  const effectivePeer = resolveEffectivePeerId({ cfg, cwd: process.cwd() });

  // Hard deadline: never hold the prompt past the hook budget. On fire we
  // exit 0 immediately — nothing has been written to stdout yet.
  const timer = setTimeout(() => {
    logError("recall_timeout", `timed out after ${cfg.recallTimeoutMs}ms`);
    process.exit(0);
  }, cfg.recallTimeoutMs);
  timer.unref?.();

  if (!cfg.autoRecall) {
    log("skip", { stage: "init", reason: "autoRecall disabled" });
    return;
  }

  let input;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    log("skip", { stage: "stdin_parse", reason: "invalid input" });
    return;
  }

  // Kimi's UserPromptSubmit text field is assumed to be `prompt`; parse
  // defensively until the field name is confirmed on a live install.
  const userPrompt = String(
    input.prompt ?? input.user_prompt ?? input.text ?? "",
  ).trim();
  const sessionId = typeof input.session_id === "string" ? input.session_id.trim() : "";
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  log("start", {
    sessionId: sessionId || null,
    query: userPrompt.slice(0, 200),
    queryLength: userPrompt.length,
    config: {
      recallLimit: cfg.recallLimit,
      scoreThreshold: cfg.scoreThreshold,
      recallQueryExpansion: cfg.recallQueryExpansion,
      recallRewrite: cfg.recallRewrite,
      peerSource: effectivePeer.source,
    },
  });

  if (isBypassed(cfg, { sessionId, cwd })) {
    log("skip", { stage: "bypass", reason: "session pattern matched" });
    return;
  }

  if (!userPrompt || userPrompt.length < cfg.minQueryLength) {
    log("skip", { stage: "query_check", reason: "query too short or empty" });
    return;
  }

  const health = await fetchJSON("/health");
  if (!health.ok) {
    logError("health_check", "server unreachable or unhealthy");
    return;
  }

  // The OV session id unlocks server-side query expansion (off, but still
  // requested explicitly) and the cross-turn dedup ledger; it must match the
  // id auto-capture writes to.
  const ovSessionId = sessionId ? deriveOvSessionId(sessionId) : "";

  // Resume continuity: first prompt of a resumed session merges the archived
  // overview stashed by session-start.mjs, then consumes the stash.
  const resumeSummary = consumeResumeSummary({ sessionId, log });

  const block = await buildRecallBlock(fetchJSON, cfg, userPrompt, {
    actorPeerId: effectivePeer.peerId,
    sessionId: ovSessionId,
    log,
  });

  if (!block && !resumeSummary) {
    log("skip", { stage: "recall", reason: "no results" });
    return;
  }

  const merged = resumeSummary ? mergeIntoBlock(block, resumeSummary) : block;
  log("inject", {
    chars: merged.length,
    resumedSummary: Boolean(resumeSummary),
    recallBlock: Boolean(block),
  });
  // Plain stdout text — kimi appends it to the model context. Flush before
  // returning so main()'s process.exit(0) cannot truncate a queued pipe write.
  await new Promise((resolve) => process.stdout.write(merged + "\n", resolve));
}

/**
 * Read the session-start stash. Returns the formatted summary block or "".
 * The stash is consumed (deleted) whenever it belongs to this session, so the
 * merge happens at most once per resume.
 */
function consumeResumeSummary({ sessionId, log }) {
  if (!sessionId) return "";
  const stash = readJsonState(SESSION_START_STATE, { maxAgeMs: 24 * 60 * 60 * 1000 });
  if (!stash || stash.session_id !== sessionId) return "";
  // One-shot: delete first so a crash below can never replay stale context.
  removeState(SESSION_START_STATE);
  if (stash.source !== "resume") {
    log("resume_summary", { applied: false, reason: "source_not_resume" });
    return "";
  }
  const overview = String(stash.archive_overview || "").trim();
  if (!overview) {
    log("resume_summary", { applied: false, reason: "no_prefetched_overview" });
    return "";
  }
  log("resume_summary", { applied: true, chars: overview.length });
  return `[Session History Summary]\n${overview}`;
}

/**
 * Insert the summary right after the block's opening <openviking-context> tag
 * so it lands INSIDE the recall envelope. When recall produced no block, wrap
 * the summary in its own envelope.
 */
function mergeIntoBlock(block, summary) {
  const trimmedBlock = String(block || "").trim();
  if (!trimmedBlock) {
    return [`<openviking-context source="resume">`, summary, `</openviking-context>`].join("\n");
  }
  const newlineAt = trimmedBlock.indexOf("\n");
  if (newlineAt < 0) return `${summary}\n${trimmedBlock}`;
  return [
    trimmedBlock.slice(0, newlineAt + 1),
    summary,
    "",
    trimmedBlock.slice(newlineAt + 1),
  ].join("\n");
}
