import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AUTO_RECALL = join(SCRIPT_DIR, "..", "scripts", "auto-recall.mjs");

/**
 * Negative-control + stdout-contract harness: run auto-recall.mjs as a child
 * process with a scrubbed env and a sandboxed OV home, and assert on
 * (exit code, stdout, elapsed).
 */
async function runAutoRecall(stdinPayload, env = {}, { timeoutMs = 20000, seed, observe } = {}) {
  const sandbox = await mkdtemp(join(tmpdir(), "ov-kimi-recall-"));
  // Fixture ovcli.conf carrying the installer's plugin.kimi_code pins, so the
  // recall hook runs with the same query-expansion-off contract as production.
  const ovcli = {
    url: env.__OV_URL__ || "http://127.0.0.1:9",
    api_key: "test-key",
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
      },
    },
  };
  delete env.__OV_URL__;
  await writeFile(join(sandbox, "ovcli.conf"), JSON.stringify(ovcli));
  if (seed) await seed(sandbox);

  const cleanEnv = { ...process.env };
  for (const key of Object.keys(cleanEnv)) {
    if (key.startsWith("OPENVIKING_")) delete cleanEnv[key];
  }
  const childEnv = {
    ...cleanEnv,
    OPENVIKING_MEMORY_ENABLED: "1",
    OPENVIKING_HOME: sandbox,
    OPENVIKING_STATE_DIR: join(sandbox, "state"),
    OPENVIKING_PENDING_DIR: join(sandbox, "pending"),
    OPENVIKING_CONFIG_FILE: join(sandbox, "missing-ov.conf"),
    OPENVIKING_CLI_CONFIG_FILE: join(sandbox, "ovcli.conf"),
    OPENVIKING_KIMI_HOME: join(sandbox, "kimi-home"),
    OPENVIKING_RECALL_TIMEOUT_MS: "4000",
    OPENVIKING_TIMEOUT_MS: "2000",
    ...env,
  };

  const started = Date.now();
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [AUTO_RECALL], {
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`auto-recall did not exit within ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", (err) => { clearTimeout(timer); reject(err); });
      child.on("close", async (code) => {
        clearTimeout(timer);
        // Observe runs while the sandbox still exists (before the caller's
        // finally clause removes it).
        let observed = null;
        if (observe) {
          try {
            observed = await observe(sandbox);
          } catch (err) {
            observed = { observeError: String(err?.stack || err) };
          }
        }
        resolve({ code, stdout, stderr, elapsedMs: Date.now() - started, sandbox, observed });
      });
      child.stdin.end(typeof stdinPayload === "string" ? stdinPayload : JSON.stringify(stdinPayload));
    });
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
}

async function withMockOpenViking(handler, fn) {
  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error", error: String(err?.stack || err) }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ---------------------------------------------------------------------------
// Negative controls: every failure path must exit 0 with EMPTY stdout.
// ---------------------------------------------------------------------------

test("negative control: server unreachable => exit 0, empty stdout, fast", async () => {
  // Port 9 (discard) on 127.0.0.1 refuses connections immediately.
  const result = await runAutoRecall(
    { prompt: "what did we decide about the deployment pipeline?", session_id: "session_dead-port" },
    { OPENVIKING_URL: "http://127.0.0.1:9" },
  );
  assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
  assert.equal(result.stdout, "");
  assert.ok(result.elapsedMs < 4500, `expected fast failure, took ${result.elapsedMs}ms`);
});

test("negative control: malformed stdin JSON => exit 0, empty stdout", async () => {
  const result = await runAutoRecall("this is {{{ not json");
  assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
  assert.equal(result.stdout, "");
});

test("negative control: short query below minQueryLength => exit 0, empty stdout", async () => {
  const result = await runAutoRecall(
    { prompt: "hi", session_id: "session_short" },
    // Point at a dead server anyway: the query gate must fire before any I/O.
    { OPENVIKING_URL: "http://127.0.0.1:9" },
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
});

test("negative control: bypass pattern match => exit 0, empty stdout", async () => {
  const result = await runAutoRecall(
    { prompt: "recall something for the scratch session", session_id: "scratch-123", cwd: "/tmp/scratch" },
    {
      OPENVIKING_URL: "http://127.0.0.1:9",
      OPENVIKING_BYPASS_SESSION_PATTERNS: "scratch-*",
    },
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
});

test("negative control: empty prompt => exit 0, empty stdout", async () => {
  const result = await runAutoRecall({ prompt: "", session_id: "session_empty" });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
});

// ---------------------------------------------------------------------------
// Positive controls: valid payload + live mock server => plain-text block.
// ---------------------------------------------------------------------------

test("valid payload injects a plain-text openviking-context block with pinned body fields", async () => {
  const requests = [];
  const result = await withMockOpenViking(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", result: { ok: true } }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v1/search/search") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        result: {
          entries: [{
            uri: "viking://user/default/memories/events/launch.md",
            category: "events",
            score: 0.9,
            text: "context-aware recalled detail",
          }],
          rendered: "OpenViking context: context-aware recalled detail",
          digest: "",
          stats: { returned: 1 },
        },
      }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "error", error: "not found" }));
  }, (baseUrl) => runAutoRecall(
    { prompt: "please use prior context", session_id: "session_abc-123", cwd: "/tmp" },
    { OPENVIKING_URL: baseUrl },
  ));

  assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
  // Plain text on stdout — NOT a Claude-style JSON envelope.
  assert.ok(result.stdout.includes("<openviking-context>"), result.stdout);
  assert.ok(result.stdout.includes("context-aware recalled detail"), result.stdout);
  assert.ok(result.stdout.trimEnd().endsWith("</openviking-context>"));
  assert.equal(JSON.stringify(result.stdout).includes("hookSpecificOutput"), false);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].mode, "context");
  assert.equal(requests[0].purpose, "coding");
  assert.equal(requests[0].session_id, "kc-session_abc-123");
  // Installer pins must reach the wire as an explicit off.
  assert.equal(requests[0].query_expansion, "off");
  assert.equal(requests[0].dedup_turns, 5);
  assert.equal(requests[0].score_threshold, 0.35);
  assert.equal(requests[0].rewrite, undefined);
  // Target scoping: resources (imported corpora) never enter auto-recall.
  assert.deepEqual(requests[0].context_type, ["memory", "skill"]);
});

test("first prompt after resume merges the stashed archive overview and consumes the stash", async () => {
  const requests = [];
  const result = await withMockOpenViking(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", result: { ok: true } }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v1/search/search") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      // Empty recall: the resume summary must still be injected on its own.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", result: { entries: [], rendered: "", stats: {} } }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "error", error: "not found" }));
  }, (baseUrl) => runAutoRecall(
    { prompt: "continue where we left off", session_id: "session_resume-1" },
    { OPENVIKING_URL: baseUrl },
    {
      // Seed the stash session-start.mjs would have written on resume.
      seed: async (sandbox) => {
        const stateDir = join(sandbox, "state");
        await mkdir(stateDir, { recursive: true });
        await writeFile(
          join(stateDir, "kimi-session-start.json"),
          JSON.stringify({
            source: "resume",
            session_id: "session_resume-1",
            ov_session_id: "kc-session_resume-1",
            archive_overview: "Prior session built the wire parser.",
            ts: Date.now(),
          }),
        );
      },
      // The stash must be consumed (deleted) by the merge.
      observe: async (sandbox) => {
        try {
          await readFile(join(sandbox, "state", "kimi-session-start.json"), "utf-8");
          return { stashDeleted: false };
        } catch {
          return { stashDeleted: true };
        }
      },
    },
  ));

  assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
  assert.ok(result.stdout.includes("<openviking-context"), result.stdout);
  assert.ok(result.stdout.includes("[Session History Summary]"), result.stdout);
  assert.ok(result.stdout.includes("Prior session built the wire parser."), result.stdout);
  assert.equal(requests[0].session_id, "kc-session_resume-1");
  assert.equal(result.observed?.stashDeleted, true);
});
