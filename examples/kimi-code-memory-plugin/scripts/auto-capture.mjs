#!/usr/bin/env node

/**
 * Auto-Capture Hook Script for Kimi Code (Stop hook, end of every turn).
 *
 * Kimi passes JSON on stdin (session_id, cwd; NO transcript_path). Transcripts
 * are resolved through ~/.kimi-code/session_index.jsonl → <sessionDir>/agents/
 * main/wire.jsonl (see lib/kimi-transcript.mjs). Missing/unreadable transcript
 * ⇒ capture no-ops, exit 0.
 *
 * Strategy (mirrors the codex/claude plugins):
 *   1. Derive one long-lived OV session id `kc-<kimi-session-id>`.
 *   2. Parse the wire transcript, keep ONLY user turns with
 *      origin.kind=="user" (injected reminders are origin.kind=="injection"
 *      and MUST be excluded) plus assistant turns (text + toolCalls).
 *   3. Append every sanitized turn since the last capture (per-session cursor
 *      state), then commit when pending tokens cross commitTokenThreshold.
 *
 * Stop is blockable in kimi: this hook must exit 0 with NO stdout — any
 * stdout text would be appended to the model context, and a non-zero exit
 * could block the turn. Every path below is silent.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isPluginEnabled, loadConfig } from "./config.mjs";
import { createLogger } from "./debug-log.mjs";
import { lookupSessionDir, parseSessionIndex, turnsFromWireContent } from "./lib/kimi-transcript.mjs";
import {
  commitSession,
  deriveOvSessionId,
  getSession,
  isBypassed,
  isRetryableFailure,
  makeFetchJSON,
} from "./lib/ov-session.mjs";
import { readJsonState, writeJsonState } from "./lib/state.mjs";
import { sanitize, stripInjectedBlocks } from "./lib/sanitize.mjs";
import { maybeDetach, readHookStdin } from "./shared/async-writer.mjs";
import { sendSessionMessages } from "./shared/batch-send.mjs";
import { resolveEffectivePeerId } from "./shared/workspace-peer.mjs";

const CURSOR_STATE_PREFIX = "kc-capture-";

main().catch(() => process.exit(0));

async function main() {
  // Every path exits 0 silently — never block, never inject from Stop.
  try {
    if (isPluginEnabled()) await run();
  } catch { /* fail-open */ }
  process.exit(0);
}

async function run() {
  const cfg = loadConfig();
  const { log, logError } = createLogger("auto-capture");
  const fetchJSON = makeFetchJSON(cfg, "captureTimeoutMs");

  if (!cfg.autoCapture) {
    log("skip", { stage: "init", reason: "autoCapture disabled" });
    return;
  }

  // Async write path: approve (silently) and return; worker continues below.
  if (await maybeDetach(cfg, { approve: silentApprove })) return;

  let input;
  try {
    input = JSON.parse(await readHookStdin());
  } catch {
    log("skip", { stage: "stdin_parse", reason: "invalid input" });
    return;
  }

  const sessionId = typeof input.session_id === "string" ? input.session_id.trim() : "";
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  if (!sessionId) {
    log("skip", { stage: "input_check", reason: "no session_id" });
    return;
  }
  if (isBypassed(cfg, { sessionId, cwd })) {
    log("skip", { reason: "bypass_session_pattern" });
    return;
  }

  const wirePath = resolveMainWirePath(cfg, sessionId);
  if (!wirePath || !existsSync(wirePath)) {
    log("skip", { stage: "transcript_resolve", reason: "wire.jsonl not found", sessionId });
    return;
  }

  let wireContent;
  try {
    wireContent = await readFile(wirePath, "utf-8");
  } catch (err) {
    logError("transcript_read", err);
    return;
  }

  // Sanitize + drop turns that carry no content after stripping injected
  // blocks (our own recall injections, kimi's system reminders).
  const allTurns = turnsFromWireContent(wireContent)
    .map((turn) => ({ ...turn, text: stripInjectedBlocks(turn.text).trim() }))
    .filter((turn) => turn.text)
    .map((turn) => ({ ...turn, text: truncate(turn.text, cfg.captureMaxLength) }));
  if (allTurns.length === 0) {
    log("skip", { stage: "transcript_parse", reason: "no capturable turns" });
    return;
  }

  const state = loadCaptureState(sessionId);

  // Post-compact shrink defense: if the wire shrank under our cursor (kimi
  // compaction may rewrite the transcript), reset so nothing is skipped.
  if (allTurns.length < state.capturedTurnCount) {
    log("transcript_shrink_detected", {
      cached: state.capturedTurnCount,
      observed: allTurns.length,
    });
    state.capturedTurnCount = 0;
  }

  const newTurns = allTurns.slice(state.capturedTurnCount);
  const captureTurns = cfg.captureAssistantTurns
    ? newTurns
    : newTurns.filter((turn) => turn.role === "user");
  log("transcript_parse", {
    sessionId,
    totalTurns: allTurns.length,
    previouslyCaptured: state.capturedTurnCount,
    newTurns: newTurns.length,
    captureTurns: captureTurns.length,
  });

  if (newTurns.length === 0) {
    log("skip", { stage: "incremental_check", reason: "no new turns" });
    return;
  }

  if (captureTurns.length === 0) {
    saveCaptureState(sessionId, { ...state, capturedTurnCount: allTurns.length });
    log("state_update", { capturedTurnCount: allTurns.length, reason: "assistant_only_increment" });
    return;
  }

  if (cfg.captureMode === "keyword" && !hasCaptureKeyword(captureTurns)) {
    log("skip", { stage: "capture_mode", reason: "keyword mode without capture trigger" });
    saveCaptureState(sessionId, { ...state, capturedTurnCount: allTurns.length });
    return;
  }

  const ovSessionId = deriveOvSessionId(sessionId);
  const effectivePeer = resolveEffectivePeerId({ cfg, cwd });
  const peerId = cfg.peerId || effectivePeer.peerId;

  const health = await fetchJSON("/health");
  if (!health.ok) {
    if (isRetryableFailure(health)) {
      const queued = await enqueueTurns(ovSessionId, captureTurns, peerId);
      log("push_turns", { ovSessionId, queued: queued.ok, failed: queued.failed, reason: "server_offline" });
      if (queued.ok > 0) {
        saveCaptureState(sessionId, { ...state, capturedTurnCount: allTurns.length });
      }
    } else {
      logError("health_check", `non-retryable status ${health.status || "unknown"}`);
    }
    return;
  }

  const sent = await appendTurns(fetchJSON, ovSessionId, captureTurns, peerId, {
    onSent: async (n) => {
      state.capturedTurnCount += n;
      saveCaptureState(sessionId, state);
    },
  });
  log("push_turns", { ovSessionId, sent, total: captureTurns.length });

  if (sent <= 0) {
    // Cursor not advanced — retry covers the whole increment next Stop.
    log("skip", { stage: "push", reason: "nothing sent; cursor retained" });
    return;
  }
  saveCaptureState(sessionId, { ...state, capturedTurnCount: allTurns.length });

  // Client-driven commit: OV's auto_commit_threshold is not consumed by
  // addMessage, so poll pending_tokens and commit past the threshold.
  await maybeCommitByThreshold(fetchJSON, cfg, log, ovSessionId);
}

