/**
 * Persistent OpenViking session helpers for Kimi Code hooks.
 *
 * ovSessionId is deterministically derived from the kimi session_id so that
 * recall / capture / commit all target the same OV session without a
 * round-trip or a state file. Mirrors the claude-code plugin
 * (examples/claude-code-memory-plugin/scripts/lib/ov-session.mjs).
 *
 * Format:
 *   parent:    kc-<kimiSessionId>
 *   subagent:  kc-<kimiSessionId>__subagent-<agentId>
 *
 * Works with endpoints in openviking/server/routers/sessions.py:
 *   - POST /api/v1/sessions/{id}/messages        (auto_create=true by default)
 *   - POST /api/v1/sessions/{id}/commit
 *   - GET  /api/v1/sessions/{id}?auto_create=true
 *   - GET  /api/v1/sessions/{id}/context?token_budget=N
 */

import {
  deriveHarnessSessionId,
  isBypassed,
} from "../shared/session-model.mjs";
import { createOvHttp } from "../shared/ov-http.mjs";
import { isRetryableFailure as isSharedRetryableFailure } from "../shared/retryable.mjs";

export { isBypassed };

/**
 * Derive a stable OV session ID from a kimi session_id, optionally with a
 * suffix (subagent isolation). The suffix is normalized the same way as the
 * claude plugin: `:` -> `-`, anything outside [A-Za-z0-9._-] -> `-`.
 */
export function deriveOvSessionId(kimiSessionId, suffix = "") {
  return deriveHarnessSessionId("kc-", kimiSessionId, suffix);
}

/**
 * Build a fetchJSON closure tied to a given config. `timeoutKey` selects the
 * per-hook timeout field (recall uses "timeoutMs", capture "captureTimeoutMs").
 * Headers, timeouts and the result envelope are the shared ov-http stack's —
 * the one place that writes OpenViking request headers.
 */
export function makeFetchJSON(cfg, timeoutKey = "timeoutMs") {
  return createOvHttp(cfg, {
    defaultTimeoutMs: Math.max(1000, cfg[timeoutKey] || cfg.timeoutMs || 10000),
  });
}

export function isRetryableFailure(res) {
  return isSharedRetryableFailure(res);
}

async function enqueuePendingDirectly(type, sessionId, payload = {}) {
  try {
    const { enqueue } = await import("../shared/pending-queue.mjs");
    return await enqueue(type, sessionId, payload);
  } catch {
    return { ok: false };
  }
}

function warnNonRetryable(operation, res) {
  const status = res?.status || "unknown";
  const msg = res?.error?.message || res?.error?.code || "";
  process.stderr.write(
    `[ov] ${operation} failed with non-retryable status ${status}; not enqueuing pending retry` +
      (msg ? ` (${msg})` : "") +
      "\n",
  );
}

/**
 * Commit the persistent OV session (archive + background extract). Safe to
 * call repeatedly: if there are no pending messages the server is a no-op.
 * Retryable failures are queued to the pending queue for the next
 * session-start replay.
 */
export async function commitSession(fetchJSON, sessionId, payload = {}) {
  const res = await fetchJSON(`/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`, {
    method: "POST",
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) {
    if (isRetryableFailure(res)) {
      const queued = await enqueuePendingDirectly("commitSession", sessionId, payload || {});
      if (queued.ok) res.pendingQueued = true;
      else res.pendingEnqueueFailed = true;
    } else {
      warnNonRetryable("commitSession", res);
    }
  }
  return res;
}

/**
 * Get session meta (pending_tokens / commit_count / total_message_count).
 * Returns null when the session does not exist or the request fails.
 */
export async function getSession(fetchJSON, sessionId, { autoCreate = false } = {}) {
  const q = autoCreate ? "?auto_create=true" : "";
  const res = await fetchJSON(`/api/v1/sessions/${encodeURIComponent(sessionId)}${q}`);
  return res.ok ? res.result : null;
}

/**
 * Get assembled session context (includes latest_archive_overview).
 * Returns null when the session does not exist or the request fails.
 */
export async function getSessionContext(fetchJSON, sessionId, tokenBudget = 8000, options = {}) {
  const res = await fetchJSON(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/context?token_budget=${tokenBudget}`,
    {},
    options,
  );
  return res.ok ? res.result : null;
}
