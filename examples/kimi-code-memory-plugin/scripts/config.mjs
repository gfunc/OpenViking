/**
 * Shared configuration loader for the Kimi Code OpenViking memory plugin.
 *
 * Resolution priority (highest → lowest):
 *   1. Environment variables (OPENVIKING_*)
 *   2. ovcli.conf plugin.kimi_code / plugin.* (client-side tuning, written by
 *      setup-helper/install.sh) — connection fields (url/api_key/account/user)
 *      come from the same file via the shared credentials resolver
 *   3. ov.conf kimi_code.* section — legacy; new deployments should prefer
 *      env vars or the ovcli.conf plugin block
 *   4. Built-in defaults (pins per examples/kimi-code-memory-plugin/README.md)
 *
 * The harness key is passed to loadPluginSettings as the literal "kimi_code".
 * (HARNESS_KEYS in the shared module only lists loaders that shipped before
 * this plugin; extending that map is a shared-file change this plugin avoids
 * on purpose — a literal key resolves identically.)
 *
 * Enable/disable:
 *   - OPENVIKING_MEMORY_ENABLED env var (0/false/no = off, 1/true/yes = on)
 *   - kimi_code.enabled field in ov.conf (false = off)
 *   - Fallback: enabled when ov.conf or ovcli.conf exists, disabled otherwise
 *
 * Connection / identity env vars:
 *   OPENVIKING_URL / OPENVIKING_BASE_URL, OPENVIKING_API_KEY / OPENVIKING_BEARER_TOKEN,
 *   OPENVIKING_ACCOUNT, OPENVIKING_USER, OPENVIKING_PEER_ID
 * Recall tuning:
 *   OPENVIKING_AUTO_RECALL, OPENVIKING_RECALL_LIMIT, OPENVIKING_SCORE_THRESHOLD,
 *   OPENVIKING_MIN_QUERY_LENGTH, OPENVIKING_RECALL_TOKEN_BUDGET,
 *   OPENVIKING_RECALL_MAX_CONTENT_CHARS, OPENVIKING_RECALL_DEDUP_TURNS,
 *   OPENVIKING_RECALL_QUERY_EXPANSION, OPENVIKING_RECALL_COMPRESS,
 *   OPENVIKING_RECALL_CONTEXT_TIMEOUT_MS, OPENVIKING_RECALL_TIMEOUT_MS,
 *   OPENVIKING_RECALL_PEER_SCOPE, OPENVIKING_RECALL_TARGET_TYPES, OPENVIKING_LOG_RANKING_DETAILS
 * Capture tuning:
 *   OPENVIKING_AUTO_CAPTURE, OPENVIKING_CAPTURE_MODE, OPENVIKING_CAPTURE_MAX_LENGTH,
 *   OPENVIKING_CAPTURE_ASSISTANT_TURNS, OPENVIKING_CAPTURE_TOOL_MAX_CHARS,
 *   OPENVIKING_COMMIT_TOKEN_THRESHOLD, OPENVIKING_COMMIT_KEEP_RECENT_COUNT
 * Lifecycle / behavior:
 *   OPENVIKING_TIMEOUT_MS, OPENVIKING_CAPTURE_TIMEOUT_MS, OPENVIKING_WRITE_PATH_ASYNC,
 *   OPENVIKING_BYPASS_SESSION, OPENVIKING_BYPASS_SESSION_PATTERNS (CSV),
 *   OPENVIKING_WORKSPACE_PEER
 * Resume summary (session-start stash → first UserPromptSubmit):
 *   OPENVIKING_RESUME_OVERVIEW_TOKEN_BUDGET
 * Misc:
 *   OPENVIKING_MEMORY_ENABLED, OPENVIKING_DEBUG, OPENVIKING_DEBUG_LOG,
 *   OPENVIKING_CONFIG_FILE, OPENVIKING_CLI_CONFIG_FILE, OPENVIKING_KIMI_HOME
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { buildUserAgent, readManifestVersion, resolveOpenVikingCredentials } from "./shared/credentials.mjs";
import { loadPluginSettings, normalizeRewriteMode } from "./shared/plugin-config.mjs";
import { normalizeRecallTargetTypes } from "./shared/recall-core.mjs";

const DEFAULT_OV_CONF_PATH = join(homedir(), ".openviking", "ov.conf");
const DEFAULT_OVCLI_CONF_PATH = join(homedir(), ".openviking", "ovcli.conf");
const USER_AGENT = buildUserAgent(
  "kimi-code",
  readManifestVersion(new URL("../package.json", import.meta.url)),
);

// kimi's UserPromptSubmit hook budget is 5s; keep every individual recall
// request strictly inside it.
const DEFAULT_RECALL_TIMEOUT_MS = 4500;

function num(val, fallback) {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string" && val.trim()) {
    const n = Number(val);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function str(val, fallback = "") {
  if (typeof val === "string" && val.trim()) return val.trim();
  return fallback;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function envBool(name) {
  const v = process.env[name];
  if (v == null || v === "") return undefined;
  const lower = v.trim().toLowerCase();
  if (lower === "0" || lower === "false" || lower === "no" || lower === "off") return false;
  if (lower === "1" || lower === "true" || lower === "yes" || lower === "on") return true;
  return undefined;
}

function tryLoadJsonFile(envVar, defaultPath) {
  const configPath = str(process.env[envVar], "") || defaultPath;
  if (!existsSync(configPath)) return null;
  try {
    return { configPath, file: JSON.parse(readFileSync(configPath, "utf-8")) };
  } catch {
    return null;
  }
}

/**
 * Whether the plugin should run at all.
 * Priority: OPENVIKING_MEMORY_ENABLED env > ov.conf kimi_code.enabled >
 * presence of any config file (same rule as the claude-code plugin).
 */
