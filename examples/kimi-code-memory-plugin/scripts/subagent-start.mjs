#!/usr/bin/env node

/**
 * SubagentStart Hook for Kimi Code.
 *
 * Fires when the parent session spawns a subagent. Kimi's payload field names
 * for the agent identity are not documented; parse defensively across the
 * plausible snake_case/camelCase spellings (agent_id / agentId / agent_name /
 * agentName / agent_type / agentType).
 *
 * We derive an isolated OV session id for the subagent
 * (kc-<session_id>__subagent-<agent>) and persist a state record so
 * subagent-stop.mjs can replay the subagent's wire.jsonl into the correct
 * session even if the stop payload omits the agent identity. Subagent
 * lifecycle events are the only hooks kimi fires for subagents — regular
 * in-subagent UserPromptSubmit/Stop hooks do not reach us.
 *
 * Silent exit 0 always.
 */

import { isPluginEnabled, loadConfig } from "./config.mjs";
import { createLogger } from "./debug-log.mjs";
import { deriveOvSessionId, isBypassed } from "./lib/ov-session.mjs";
import { removeState, writeJsonState } from "./lib/state.mjs";
import { resolveEffectivePeerId } from "./shared/workspace-peer.mjs";

const SUBAGENT_STATE_PREFIX = "kc-subagent-";

main().catch(() => process.exit(0));

async function main() {
  try {
    if (isPluginEnabled()) await run();
  } catch { /* fail-open */ }
  process.exit(0);
}

async function run() {
  const cfg = loadConfig();
  const { log, logError } = createLogger("subagent-start");

  // Paired with subagent-stop.mjs (a write path): when capture is off the
  // stop hook will skip, so there's no point stashing start state either.
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
  const agentId = firstNonEmpty(
    input.agent_id,
    input.agentId,
    input.agent_name,
    input.agentName,
    input.agent_type,
    input.agentType,
  ) || "unknown";

  if (!sessionId) {
    log("skip", { reason: "no session_id" });
    return;
  }
  if (isBypassed(cfg, { sessionId, cwd })) {
    log("skip", { reason: "bypass_session_pattern" });
    return;
  }

  // Isolated ovSessionId: append the subagent id so the subagent has its own
  // OV session distinct from the parent (parent and subagent memories don't
  // mix, but stay visually linked by the shared kc-<session> stem).
  const ovSessionId = deriveOvSessionId(sessionId, `subagent:${agentId}`);
  const effectivePeer = resolveEffectivePeerId({ cfg, cwd });

  // One record per subagent id; a recycled id from an earlier run in the same
  // session is simply overwritten.
  removeState(subagentStateName(agentId));
  writeJsonState(subagentStateName(agentId), {
    parent_session_id: sessionId,
    agent_id: agentId,
    agent_type: typeof input.agent_type === "string" ? input.agent_type : "",
    ov_session_id: ovSessionId,
    peer_id: cfg.peerId || effectivePeer.peerId,
    peer_source: effectivePeer.source,
  });

  log("start", { agentId, ovSessionId, peerSource: effectivePeer.source });
}

function subagentStateName(agentId) {
  const safe = String(agentId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${SUBAGENT_STATE_PREFIX}${safe}.json`;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

export { subagentStateName };
