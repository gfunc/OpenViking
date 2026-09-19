#!/usr/bin/env bash
#
# OpenViking Memory Plugin for Kimi Code — installer.
#
# Local (repo checkout):
#   bash examples/kimi-code-memory-plugin/setup-helper/install.sh
# One-liner (GitHub):
#   bash <(curl -fsSL https://raw.githubusercontent.com/volcengine/OpenViking/main/examples/kimi-code-memory-plugin/setup-helper/install.sh)
#
# What it does (idempotent):
#   1. Copies scripts/ to ~/.openviking/kimi-code-memory-plugin/scripts/
#   2. Merges hooks/kimi-hooks.json into ~/.kimi-code/config.toml as [[hooks]]
#      tables (TOML-safe: entries whose command is already present are skipped;
#      a timestamped config.toml.YYYYmmdd-HHMMSS.bak backup is written first)
#   3. Merges the plugin tuning block into ~/.openviking/ovcli.conf under
#      plugin.kimi_code, preserving existing url/api_key/account/user
#   4. Pointers for the Kimi Code MCP connection are NOT touched — kimi talks
#      to OpenViking's /mcp endpoint directly via ~/.kimi-code/mcp.json
#
# Env overrides:
#   OPENVIKING_HOME            OV state root      (default ~/.openviking)
#   KIMI_CODE_HOME             kimi config root   (default ~/.kimi-code)
#   OPENVIKING_CLI_CONFIG_FILE ovcli.conf path    (default $OPENVIKING_HOME/ovcli.conf)
#   OPENVIKING_PLUGIN_DIR      install target     (default $OPENVIKING_HOME/kimi-code-memory-plugin)
#
# When run via `curl | bash` (no local plugin dir), the script downloads the
# repo tarball from GitHub and extracts examples/kimi-code-memory-plugin.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
PLUGIN_SRC="$SCRIPT_DIR/.."           # examples/kimi-code-memory-plugin (when local)
PLUGIN_SRC="$(cd "$PLUGIN_SRC" >/dev/null 2>&1 && pwd -P)"

OV_HOME="${OPENVIKING_HOME:-$HOME/.openviking}"
KIMI_HOME="${KIMI_CODE_HOME:-$HOME/.kimi-code}"
PLUGIN_DIR="${OPENVIKING_PLUGIN_DIR:-$OV_HOME/kimi-code-memory-plugin}"
OVCLI_CONF="${OPENVIKING_CLI_CONFIG_FILE:-$OV_HOME/ovcli.conf}"
KIMI_CONFIG="${KIMI_CONFIG_FILE:-$KIMI_HOME/config.toml}"
REPO_TARBALL="${OPENVIKING_REPO_TARBALL:-https://codeload.github.com/volcengine/OpenViking/tar.gz/refs/heads/main}"

GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[0;31m'; RESET=$'\033[0m'
info() { printf '%s==>%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s!!%s  %s\n' "$YELLOW" "$RESET" "$*"; }
err()  { printf '%sxx%s  %s\n' "$RED" "$RESET" "$*" >&2; }

if ! command -v node >/dev/null 2>&1; then
  err "node is required (kimi hooks run 'node <script>'). Install Node 18+ and re-run."
  exit 1
fi

# ---------------------------------------------------------------------------
# 0. Locate the plugin source; fetch the tarball when piped from curl.
# ---------------------------------------------------------------------------

if [ ! -f "$PLUGIN_SRC/hooks/kimi-hooks.json" ] || [ ! -d "$PLUGIN_SRC/scripts" ]; then
  info "Plugin source not found next to the script; downloading the OpenViking repo tarball..."
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/ov-kimi-install.XXXXXX")"
  curl -fsSL -o "$tmp/ov.tar.gz" "$REPO_TARBALL"
  tar -xzf "$tmp/ov.tar.gz" -C "$tmp"
  PLUGIN_SRC="$(echo "$tmp"/OpenViking-*/examples/kimi-code-memory-plugin)"
  if [ ! -f "$PLUGIN_SRC/hooks/kimi-hooks.json" ]; then
    err "Could not locate examples/kimi-code-memory-plugin inside the downloaded tarball."
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 1. Copy scripts/
# ---------------------------------------------------------------------------

info "Copying scripts to $PLUGIN_DIR/scripts"
mkdir -p "$PLUGIN_DIR"
rm -rf "$PLUGIN_DIR/scripts"
cp -R "$PLUGIN_SRC/scripts" "$PLUGIN_DIR/scripts"
find "$PLUGIN_DIR/scripts" -name '*.test.mjs' -delete 2>/dev/null || true

# ---------------------------------------------------------------------------
# 2. Merge hooks into ~/.kimi-code/config.toml
# ---------------------------------------------------------------------------

info "Merging hooks into $KIMI_CONFIG"
if [ ! -f "$KIMI_CONFIG" ]; then
  warn "$KIMI_CONFIG not found — creating it (kimi will read hooks from it on next launch)."
  mkdir -p "$(dirname "$KIMI_CONFIG")"
  : > "$KIMI_CONFIG"
fi

backup="$KIMI_CONFIG.$(date +%Y%m%d-%H%M%S).bak"
cp "$KIMI_CONFIG" "$backup"
info "Backup written: $backup"

node - "$KIMI_CONFIG" "$PLUGIN_SRC/hooks/kimi-hooks.json" "$PLUGIN_DIR" <<'NODE'
const fs = require("node:fs");

const [configPath, hooksPath, pluginDir] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
const PLACEHOLDER = "__OV_KIMI_PLUGIN_DIR__";

let entries;
try {
  entries = spec.hooks || [];
} catch {
  console.error("invalid kimi-hooks.json");
  process.exit(1);
}

const config = fs.readFileSync(configPath, "utf8");
const lines = config.split("\n");

// Idempotency: skip any entry whose resolved command already appears in a
// `command = "..."` line (string containment on the script path, so even a
// hand-edited env prefix still matches).
const existingCommands = [];
for (const line of lines) {
  const m = line.match(/^\s*command\s*=\s*"(.*)"\s*$/);
  if (m) existingCommands.push(m[1]);
}

const toTomlString = (value) =>
  `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const appended = [];
let out = config;
if (!out.endsWith("\n") && out.length > 0) out += "\n";

for (const entry of entries) {
  if (!entry || typeof entry.event !== "string" || typeof entry.command !== "string") continue;
  const command = entry.command.split(PLACEHOLDER).join(pluginDir);
  if (existingCommands.some((existing) => existing.includes(command.trim()))) continue;

  let block = "\n[[hooks]]\n";
  block += `event = ${toTomlString(entry.event)}\n`;
  if (entry.matcher) block += `matcher = ${toTomlString(entry.matcher)}\n`;
  block += `command = ${toTomlString(command)}\n`;
  if (entry.timeout != null) block += `timeout = ${Number(entry.timeout)}\n`;
  out += block;
  appended.push(entry.event);
}

fs.writeFileSync(configPath, out);
if (appended.length === 0) {
  console.log("hooks: nothing to add (all entries already present)");
} else {
  console.log(`hooks: added ${appended.length} entr${appended.length === 1 ? "y" : "ies"} -> ${appended.join(", ")}`);
}
NODE

# ---------------------------------------------------------------------------
# 3. Merge the plugin tuning block into ~/.openviking/ovcli.conf
# ---------------------------------------------------------------------------

info "Merging plugin.kimi_code tuning into $OVCLI_CONF"
node - "$OVCLI_CONF" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [confPath] = process.argv.slice(2);
let conf = {};
try {
  conf = JSON.parse(fs.readFileSync(confPath, "utf8"));
} catch { /* first install or unreadable file: start fresh */ }

// Never touch connection fields — `ov config` owns url/api_key/account/user.
conf.plugin = conf.plugin && typeof conf.plugin === "object" ? conf.plugin : {};
conf.plugin.kimi_code = {
  ...(conf.plugin.kimi_code || {}),
  // Pins: keep recall strictly inside kimi's 5s UserPromptSubmit budget.
  recallQueryExpansion: "off",
  recallCompress: "off",
  recallContextTimeoutMs: 3000,
  recallTokenBudget: 2000,
  scoreThreshold: 0.35,
  recallDedupTurns: 5,
  minQueryLength: 3,
  writePathAsync: true,
  // Auto-recall targets: memory+skill only. `resources` in the mix let
  // boilerplate-heavy imported corpora crowd out real memories; deliberate
  // resource lookups go through the MCP ov_search tools instead.
  recallTargetTypes: ["memory", "skill"],
};

fs.mkdirSync(path.dirname(confPath), { recursive: true });
fs.writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n", { mode: 0o600 });
console.log(`plugin.kimi_code pins written (existing url/api_key preserved)`);
NODE
chmod 600 "$OVCLI_CONF" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 4. MCP note
# ---------------------------------------------------------------------------

if [ ! -f "$KIMI_HOME/mcp.json" ] || ! grep -q "openviking" "$KIMI_HOME/mcp.json" 2>/dev/null; then
  warn "OpenViking MCP is not registered in $KIMI_HOME/mcp.json yet."
  warn "Recall/capture work without it, but the agent cannot actively read/search memories."
  warn "Add an MCP server entry pointing at OpenViking's /mcp endpoint (default http://127.0.0.1:1933/mcp)."
fi

info "Done. Restart kimi (or start a new session) to load the hooks."
info "Verify: OPENVIKING_DEBUG=1 then check ~/.openviking/logs/kimi-hooks.log after a turn."
