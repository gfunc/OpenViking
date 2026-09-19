#!/usr/bin/env node

/**
 * SessionEnd Hook for Kimi Code.
 *
 * Fires when the kimi session closes. We commit the persistent OV session so
 * the final turns' pending messages become an archive — without this hook
 * they would linger until the next Stop/PreCompact on a resumed session.
 *
 * Write-path hook: runs via maybeDetach so the CLI exits promptly, and honors
 * OPENVIKING_WRITE_PATH_ASYNC. Silent exit 0 always.
 */

import { isPluginEnabled, loadConfig } from "./config.mjs";
import { createLogger } from "./debug-log.mjs";
import {
  commitSession,
  deriveOvSessionId,
  isBypassed,
  isRetryableFailure,
  makeFetchJSON,
} from "./lib/ov-session.mjs";
import { maybeDetach, readHookStdin } from "./shared/async-writer.mjs";

main().catch(() => process.exit(0));

async function main() {
  try {
    if (isPluginEnabled()) await run();
  } catch { /* fail-open */ }
  process.exit(0);
}

async function run() {
  const cfg = loadConfig();
  const { log, logError } = createLogger("session-end");
  const fetchJSON = makeFetchJSON(cfg);

  // Write-path hook: gated by autoCapture so that disabling capture also
  // disables the final-commit triggered here.
  if (!cfg.autoCapture) {
    log("skip", { reason: "autoCapture disabled" });
    return;
  }

  if (await maybeDetach(cfg, () => {})) return;

  let input = {};
  try {
    input = JSON.parse((await readHookStdin()) || "{}");
  } catch { /* best effort */ }

  const sessionId = typeof input.session_id === "string" ? input.session_id.trim() : "";
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  if (!sessionId) {
    log("skip", { reason: "no session_id" });
    return;
  }
  if (isBypassed(cfg, { sessionId, cwd })) {
    log("skip", { reason: "bypass_session_pattern" });
    return;
  }

  const ovSessionId = deriveOvSessionId(sessionId);
  const health = await fetchJSON("/health");
  if (!health.ok && isRetryableFailure(health)) {
    const { enqueue } = await import("../shared/pending-queue.mjs");
    const queued = await enqueue("commitSession", ovSessionId, {});
    log("commit", { ovSessionId, ok: false, queued: queued.ok, reason: "health_retryable" });
    return;
  }
  if (!health.ok) {
    logError("health_check", `non-retryable status ${health.status || "unknown"}`);
    return;
  }

  const res = await commitSession(fetchJSON, ovSessionId);
  log("commit", {
    ovSessionId,
    ok: res.ok,
    trace_id: res.traceId || res.result?.trace_id,
    queued: Boolean(res.pendingQueued),
    enqueueFailed: Boolean(res.pendingEnqueueFailed),
    error: res.ok ? undefined : res.error?.message,
  });
}
