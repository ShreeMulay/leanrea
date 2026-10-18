#!/usr/bin/env bash
# Context overhead probe (Claude Code): one "Reply with exactly OK." per config; prints context tokens and cost.
# Calls a paid agent. Run only in a disposable VM/container. No tool is pre-approved (dontAsk).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
W="${LEANREA_WORK:-$here/work}"
W="$(cd -- "$W" && pwd -P)"
MODEL="${BENCH_MODEL:-sonnet}"
C="$(mktemp -d "$W/ctx.XXXXXX")"
mkdir -p -- "$C/none" "$C/leanrea/.claude/skills/leanrea" "$C/rea/.claude/skills"
cp -- "$here/../leanrea/SKILL.md" "$C/leanrea/.claude/skills/leanrea/SKILL.md"
if [ -d "$W/rea-install/node_modules/rea-agents/skills/reverse-engineer-anything" ]; then
  cp -R -- "$W/rea-install/node_modules/rea-agents/skills/reverse-engineer-anything" "$C/rea/.claude/skills/"
fi
probe() { local dir="$1" prompt="$2"; shift 2
  (cd -- "$C/$dir" && printf '%s\n' "$prompt" | env -i PATH="$PATH" HOME="$HOME" TERM="${TERM:-dumb}" ${ENABLE_TOOL_SEARCH:+ENABLE_TOOL_SEARCH="$ENABLE_TOOL_SEARCH"} ${ANTHROPIC_API_KEY:+ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"} \
    claude -p --model "$MODEL" --output-format json --strict-mcp-config --no-session-persistence --permission-mode dontAsk "$@" \
    | jq -c '{cost: .total_cost_usd, ctx_tokens: (.usage.input_tokens + .usage.cache_creation_input_tokens + .usage.cache_read_input_tokens)}'); }
echo -n "nothing:                      "; probe none "Reply with exactly OK."
echo -n "leanrea skill invoked:        "; probe leanrea "/leanrea Reply with exactly OK."
if [ -f "$W/rea-mcp.json" ]; then
  echo -n "REA skill + MCP:              "; probe rea "/reverse-engineer-anything Reply with exactly OK." --mcp-config "$W/rea-mcp.json"
  echo -n "REA MCP, tool search auto:    "; probe rea "Reply with exactly OK." --mcp-config "$W/rea-mcp.json"
  echo -n "REA MCP, tool search OFF:     "; ENABLE_TOOL_SEARCH=false probe rea "Reply with exactly OK." --mcp-config "$W/rea-mcp.json"
fi
echo "probe dir (inside the work root): $C"
