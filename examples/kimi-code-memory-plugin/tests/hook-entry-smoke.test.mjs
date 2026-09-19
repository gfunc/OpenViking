import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(SCRIPT_DIR, "..", "scripts");

const HOOKS = [
  "auto-recall.mjs",
  "auto-capture.mjs",
  "session-start.mjs",
  "pre-compact.mjs",
  "session-end.mjs",
  "subagent-start.mjs",
  "subagent-stop.mjs",
];

/**
 * Regression net for the 2026-08-30 incident: five hook scripts called
 * `isPluginEnabled()` without importing it. The fail-open `catch {}` in
 * `main()` swallowed the ReferenceError, so the hooks exited 0 SILENTLY and
 * every unit test still passed — capture never ran in production.
 *
 * Contract under test: with the plugin force-enabled and debug logging on, a
 * trivial `{}` payload must always produce at least one debug-log line (a
 * skip/parse gate fires before any network or transcript access). A hook that
 * dies on an undefined identifier writes an EMPTY log, which fails here.
 */
for (const hook of HOOKS) {
  test(`hook entry smoke: ${hook} reaches its gates and logs (no silent ReferenceError)`, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "ov-kimi-smoke-"));
    const debugLog = join(sandbox, "hooks.log");
    try {
      await writeFile(join(sandbox, "ovcli.conf"), JSON.stringify({
        url: "http://127.0.0.1:9",
        api_key: "test-key",
        plugin: { kimi_code: { writePathAsync: false } },
      }));

      const env = {
        ...process.env,
        OPENVIKING_MEMORY_ENABLED: "1",
        OPENVIKING_DEBUG: "1",
        OPENVIKING_DEBUG_LOG: debugLog,
        OPENVIKING_HOME: sandbox,
        OPENVIKING_CONFIG_FILE: join(sandbox, "missing-ov.conf"),
        OPENVIKING_CLI_CONFIG_FILE: join(sandbox, "ovcli.conf"),
        OPENVIKING_KIMI_HOME: join(sandbox, "kimi-home"),
        OPENVIKING_TIMEOUT_MS: "1000",
        OPENVIKING_CAPTURE_TIMEOUT_MS: "1000",
        OPENVIKING_RECALL_TIMEOUT_MS: "1000",
        OPENVIKING_WRITE_PATH_ASYNC: "0",
      };
      for (const key of Object.keys(env)) {
        if (key === "OPENVIKING_MEMORY_ENABLED" || key === "OPENVIKING_DEBUG" ||
            key === "OPENVIKING_DEBUG_LOG" || key === "OPENVIKING_WRITE_PATH_ASYNC") continue;
        if (key.startsWith("OPENVIKING_")) delete env[key];
      }
      // Re-apply the scrub-safe overrides after the scrub above.
      Object.assign(env, {
        OPENVIKING_MEMORY_ENABLED: "1",
        OPENVIKING_DEBUG: "1",
        OPENVIKING_DEBUG_LOG: debugLog,
        OPENVIKING_HOME: sandbox,
        OPENVIKING_CONFIG_FILE: join(sandbox, "missing-ov.conf"),
        OPENVIKING_CLI_CONFIG_FILE: join(sandbox, "ovcli.conf"),
        OPENVIKING_KIMI_HOME: join(sandbox, "kimi-home"),
        OPENVIKING_TIMEOUT_MS: "1000",
        OPENVIKING_CAPTURE_TIMEOUT_MS: "1000",
        OPENVIKING_RECALL_TIMEOUT_MS: "1000",
        OPENVIKING_WRITE_PATH_ASYNC: "0",
      });

      const stdout = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [join(SCRIPTS, hook)], {
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (c) => { out += c; });
        child.stderr.on("data", (c) => { err += c; });
        child.stdin.end(JSON.stringify({ hook_event_name: "Stop" }));
        const killer = setTimeout(() => child.kill("SIGKILL"), 15000);
        child.on("close", (code) => { clearTimeout(killer); resolve({ code, out, err }); });
        child.on("error", reject);
      }).then((r) => r);

      assert.equal(stdout.code, 0, `${hook} exited non-zero: ${stdout.err}`);
      assert.equal(stdout.out, "", `${hook} must write no stdout on a trivial payload`);
      assert.ok(!/is not defined|ReferenceError/.test(stdout.err), `${hook} threw: ${stdout.err}`);

      assert.ok(existsSync(debugLog), `${hook} never logged — entry path is broken (empty-import class of bug)`);
      const logContent = await readFile(debugLog, "utf-8");
      assert.ok(
        logContent.trim().length > 0,
        `${hook} debug log is empty — it exited before its first gate (silent no-op)`,
      );
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
}
