#!/usr/bin/env bash
# Prepare the bench work root (default bench/work, override with LEANREA_WORK).
#   ./setup.sh linux            Linux target: native tsc binary from npm @tsc-rs/linux-x64@0.7.0
#   ./setup.sh macos            macOS targets: Notion.app's app.asar + mac_utils.node, Homebrew gh
#   ./setup.sh <...> --with-rea also install rea-agents@6.5.0 (--ignore-scripts) for the rea arm
# Nothing here executes a target. All deletions are quoted and confined to the work root.
set -euo pipefail
umask 022

here="$(cd "$(dirname "$0")" && pwd -P)"
platform="${1:-}"; shift || true
with_rea=0
for a in "$@"; do
  case "$a" in
    --with-rea) with_rea=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done
case "$platform" in linux|macos) ;; *) echo "usage: $0 linux|macos [--with-rea]" >&2; exit 2 ;; esac

W="${LEANREA_WORK:-$here/work}"
mkdir -p -- "$W/targets"
W="$(cd -- "$W" && pwd -P)"
if [ "$W" = "/" ] || [ "$W" = "$HOME" ]; then echo "refusing work root $W" >&2; exit 1; fi

# rm -rf only a real (non-symlink) directory strictly inside the work root.
safe_rm() {
  local p="$1" t
  [ -e "$p" ] || return 0
  [ ! -L "$p" ] || { echo "refusing to remove symlink $p" >&2; exit 1; }
  t="$(cd -- "$p" && pwd -P)"
  case "$t/" in
    "$W/"?*) rm -rf -- "$t" ;;
    *) echo "refusing to remove $t (outside $W)" >&2; exit 1 ;;
  esac
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -- "$1" | cut -d ' ' -f 1
  else shasum -a 256 -- "$1" | cut -d ' ' -f 1; fi
}

if [ "$platform" = linux ]; then
  # Recorded 2026-10-18 from the npm registry (static inspection only).
  TGZ_SHA256=afb78de146a42b369d9a0e2588d5925da9546d29572e5249bf9f330858ea04ee
  BIN_SHA256=fb9223ad1f59392ca225dc4c1a76664e07f146bc5f22c91a13ade6b2f7c217cc
  dl="$(mktemp -d "$W/dl.XXXXXX")"
  trap 'safe_rm "$dl"' EXIT
  (cd -- "$dl" && npm pack @tsc-rs/linux-x64@0.7.0 --silent >/dev/null)
  tgz="$dl/tsc-rs-linux-x64-0.7.0.tgz"
  got="$(sha256 "$tgz")"
  [ "$got" = "$TGZ_SHA256" ] || { echo "tarball sha256 mismatch: $got" >&2; exit 1; }
  tar -xzf "$tgz" -C "$dl" package/lib/tsc
  got="$(sha256 "$dl/package/lib/tsc")"
  [ "$got" = "$BIN_SHA256" ] || { echo "binary sha256 mismatch: $got" >&2; exit 1; }
  [ ! -L "$W/targets/tsc" ] || { echo "refusing: $W/targets/tsc is a symlink" >&2; exit 1; }
  cp -- "$dl/package/lib/tsc" "$W/targets/tsc.tmp"
  chmod 0444 "$W/targets/tsc.tmp"   # not executable: the bench never runs it
  mv -f -- "$W/targets/tsc.tmp" "$W/targets/tsc"
  echo "target: $W/targets/tsc (sha256 $BIN_SHA256)"
else
  NOTION=/Applications/Notion.app/Contents/Resources
  GH="$(command -v gh || true)"
  [ -f "$NOTION/app.asar" ] || { echo "Notion.app not found" >&2; exit 1; }
  [ -n "$GH" ] || { echo "gh not found (ask before installing it)" >&2; exit 1; }
  addon="$(find "$NOTION/app.asar.unpacked" -name mac_utils.node -print -quit)"
  [ -n "$addon" ] || { echo "mac_utils.node not found" >&2; exit 1; }
  safe_rm "$W/targets/app.asar.unpacked"
  cp -c -- "$NOTION/app.asar" "$W/targets/app.asar" 2>/dev/null || cp -- "$NOTION/app.asar" "$W/targets/app.asar"
  cp -cR -- "$NOTION/app.asar.unpacked" "$W/targets/" 2>/dev/null || cp -R -- "$NOTION/app.asar.unpacked" "$W/targets/"
  cp -- "$addon" "$W/targets/mac_utils.node"
  cp -- "$GH" "$W/targets/gh"
  echo "NOTE: macOS answer keys match Notion 7.35.1 and gh built with go1.27.1; other versions need new keys."
fi

if [ "$with_rea" = 1 ]; then
  mkdir -p -- "$W/rea-install"
  (cd -- "$W/rea-install" && { [ -f package.json ] || npm init -y >/dev/null; } && npm install rea-agents@6.5.0 --ignore-scripts >/dev/null)
  node -e 'const [,p,o]=process.argv;require("fs").writeFileSync(o,JSON.stringify({mcpServers:{rea:{command:"node",args:[p,"--mcp"]}}}))' \
    "$W/rea-install/node_modules/rea-agents/scripts/rea.mjs" "$W/rea-mcp.json"
fi
echo "ready: $W"
