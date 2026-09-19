import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  extractTurns,
  lookupSessionDir,
  mainWirePath,
  parseSessionIndex,
  parseWireTranscript,
  turnsFromWireContent,
} from "../scripts/lib/kimi-transcript.mjs";

const SESSION_INDEX_LINES = [
  JSON.stringify({
    sessionId: "session_42ff8027-eb98-4bbc-9c1b-5625dd4c754c",
    sessionDir: "/home/u/.kimi-code/sessions/wd_x/session_42ff8027",
    workDir: "/home/u/proj",
  }),
  JSON.stringify({
    sessionId: "session_b3c2bdd1-2437-421a-8c73-a242f4cd61a1",
    sessionDir: "/home/u/.kimi-code/sessions/wd_y/session_b3c2bdd1",
    workDir: "/home/u/openclaw",
  }),
  "{ this line is not json",
  "",
].join("\n");

function appendMessage(message, time = 1783472654768) {
  return JSON.stringify({ type: "context.append_message", message, time });
}

const WIRE_LINES = [
  // Non-turn events: skipped.
  JSON.stringify({ type: "metadata", created_at: "2026-01-01", protocol_version: 1 }),
  JSON.stringify({ type: "config.update", modelAlias: "kimi-for-coding", time: 1 }),
  JSON.stringify({ type: "turn.prompt", input: "ignored", origin: "user", time: 2 }),
  JSON.stringify({ type: "context.append_loop_event", event: { type: "step.begin" }, time: 3 }),
  // Real user turn.
  appendMessage({
    role: "user",
    content: [{ type: "text", text: "对比这两个仓库，写一份分析报告。" }],
    toolCalls: [],
    origin: { kind: "user" },
  }, 1000),
  // Injected reminder — MUST be excluded.
  appendMessage({
    role: "user",
    content: [{ type: "text", text: "<system-reminder>The TodoList tool has not been used.</system-reminder>" }],
    toolCalls: [],
    origin: { kind: "injection", variant: "todo_list_reminder" },
  }, 1001),
  // System-triggered user record — excluded.
  appendMessage({
    role: "user",
    content: [{ type: "text", text: "Skill tool loaded instructions." }],
    toolCalls: [],
    origin: { kind: "skill_activation", skillName: "brainstorming" },
  }, 1002),
  // Background task notification — excluded.
  appendMessage({
    role: "user",
    content: [{ type: "text", text: '<notification id="task:bash-1:completed">done</notification>' }],
    toolCalls: [],
    origin: { kind: "task", taskId: "bash-1" },
  }, 1003),
  // Assistant turn: think block dropped, text + toolCalls kept.
  appendMessage({
    role: "assistant",
    content: [
      { type: "think", think: "internal reasoning trace" },
      { type: "text", text: "我先看一下两个项目的结构。" },
    ],
    toolCalls: [{
      type: "function",
      id: "tool_abc",
      name: "Bash",
      arguments: '{"command":"ls /home/u/proj"}',
    }],
  }, 1004),
  // Assistant text-only turn.
  appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "结论是二者定位不同。" }],
    toolCalls: [],
  }, 1005),
  // Tool result record — dropped.
  appendMessage({
    role: "tool",
    content: [{ type: "text", text: "file1\nfile2" }],
    toolCalls: [],
  }, 1006),
  // User turn with no content — dropped (nothing to capture).
  appendMessage({ role: "user", content: [], toolCalls: [], origin: { kind: "user" } }, 1007),
  // Malformed line — skipped.
  "{broken json",
  "",
].join("\n");

test("parseSessionIndex reads entries and skips malformed lines", () => {
  const entries = parseSessionIndex(SESSION_INDEX_LINES);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].sessionId, "session_42ff8027-eb98-4bbc-9c1b-5625dd4c754c");
  assert.equal(entries[1].sessionDir, "/home/u/.kimi-code/sessions/wd_y/session_b3c2bdd1");
});

test("lookupSessionDir matches exact and bare ids, null on miss", () => {
  const entries = parseSessionIndex(SESSION_INDEX_LINES);
  assert.equal(lookupSessionDir(entries, "session_42ff8027-eb98-4bbc-9c1b-5625dd4c754c"), "/home/u/.kimi-code/sessions/wd_x/session_42ff8027");
  assert.equal(lookupSessionDir(entries, "session_b3c2bdd1-2437-421a-8c73-a242f4cd61a1"), "/home/u/.kimi-code/sessions/wd_y/session_b3c2bdd1");
  // Tolerates a missing "session_" prefix.
  assert.equal(lookupSessionDir(entries, "42ff8027-eb98-4bbc-9c1b-5625dd4c754c"), "/home/u/.kimi-code/sessions/wd_x/session_42ff8027");
  // Missing entry => null (capture must no-op).
  assert.equal(lookupSessionDir(entries, "session_does-not-exist"), null);
  assert.equal(lookupSessionDir(entries, ""), null);
  assert.equal(lookupSessionDir(entries, null), null);
});

test("parseWireTranscript keeps only append_message records, skips malformed lines", () => {
  const records = parseWireTranscript(WIRE_LINES);
  assert.equal(records.length, 8);
  assert.ok(records.every((r) => r.type === "context.append_message"));
  assert.equal(parseWireTranscript("").length, 0);
});

