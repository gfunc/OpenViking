#!/usr/bin/env node

/**
 * PreCompact Hook for Kimi Code (matcher: manual|auto).
 *
 * Fires before kimi rewrites the context via compaction. We commit the
 * persistent OV session SYNCHRONOUSLY so pending messages become an archive
 * before the transcript is mutated — kimi ignores the hook's return value
 * here, which is fine: the commit is the whole point.
 *
 * Silent exit 0 always; stdout from PreCompact is not injected but there is
 * no reason to produce any.
 */

import { isPluginEnabled, loadConfig } from "./config.mjs";
import { createLogger } from "./debug-log.mjs";
import { commitSession, deriveOvSessionId, isBypassed, makeFetchJSON } from "./lib/ov-session.mjs";

main().catch(() => process.exit(0));

async function main() {
  try {
    if (isPluginEnabled()) await run();
  } catch { /* fail-open */ }
  process.exit(0);
}

async function run() {
  const cfg = loadConfig();
  const { log, logError } = createLogger("pre-compact");
  const fetchJSON = makeFetchJSON(cfg);

  // Write-path hook: gated by autoCapture so that disabling capture also
  // disables the pending-message commits triggered here. Deliberately NOT
  // detached: compaction starts as soon as this hook returns.
  if (!cfg.autoCapture) {
    log("skip", { reason: "autoCapture disabled" });
    return;
  }

  let input = {};
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
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
  if (!health.ok) {
    logError("health_check", "server unreachable; commit skipped (capture cursor is preserved)");
    return;
  }

  const res = await commitSession(fetchJSON, ovSessionId);
  log("commit", {
    ovSessionId,
    ok: res.ok,
    trace_id: res.traceId || res.result?.trace_id,
    queued: Boolean(res.pendingQueued),
    error: res.ok ? undefined : res.error?.message,
  });
}
