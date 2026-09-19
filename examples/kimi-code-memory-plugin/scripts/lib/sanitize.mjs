/**
 * Capture-side text sanitization for the Kimi Code memory plugin.
 *
 * Strips plugin-injected blocks (auto-recall context, system reminders,
 * relevant-memories wrappers, subagent context lines) WITHOUT collapsing
 * whitespace — the user's original formatting (newlines, code blocks) is
 * preserved for storage in OV. Without this, the <openviking-context> block
 * auto-recall injected on this very turn would be captured back into OV on
 * the next Stop, causing a self-referential pollution loop.
 *
 * Mirrors examples/claude-code-memory-plugin/scripts/auto-capture.mjs
 * stripInjectedBlocks. Kept in a pure lib module (instead of inline in
 * auto-capture.mjs) so tests can import it without triggering hook main().
 */

const RELEVANT_MEMORIES_BLOCK_RE = /<relevant-memor(?:y|ies)\b[^>]*>[\s\S]*?<\/relevant-memor(?:y|ies)>/gi;
const OPENVIKING_CTX_BLOCK_RE = /<openviking-context\b[^>]*>[\s\S]*?<\/openviking-context>/gi;
const SYSTEM_REMINDER_BLOCK_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
const SUBAGENT_CONTEXT_LINE_RE = /^\[Subagent Context\][^\n]*$/gmi;

export function stripInjectedBlocks(text) {
  return String(text || "")
    .replace(RELEVANT_MEMORIES_BLOCK_RE, "")
    .replace(OPENVIKING_CTX_BLOCK_RE, "")
    .replace(SYSTEM_REMINDER_BLOCK_RE, "")
    .replace(SUBAGENT_CONTEXT_LINE_RE, "")
    .replace(/\x00/g, "");
}

/**
 * Strip injected blocks and collapse whitespace for length/keyword gating.
 */
export function sanitize(text) {
  return stripInjectedBlocks(text)
    .replace(/\s+/g, " ")
    .trim();
}