test("extractTurns keeps real user + assistant turns, excludes injections", () => {
  const records = parseWireTranscript(WIRE_LINES);
  const turns = extractTurns(records);

  // 9 records -> user(user) + assistant + assistant = 3 turns.
  assert.equal(turns.length, 3);

  assert.equal(turns[0].role, "user");
  assert.equal(turns[0].text, "对比这两个仓库，写一份分析报告。");
  assert.equal(turns[0].time, 1000);

  assert.equal(turns[1].role, "assistant");
  // think block excluded.
  assert.equal(turns[1].text.includes("internal reasoning trace"), false);
  // text + serialized tool call included.
  assert.ok(turns[1].text.includes("我先看一下两个项目的结构。"));
  assert.ok(turns[1].text.includes("[tool-call Bash] {\"command\":\"ls /home/u/proj\"}"));
  assert.deepEqual(turns[1].toolNames, ["Bash"]);

  assert.equal(turns[2].role, "assistant");
  assert.equal(turns[2].text, "结论是二者定位不同。");
});

test("turnsFromWireContent is the content->turns convenience and is malformed-tolerant", () => {
  const turns = turnsFromWireContent(WIRE_LINES);
  assert.equal(turns.length, 3);

  assert.deepEqual(turnsFromWireContent(""), []);
  assert.deepEqual(turnsFromWireContent("not json at all\n{ also broken"), []);
  assert.deepEqual(turnsFromWireContent(null), []);
});

const LOOP_STYLE_WIRE = [
  JSON.stringify({ type: "metadata", created_at: "2026-08-30", protocol_version: 1 }),
  // User turn (append_message, as in every wire).
  appendMessage({
    role: "user",
    content: [{ type: "text", text: "检查一下这个仓库的结构。" }],
    toolCalls: [],
    origin: { kind: "user" },
  }, 2000),
  // Assistant step 1: text part + think part + tool call.
  JSON.stringify({ type: "context.append_loop_event", event: { type: "step.begin", turnId: "0", step: 1 }, time: 2001 }),
  JSON.stringify({ type: "context.append_loop_event", event: { type: "content.part", part: { type: "think", think: "reasoning..." }, stepUuid: "step-1" }, time: 2001 }),
  JSON.stringify({ type: "context.append_loop_event", event: { type: "content.part", part: { type: "text", text: "我先列出目录。" }, stepUuid: "step-1" }, time: 2002 }),
  JSON.stringify({ type: "context.append_loop_event", event: { type: "tool.call", toolCallId: "tool_x", name: "Bash", args: { command: "ls ." }, stepUuid: "step-1" }, time: 2003 }),
  JSON.stringify({ type: "context.append_loop_event", event: { type: "step.end", stepUuid: "step-1" }, time: 2004 }),
  // Assistant step 2: another stepUuid with only text.
  JSON.stringify({ type: "context.append_loop_event", event: { type: "content.part", part: { type: "text", text: "结构清楚了。" }, stepUuid: "step-2" }, time: 2005 }),
  // Unrelated loop events are ignored.
  JSON.stringify({ type: "context.append_loop_event", event: { type: "step.begin" }, time: 2006 }),
  JSON.stringify({ type: "usage.record", usage: {}, time: 2007 }),
].join("\n");

test("loop-event style wires synthesize assistant turns grouped by stepUuid, in order", () => {
  const turns = turnsFromWireContent(LOOP_STYLE_WIRE);
  assert.equal(turns.length, 3);

  assert.equal(turns[0].role, "user");
  assert.equal(turns[0].text, "检查一下这个仓库的结构。");

  assert.equal(turns[1].role, "assistant");
  assert.equal(turns[1].text.includes("reasoning..."), false); // think dropped
  assert.ok(turns[1].text.includes("我先列出目录。"));
  assert.ok(turns[1].text.includes('[tool-call Bash] {"command":"ls ."}'));
  assert.deepEqual(turns[1].toolNames, ["Bash"]);

  assert.equal(turns[2].role, "assistant");
  assert.equal(turns[2].text, "结构清楚了。");
});

test("extractTurns handles string content and args objects", () => {
  const turns = extractTurns(parseWireTranscript([
    appendMessage({ role: "user", content: "plain string content", origin: { kind: "user" } }, 10),
    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "calling tool" }],
      toolCalls: [{ type: "function", id: "t1", name: "Read", arguments: { path: "/tmp/x" } }],
    }, 11),
  ].join("\n")));

  assert.equal(turns.length, 2);
  assert.equal(turns[0].text, "plain string content");
  assert.ok(turns[1].text.includes("[tool-call Read]"));
  assert.ok(turns[1].text.includes('"path":"/tmp/x"'));
});

test("mainWirePath resolves <sessionDir>/agents/main/wire.jsonl or null", () => {
  const entries = parseSessionIndex(SESSION_INDEX_LINES);
  assert.equal(
    mainWirePath(SESSION_INDEX_LINES, "session_42ff8027-eb98-4bbc-9c1b-5625dd4c754c"),
    join("/home/u/.kimi-code/sessions/wd_x/session_42ff8027", "agents", "main", "wire.jsonl"),
  );
  assert.equal(mainWirePath(SESSION_INDEX_LINES, "session_missing"), null);
  assert.equal(mainWirePath("garbage that is not an index", "session_42ff8027"), null);
});
