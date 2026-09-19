/**
 * Shared structured debug logger for Kimi Code hook scripts.
 *
 * Activation: OPENVIKING_DEBUG=1 env var OR kimi_code.debug/plugin.debug: true.
 * Log path:   OPENVIKING_DEBUG_LOG env var OR ~/.openviking/logs/kimi-hooks.log.
 * Format:     JSON Lines — { ts, hook, stage, data } | { ts, hook, stage, error }.
 *
 * When inactive, log() and logError() are zero-cost no-ops.
 */

import { loadConfig } from "./config.mjs";
import { createLogger as createSharedLogger } from "./shared/debug-log.mjs";

let _cfg;
function cfg() {
  if (!_cfg) _cfg = loadConfig();
  return _cfg;
}

/**
 * @param {string} hookName — e.g. "auto-recall" or "auto-capture"
 * @param {{ debug?: boolean, debugLogPath?: string }} [overrideCfg]
 *        Pass a config object directly (avoids re-loading config in tests).
 */
export function createLogger(hookName, overrideCfg) {
  return createSharedLogger(hookName, overrideCfg || cfg());
}
