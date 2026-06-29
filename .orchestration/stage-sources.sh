#!/usr/bin/env bash
# Re-stage the pinned third-party source the build phases read.
# Idempotent: safe to re-run. Populates ./sources and ./sdks next to this script.
# The pi engine source is read from /home/vikash/pi-dynamic-workflows (@1b0291ab) and is NOT copied here.
set -euo pipefail
ORCH="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$ORCH/sources" "$ORCH/sdks"

clone_at() { # url dir sha
  local url="$1" dir="$2" sha="$3"
  [ -d "$ORCH/sources/$dir/.git" ] || git clone --quiet "$url" "$ORCH/sources/$dir"
  git -C "$ORCH/sources/$dir" fetch --quiet --all || true
  git -C "$ORCH/sources/$dir" checkout --quiet "$sha"
  echo "  sources/$dir @ $(git -C "$ORCH/sources/$dir" rev-parse --short HEAD)"
}

echo "staging ACP server source repos at their pinned SHAs..."
clone_at https://github.com/agentclientprotocol/claude-agent-acp claude-agent-acp b8df8e0e5460fd782214f4dde488f7476c80c454
clone_at https://github.com/agentclientprotocol/codex-acp        codex-acp        5506fbae85878013c6eb40ae540ea21a607d9334

echo "packing + extracting the SDK tarballs..."
for spec in \
  "@agentclientprotocol/sdk@1.0.0" \
  "@modelcontextprotocol/sdk@1.29.0" \
  "@anthropic-ai/claude-agent-sdk@0.3.195"; do
  npm pack "$spec" --pack-destination "$ORCH/sdks" >/dev/null
done
for t in "$ORCH"/sdks/*.tgz; do
  d="${t%.tgz}"; mkdir -p "$d"; tar -xzf "$t" -C "$d"; rm -f "$t"
done
echo "  sdks: $(ls -1 "$ORCH/sdks" | tr '\n' ' ')"

echo "done. pi engine source expected at /home/vikash/pi-dynamic-workflows/src (@1b0291ab)."
