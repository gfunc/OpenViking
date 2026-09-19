import assert from "node:assert/strict";
import test from "node:test";
import { sanitize, stripInjectedBlocks } from "../scripts/lib/sanitize.mjs";

test("stripInjectedBlocks removes <openviking-context> blocks", () => {
  const text = [
    "before",
    "<openviking-context>",
    "Relevant memory from OpenViking.",
    "- [memory 90%] viking://user/default/memies/x.md",
    "</openviking-context>",
    "after",
  ].join("\n");
  const out = stripInjectedBlocks(text);
  assert.ok(out.includes("before"));
  assert.ok(out.includes("after"));
  assert.equal(out.includes("Relevant memory"), false);
  assert.equal(out.includes("viking://"), false);
});

test("stripInjectedBlocks removes <openviking-context source=...> attributed variants", () => {
  const out = stripInjectedBlocks(
    'a\n<openviking-context source="auto-recall" format="digest">secret</openviking-context>\nb',
  );
  assert.equal(out.includes("secret"), false);
  assert.ok(out.includes("a"));
  assert.ok(out.includes("b"));
});

test("stripInjectedBlocks removes <system-reminder> blocks", () => {
  const out = stripInjectedBlocks(
    "keep me\n<system-reminder>The TodoList tool has not been used.</system-reminder>\nand me",
  );
  assert.equal(out.includes("TodoList"), false);
  assert.ok(out.includes("keep me"));
  assert.ok(out.includes("and me"));
});

test("stripInjectedBlocks removes <relevant-memories> blocks", () => {
  const out = stripInjectedBlocks(
    "<relevant-memories><memory>stale</memory></relevant-memories>real content",
  );
  assert.equal(out.includes("stale"), false);
  assert.ok(out.includes("real content"));
});

test("stripInjectedBlocks removes [Subagent Context] lines and NUL bytes", () => {
  const out = stripInjectedBlocks(
    "[Subagent Context] explore\u0000\n[Subagent Context] agent-2 summary\nkept",
  );
  assert.equal(out.includes("Subagent Context"), false);
  assert.equal(out.includes("\u0000"), false);
  assert.ok(out.includes("kept"));
});

test("sanitize strips blocks and collapses whitespace", () => {
  const out = sanitize(
    "hello   \n <system-reminder>x</system-reminder>\n\n  world  ",
  );
  assert.equal(out, "hello world");
});

test("sanitize of a fully-injected text is empty (turn is dropped)", () => {
  assert.equal(sanitize("<openviking-context>only injected</openviking-context>"), "");
});
