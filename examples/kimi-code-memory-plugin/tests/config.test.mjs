import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveOvSessionId } from "../scripts/lib/ov-session.mjs";
import { loadConfig } from "../scripts/config.mjs";

/**
 * loadConfig reads process.env + on-disk config files. Each case gets a clean
 * OPENVIKING_* env and its own ovcli.conf fixture so the resolution chain
 * (env > ovcli plugin.kimi_code > defaults) is exercised deterministically.
 */
async function withSandbox(fixture, env, fn) {
  const sandbox = await mkdtemp(join(tmpdir(), "ov-kimi-config-"));
  const ovcliPath = join(sandbox, "ovcli.conf");
  if (fixture) {
    await writeFile(ovcliPath, JSON.stringify(fixture));
  }
  const cleanEnv = { ...process.env };
  for (const key of Object.keys(cleanEnv)) {
    if (key.startsWith("OPENVIKING_")) delete cleanEnv[key];
  }
  Object.assign(process.env, {
    OPENVIKING_CONFIG_FILE: join(sandbox, "missing-ov.conf"),
    OPENVIKING_CLI_CONFIG_FILE: fixture ? ovcliPath : join(sandbox, "missing-ovcli.conf"),
  }, env);
  try {
    return await fn(sandbox);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("OPENVIKING_") && !(key in cleanEnv)) delete process.env[key];
    }
    Object.assign(process.env, cleanEnv);
    await rm(sandbox, { recursive: true, force: true });
  }
}

const INSTALLER_PINS_FIXTURE = {
  url: "http://127.0.0.1:19999",
  api_key: "fixture-key",
  account: "acct-1",
  plugin: {
    kimi_code: {
      recallQueryExpansion: "off",
      recallCompress: "off",
      recallContextTimeoutMs: 3000,
      recallTokenBudget: 2000,
      scoreThreshold: 0.35,
      recallDedupTurns: 5,
      minQueryLength: 3,
      writePathAsync: true,
      recallTargetTypes: ["memory", "skill"],
    },
  },
};

test("config: installer-written plugin.kimi_code pins resolve (off-explicit path)", async () => {
  await withSandbox(INSTALLER_PINS_FIXTURE, {}, () => {
    const cfg = loadConfig();
    assert.equal(cfg.baseUrl, "http://127.0.0.1:19999");
    assert.equal(cfg.apiKey, "fixture-key");
    assert.equal(cfg.account, "acct-1");
    // The pin is honored AND flagged as configured — required so shared
    // buildContextSearchBody emits query_expansion:"off" on the wire.
    assert.equal(cfg.recallQueryExpansion, "off");
    assert.equal(cfg.recallQueryExpansionConfigured, true);
    assert.equal(cfg.recallRewrite, "off");
    assert.equal(cfg.recallContextTimeoutMs, 3000);
    assert.equal(cfg.recallTokenBudget, 2000);
    assert.equal(cfg.scoreThreshold, 0.35);
    assert.equal(cfg.recallDedupTurns, 5);
    assert.equal(cfg.minQueryLength, 3);
    assert.equal(cfg.writePathAsync, true);
  });
});

test("config: without any pin the default is off but NOT configured (server default applies)", async () => {
  await withSandbox(null, {}, () => {
    const cfg = loadConfig();
    assert.equal(cfg.recallQueryExpansion, "off");
    assert.equal(cfg.recallQueryExpansionConfigured, false);
  });
});

test("config: recallTargetTypes defaults to memory+skill; env and ovcli override", async () => {
  // Installer fixture carries the pin.
  await withSandbox(INSTALLER_PINS_FIXTURE, {}, () => {
    const cfg = loadConfig();
    assert.deepEqual(cfg.recallTargetTypes, ["memory", "skill"]);
  });
  // Env wins over the pin.
  await withSandbox(INSTALLER_PINS_FIXTURE, {
    OPENVIKING_RECALL_TARGET_TYPES: "memory, resource, skill",
  }, () => {
    const cfg = loadConfig();
    assert.deepEqual(cfg.recallTargetTypes, ["memory", "resource", "skill"]);
  });
  // No pin anywhere: kimi's own default still scopes out resources.
  await withSandbox(null, {}, () => {
    const cfg = loadConfig();
    assert.deepEqual(cfg.recallTargetTypes, ["memory", "skill"]);
  });
});

test("config: env overrides win over plugin.kimi_code", async () => {
  await withSandbox(INSTALLER_PINS_FIXTURE, {
    OPENVIKING_RECALL_TOKEN_BUDGET: "7777",
    OPENVIKING_SCORE_THRESHOLD: "0.5",
    OPENVIKING_RECALL_QUERY_EXPANSION: "auto",
    OPENVIKING_MIN_QUERY_LENGTH: "7",
    OPENVIKING_URL: "http://127.0.0.1:18888",
    OPENVIKING_AUTO_CAPTURE: "0",
  }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.recallTokenBudget, 7777);
    assert.equal(cfg.scoreThreshold, 0.5);
    assert.equal(cfg.minQueryLength, 7);
    assert.equal(cfg.autoCapture, false);
    assert.equal(cfg.baseUrl, "http://127.0.0.1:18888");
    // env turns expansion on AND counts as configured.
    assert.equal(cfg.recallQueryExpansion, "auto");
    assert.equal(cfg.recallQueryExpansionConfigured, true);
  });
});

test("config: shared plugin.* keys apply when no kimi_code override exists", async () => {
  await withSandbox({
    url: "http://127.0.0.1:1933",
    plugin: {
      recallTokenBudget: 1234,
      kimi_code: { recallTokenBudget: 4242 },
    },
  }, {}, () => {
    const cfg = loadConfig();
    // Scoped kimi_code entry wins over the shared block.
    assert.equal(cfg.recallTokenBudget, 4242);
  });
});

test("config: capture defaults for kimi", async () => {
  await withSandbox(null, {}, () => {
    const cfg = loadConfig();
    assert.equal(cfg.autoCapture, true);
    assert.equal(cfg.captureMode, "semantic");
    assert.equal(cfg.captureAssistantTurns, true);
    assert.equal(cfg.commitTokenThreshold, 20000);
    assert.equal(cfg.timeoutMs >= 1000, true);
    assert.equal(cfg.kimiHome, join(process.env.HOME, ".kimi-code"));
  });
});

test("session id derivation: kc- prefix with subagent suffix isolation", () => {
  assert.equal(deriveOvSessionId("session_abc"), "kc-session_abc");
  assert.equal(deriveOvSessionId("session_0d3a-uuid"), "kc-session_0d3a-uuid");
  // Subagents get their own OV session, visually linked by the shared stem.
  assert.equal(deriveOvSessionId("session_abc", "subagent:agent-3"), "kc-session_abc__subagent-agent-3");
  // Suffix normalization: ':' -> '-', anything outside [A-Za-z0-9._-] -> '-'.
  assert.equal(deriveOvSessionId("session_abc", "subagent:a/b:c"), "kc-session_abc__subagent-a-b-c");
  assert.throws(() => deriveOvSessionId(""), /non-empty sessionId/);
});
