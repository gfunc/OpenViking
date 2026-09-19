/**
 * Shared runtime state files under ~/.openviking/state/.
 *
 * Copied from examples/claude-code-memory-plugin/scripts/lib/state.mjs and
 * adapted for the Kimi Code plugin. Hooks (session-start, auto-recall,
 * auto-capture) write small JSON snapshots here so state survives across the
 * one-shot hook processes (resume-summary stash, per-session capture cursor,
 * subagent isolation records).
 *
 * Atomic write: temp file + rename, so a concurrent hook never reads a half-
 * written file. Stale entries (older than maxAgeMs) read as null.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OV_HOME = process.env.OPENVIKING_HOME && process.env.OPENVIKING_HOME.trim()
  ? process.env.OPENVIKING_HOME.replace(/^~(?=$|\/)/, homedir())
  : join(homedir(), ".openviking");
export const STATE_DIR = join(OV_HOME, "state");

function ensureDir() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
  } catch { /* best effort — caller will see write failure */ }
}

export function statePath(name) {
  return join(STATE_DIR, name);
}

export function writeJsonState(name, payload) {
  ensureDir();
  const target = statePath(name);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ ...payload, ts: payload?.ts ?? Date.now() }));
    renameSync(tmp, target);
  } catch { /* best effort: hooks tolerate missing files */ }
}

export function readJsonState(name, { maxAgeMs } = {}) {
  let raw;
  try {
    raw = readFileSync(statePath(name), "utf-8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (maxAgeMs && typeof parsed?.ts === "number" && Date.now() - parsed.ts > maxAgeMs) {
    return null;
  }
  return parsed;
}

export function removeState(name) {
  try {
    unlinkSync(statePath(name));
  } catch { /* already gone */ }
}
