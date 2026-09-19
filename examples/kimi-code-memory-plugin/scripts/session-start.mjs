#!/usr/bin/env node

/**
 * SessionStart Hook for Kimi Code (matcher: startup|resume).
 *
 * Kimi's SessionStart stdout is NOT injected into the model context (only
 * UserPromptSubmit stdout is), so this hook does not inject anything itself.
 * Instead it stashes the session-start metadata under
 * ~/.openviking/state/kimi-session-start.json:
 *
 *   { source, session_id, ov_session_id, archive_overview?, ts }
 *
 * auto-recall.mjs picks the stash up on the session's first UserPromptSubmit
 * and merges a "[Session History Summary]" section into its recall block.
 *
 * On source=="resume" it also prefetches the OV session's
 * latest_archive_overview (10s timeout, best-effort) so the recall hook —
 * which runs under a 5s budget — never has to fetch it. Everything here is
 * best-effort: any failure means no summary on the next prompt, never a
 * failed hook.
 */

import { isPluginEnabled, loadConfig } from "./config.mjs";
import { createLogger } from "./debug-log.mjs";
import { writeJsonState } from "./lib/state.mjs";
import { deriveOvSessionId, getSessionContext, isBypassed, makeFetchJSON } from "./lib/ov-session.mjs";

const SESSION_START_STATE = "kimi-session-start.json";
const OVERVIEW_PREFETCH_TIMEOUT_MS = 10000;

main().catch(() => process.exit(0));

async function main() {
  try {
    if (isPluginEnabled()) await run();
  } catch { /* fail-open */ }
  process.exit(0);
}

async function run() {
  const cfg = loadConfig();
  const { log, logError } = createLogger("session-start");

  let input = {};
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch { /* best effort */ }

  const source = String(input.source || "startup");
  const sessionId = typeof input.session_id === "string" ? input.session_id.trim() : "";
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  log("start", { source, sessionId: sessionId || null });

  if (!sessionId) {
    log("skip", { reason: "no session_id" });
    return;
  }
  if (isBypassed(cfg, { sessionId, cwd })) {
    log("skip", { reason: "bypass_session_pattern" });
    return;
  }

  const ovSessionId = deriveOvSessionId(sessionId);
  const stash = { source, session_id: sessionId, ov_session_id: ovSessionId };
  writeJsonState(SESSION_START_STATE, stash);

  // Archive-overview prefetch — resume only, best-effort within 10s. A failed
  // or slow fetch simply leaves archive_overview empty; the next prompt gets
  // recall context only.
  if (source === "resume") {
    try {
      const fetchJSON = makeFetchJSON(cfg);
      const health = await fetchJSON("/health");
      if (health.ok) {
        const ctx = await getSessionContext(
          fetchJSON,
          ovSessionId,
          cfg.resumeOverviewTokenBudget,
          { timeoutMs: OVERVIEW_PREFETCH_TIMEOUT_MS },
        );
        const overview = String(ctx?.latest_archive_overview || "").trim();
        if (overview) {
          writeJsonState(SESSION_START_STATE, { ...stash, archive_overview: overview });
          log("overview_prefetch", { chars: overview.length });
        } else {
          log("overview_prefetch", { chars: 0 });
        }
      } else {
        logError("health_check", "server unreachable; skipping overview prefetch");
      }
    } catch (err) {
      logError("overview_prefetch", err);
    }
  }
}
