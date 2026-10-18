#!/usr/bin/env bash
# Full benchmark on this platform's task set: arms side by side, REPS reps.
# Requires `npm run build`, `./setup.sh <platform>`, and a disposable VM/container (pass --isolated).
# NOTE: real agent runs are currently disabled in run.js (issue #2); only RUNNER=fake or --dry-run work.
#   REPS=3 RUNNER=claude-code ./run_all.sh --isolated [extra run.js flags]
# Appends rows to "$LEANREA_WORK/results/run.jsonl" (default bench/work).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
repo="$(dirname "$here")"
run="$repo/build/bench/run.js"
[ -f "$run" ] || { echo "build first: npm run build" >&2; exit 1; }
REPS="${REPS:-3}"; RUNNER="${RUNNER:-claude-code}"
case "$REPS" in ''|*[!0-9]*) echo "REPS must be a number" >&2; exit 2 ;; esac
case "$(uname -s)" in
  Linux) TASKS="${TASKS:-linux-rust linux-elf}"; ARMS="${ARMS:-none leanrea}" ;;
  Darwin) TASKS="${TASKS:-electron native go deep}"; ARMS="${ARMS:-none leanrea rea}" ;;
  *) echo "unsupported platform" >&2; exit 1 ;;
esac
W="${LEANREA_WORK:-$here/work}"
mkdir -p -- "$W/results"
for r in $(seq 1 "$REPS"); do for t in $TASKS; do
  for a in $ARMS; do node "$run" "$a" "$t" "$r" --runner "$RUNNER" --work "$W" "$@" & done; wait
done; done | tee -a "$W/results/run.jsonl"