export function isPluginEnabled() {
  const envEnabled = envBool("OPENVIKING_MEMORY_ENABLED");
  if (envEnabled !== undefined) return envEnabled;

  const ovConf = tryLoadJsonFile("OPENVIKING_CONFIG_FILE", DEFAULT_OV_CONF_PATH);
  if (ovConf) {
    const kc = ovConf.file.kimi_code || {};
    if (kc.enabled === false) return false;
    return true;
  }

  if (existsSync(str(process.env.OPENVIKING_CLI_CONFIG_FILE, "") || DEFAULT_OVCLI_CONF_PATH)) {
    return true;
  }
  return false;
}

/**
 * Load the full plugin configuration.
 */
export function loadConfig() {
  const creds = resolveOpenVikingCredentials();
  const ovConf = tryLoadJsonFile("OPENVIKING_CONFIG_FILE", DEFAULT_OV_CONF_PATH);
  const ovFile = ovConf?.file || {};
  const server = ovFile.server || {};

  // ovcli.conf plugin.kimi_code overrides plugin.* which overrides ov.conf's
  // kimi_code section — client-side tuning never needs a server config edit.
  const pluginSettings = loadPluginSettings("kimi_code");
  const kc = { ...(ovFile.kimi_code || {}), ...pluginSettings };

  // bypassSessionPatterns: env CSV overrides config array entirely
  const envPatterns = str(process.env.OPENVIKING_BYPASS_SESSION_PATTERNS, null);
  const bypassSessionPatterns = envPatterns
    ? envPatterns.split(",").map((s) => s.trim()).filter(Boolean)
    : (Array.isArray(kc.bypassSessionPatterns)
        ? kc.bypassSessionPatterns.filter((p) => typeof p === "string" && p.trim())
        : []);

  const timeoutMs = Math.max(1000, Math.floor(num(
    process.env.OPENVIKING_TIMEOUT_MS,
    num(kc.timeoutMs, 3000),
  )));

  const debug = envBool("OPENVIKING_DEBUG") ?? (kc.debug === true);
  const defaultLogPath = join(homedir(), ".openviking", "logs", "kimi-hooks.log");

  return {
    configPath: creds.cliPath || ovConf?.configPath || null,
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    account: creds.account,
    user: creds.user,
    peerId: creds.peerId,
    workspacePeer: envBool("OPENVIKING_WORKSPACE_PEER") ?? (kc.workspacePeer !== false),
    userAgent: USER_AGENT,

    timeoutMs,
    captureTimeoutMs: Math.max(1000, Math.floor(num(
      process.env.OPENVIKING_CAPTURE_TIMEOUT_MS,
      num(kc.captureTimeoutMs, 30000),
    ))),

    // Recall
    autoRecall: envBool("OPENVIKING_AUTO_RECALL") ?? (kc.autoRecall !== false),
    recallTimeoutMs: Math.max(1000, Math.floor(num(
      process.env.OPENVIKING_RECALL_TIMEOUT_MS,
      num(kc.recallTimeoutMs, DEFAULT_RECALL_TIMEOUT_MS),
    ))),
    recallLimit: Math.max(1, Math.floor(num(
      process.env.OPENVIKING_RECALL_LIMIT,
      num(kc.recallLimit, 10),
    ))),
    recallLimitConfigured: Boolean(process.env.OPENVIKING_RECALL_LIMIT) ||
      hasOwn(kc, "recallLimit"),
    scoreThreshold: Math.min(1, Math.max(0, num(
      process.env.OPENVIKING_SCORE_THRESHOLD,
      num(kc.scoreThreshold, 0.35),
    ))),
    minQueryLength: Math.max(1, Math.floor(num(
      process.env.OPENVIKING_MIN_QUERY_LENGTH,
      num(kc.minQueryLength, 3),
    ))),
    recallTokenBudget: Math.max(200, Math.floor(num(
      process.env.OPENVIKING_RECALL_TOKEN_BUDGET,
      num(kc.recallTokenBudget, 2000),
    ))),
    recallMaxContentChars: Math.max(50, Math.floor(num(
      process.env.OPENVIKING_RECALL_MAX_CONTENT_CHARS,
      num(kc.recallMaxContentChars, 500),
    ))),
    logRankingDetails: envBool("OPENVIKING_LOG_RANKING_DETAILS") ?? (kc.logRankingDetails === true),
    recallPeerScope: str(
      process.env.OPENVIKING_RECALL_PEER_SCOPE,
      str(kc.recallPeerScope, "all"),
    ) === "actor" ? "actor" : "all",

    // Auto-recall target scoping (server `context_type`). Kimi defaults to
    // memory+skill: leaving `resources` in the mix lets boilerplate-heavy
    // imported corpora (scraped docs sites) crowd real memories out of every
    // injection. Resources stay fully searchable via the MCP ov_search tools.
    recallTargetTypes: normalizeRecallTargetTypes(
      process.env.OPENVIKING_RECALL_TARGET_TYPES ?? kc.recallTargetTypes,
    ) || ["memory", "skill"],

    // Server-side context assembly (/search mode="context"). Pinned for kimi:
    // expansion off + digest off keep the whole recall inside the 5s hook
    // budget (both fuses drop out of contextRequestTimeoutMs).
    recallQueryExpansion: str(
      process.env.OPENVIKING_RECALL_QUERY_EXPANSION,
      str(kc.recallQueryExpansion, "off"),
    ) === "off" ? "off" : "auto",
    recallQueryExpansionConfigured: Boolean(process.env.OPENVIKING_RECALL_QUERY_EXPANSION) ||
      hasOwn(kc, "recallQueryExpansion"),
    recallRewrite: normalizeRewriteMode(
      process.env.OPENVIKING_RECALL_COMPRESS
        ?? process.env.OPENVIKING_RECALL_REWRITE
        ?? kc.recallCompress
        ?? kc.recallRewrite,
      "off",
    ),
    recallContextTimeoutMs: Math.max(0, Math.floor(num(
      process.env.OPENVIKING_RECALL_CONTEXT_TIMEOUT_MS,
      num(kc.recallContextTimeoutMs, 3000),
    ))),
    recallDedupTurns: Math.max(0, Math.floor(num(
      process.env.OPENVIKING_RECALL_DEDUP_TURNS,
      num(kc.recallDedupTurns, 5),
    ))),
    recallMaxTokens: Math.max(64, Math.floor(num(
      process.env.OPENVIKING_RECALL_MAX_TOKENS,
      num(kc.recallMaxTokens, 1600),
    ))),
    recallMaxTokensConfigured: Boolean(process.env.OPENVIKING_RECALL_MAX_TOKENS) ||
      hasOwn(kc, "recallMaxTokens"),

    // Capture
    autoCapture: envBool("OPENVIKING_AUTO_CAPTURE") ?? (kc.autoCapture !== false),
    captureMode: (str(process.env.OPENVIKING_CAPTURE_MODE, str(kc.captureMode, "semantic")) === "keyword")
      ? "keyword"
      : "semantic",
    captureMaxLength: Math.max(200, Math.floor(num(
      process.env.OPENVIKING_CAPTURE_MAX_LENGTH,
      num(kc.captureMaxLength, 24000),
    ))),
    captureToolMaxChars: Math.max(200, Math.floor(num(
      process.env.OPENVIKING_CAPTURE_TOOL_MAX_CHARS,
      num(kc.captureToolMaxChars, 1000000),
    ))),
    // Default true: a memory plugin without assistant-side capture only sees
    // half the conversation (same rationale as the claude/codex plugins).
    captureAssistantTurns: envBool("OPENVIKING_CAPTURE_ASSISTANT_TURNS") ?? (kc.captureAssistantTurns !== false),
    commitTokenThreshold: Math.max(1000, Math.floor(num(
      process.env.OPENVIKING_COMMIT_TOKEN_THRESHOLD,
      num(kc.commitTokenThreshold, 20000),
    ))),
    commitKeepRecentCount: Math.max(0, Math.floor(num(
      process.env.OPENVIKING_COMMIT_KEEP_RECENT_COUNT,
      num(kc.commitKeepRecentCount, 10),
    ))),
    // Write-path hooks (auto-capture / session-end / subagent-stop) detach a
    // worker so the hook process returns to kimi instantly. pre-compact stays
    // synchronous regardless (compaction starts right after the hook).
    writePathAsync: envBool("OPENVIKING_WRITE_PATH_ASYNC") ?? (kc.writePathAsync !== false),

    // Resume summary: archive-overview prefetch budget for the session-start
    // stash, merged into the first UserPromptSubmit recall block.
    resumeOverviewTokenBudget: Math.max(512, Math.floor(num(
      process.env.OPENVIKING_RESUME_OVERVIEW_TOKEN_BUDGET,
      num(kc.resumeOverviewTokenBudget, 4000),
    ))),

    // Bypass: skip recall+capture entirely for matching session ids / cwds.
    bypassSessionPatterns,
    bypassSession: envBool("OPENVIKING_BYPASS_SESSION") ?? false,

    // Kimi home (transcript index root) — tests override this together with
    // OPENVIKING_HOME; production default is ~/.kimi-code.
    kimiHome: str(process.env.OPENVIKING_KIMI_HOME, "") || join(homedir(), ".kimi-code"),

    debug,
    debugLogPath: str(process.env.OPENVIKING_DEBUG_LOG, defaultLogPath),
  };
}