function silentApprove() {
  /* Stop hooks must not write stdout — an empty write IS the approval. */
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n[truncated]`;
}

/**
 * Capture cursor: one JSON state file per kimi session under
 * ~/.openviking/state/.
 */
function cursorPath(sessionId) {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${CURSOR_STATE_PREFIX}${safe}.json`;
}

function loadCaptureState(sessionId) {
  const state = readJsonState(cursorPath(sessionId));
  return { capturedTurnCount: 0, ...(state && typeof state === "object" ? state : {}) };
}

function saveCaptureState(sessionId, state) {
  writeJsonState(cursorPath(sessionId), state);
}

/**
 * Resolve <sessionDir>/agents/main/wire.jsonl from session_index.jsonl.
 * Missing index / missing entry ⇒ null (capture no-ops).
 */
function resolveMainWirePath(cfg, sessionId) {
  try {
    const indexPath = join(cfg.kimiHome, "session_index.jsonl");
    if (!existsSync(indexPath)) return null;
    const indexContent = readFileSync(indexPath, "utf-8");
    const sessionDir = lookupSessionDir(parseSessionIndex(indexContent), sessionId);
    if (!sessionDir) return null;
    return join(sessionDir, "agents", "main", "wire.jsonl");
  } catch {
    return null;
  }
}

function buildPayloads(turns, peerId) {
  return turns.map((turn) => {
    const body = { role: turn.role, content: turn.text };
    if (peerId) body.peer_id = peerId;
    return body;
  });
}

async function appendTurns(fetchJSON, ovSessionId, turns, peerId, { onSent } = {}) {
  const res = await sendSessionMessages(fetchJSON, ovSessionId, buildPayloads(turns, peerId), { onSent });
  return res.sent;
}

async function enqueueTurns(ovSessionId, turns, peerId) {
  const { enqueue } = await import("../shared/pending-queue.mjs");
  let ok = 0;
  let failed = 0;
  for (const payload of buildPayloads(turns, peerId)) {
    const queued = await enqueue("addMessage", ovSessionId, payload);
    if (queued.ok) ok++;
    else failed++;
  }
  return { ok, failed };
}

async function maybeCommitByThreshold(fetchJSON, cfg, log, ovSessionId) {
  const meta = await getSession(fetchJSON, ovSessionId);
  const pendingTokens = Number(meta?.pending_tokens || 0);
  log("pending_tokens", {
    ovSessionId,
    pending: pendingTokens,
    threshold: cfg.commitTokenThreshold,
  });
  if (pendingTokens < cfg.commitTokenThreshold) return false;
  const res = await commitSession(fetchJSON, ovSessionId, {
    keep_recent_count: cfg.commitKeepRecentCount,
  });
  log("commit", {
    ovSessionId,
    ok: res.ok,
    trace_id: res.traceId || res.result?.trace_id || undefined,
    queued: Boolean(res.pendingQueued),
  });
  return res.ok;
}

function hasCaptureKeyword(turns) {
  return turns.some((turn) =>
    /\b(remember|memorize|store|save|capture|note|record)\b|记住|保存|记录|记忆/i.test(
      sanitize(turn.text),
    ));
}
