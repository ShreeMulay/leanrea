# leanrea bench harness

TypeScript port of upstream's `run.py`, with upstream issue #3 fixed. Historical numbers in
[BENCHMARK.md](BENCHMARK.md) and [results/final.jsonl](results/final.jsonl) are **upstream's macOS
results** (aicodeking/leanrea@09ba4aa). This fork has not re-run them and makes no Linux performance claims.

## Status: real agent runs are disabled

`run.ts` refuses every runner except `fake`, and `ctx.sh` exits before doing anything, with an error pointing to
[issue #2](https://github.com/ShreeMulay/leanrea/issues/2), even with `--isolated`. `--dry-run` still prints the
exact plan (with `"real_run_disabled": true`), and the `fake` runner still exercises the harness in tests. The
runner code is kept for the redesign. Reasons:

- **The allowlist blocks the skill itself.** The `claude-code`/`opencode` runners pre-approve a short list of
  command prefixes and deny everything else, but leanrea's first move is one batched shell call that uses
  `grep`, `awk`, `sed`, `tr`, `sort`, braces and a background job. Those are denied, so the `leanrea` arm would be
  measured with its own commands blocked.
- **Real HOME and agent config leak in.** The env allowlist passes the real `HOME` (and XDG dirs for opencode),
  so a run sees the operator's own skills, config, plugins and credentials. Arms are not comparable and a run
  can read or change files outside the run dir.
- **`--isolated` is an honor flag.** It records that you say you are in a disposable VM; the harness does not
  create or verify any isolation.

Until the redesign lands, this fork publishes no agent speed, cost or accuracy numbers.

## Files

| file | what |
|---|---|
| `tasks.json` | Task prompts and regex answer keys. Upstream's four tasks are kept verbatim and marked `"platform": "macos"`. Two Linux tasks are added. |
| `run.ts` | Runs one cell: `node build/bench/run.js <none or leanrea or rea> <task> <rep> [flags]` (built by `npm run build`). |
| `runners.ts` | Pluggable runners: `claude-code`, `opencode`, `fake` (tests only). |
| `grader.ts` | Pure grader: every key is a case-insensitive regex that must match the answer. |
| `safety.ts` | Output sanitizer, env allowlist, scoped `safeRemove`. |
| `setup.sh` | Prepares the work root (`linux` or `macos`, optional `--with-rea`). |
| `run_all.sh` | All tasks x arms x `REPS` for this platform. |
| `ctx.sh` | Context-overhead probe (Claude Code). Disabled: exits 1 with the issue #2 message before creating anything or starting a process. |
| `mcp_list.py` | Upstream tool that sizes an MCP server's `tools/list` (REA). Unchanged. |

## Linux task set

Target: the native ELF binary `package/lib/tsc` from npm `@tsc-rs/linux-x64@0.7.0` (a Rust build of the
TypeScript 7 compiler). `setup.sh linux` downloads it with `npm pack`, checks the tarball sha256
`afb78de146a42b369d9a0e2588d5925da9546d29572e5249bf9f330858ea04ee` and the binary sha256
`fb9223ad1f59392ca225dc4c1a76664e07f146bc5f22c91a13ade6b2f7c217cc`, and stores it read-only (mode 0444) as
`work/targets/tsc`. It is never executed.

Keys were derived by static inspection only:

| task | key | value | evidence |
|---|---|---|---|
| linux-rust | language | Rust | `/rustc/<hash>` paths and `.comment` |
| linux-rust | compiler | rustc 1.95.0 | `readelf -p .comment tsc` shows `rustc version 1.95.0 (59807616e 2026-04-14)` |
| linux-rust | commit | `59807616e1fa2540724bfbac14d7976d7e4a3860` | `strings -a tsc` then `rg -o '/rustc/[0-9a-f]{40}'` (one unique hash) |
| linux-rust | crates | bumpalo 3.20.3, flate2 1.1.10, tikv-jemalloc-ctl 0.7.0 | `strings -a tsc` then `rg -o '[a-z0-9_-]+-[0-9]+\.[0-9]+\.[0-9]+/src'` |
| linux-elf | class/arch | ELF64, x86-64 | `readelf -hW tsc` |
| linux-elf | linking | statically linked, no NEEDED | `file tsc`; `readelf -dW` prints "no dynamic section"; no INTERP segment in `readelf -lW` |
| linux-elf | libc | musl | musl-only symbols `__init_libc` / `__libc_start_init` in `nm tsc`; `libc::unix::linux_like::linux::musl` in a mangled symbol; no glibc strings |
| linux-elf | build id | `b40b93b641f5e1cbbe90bd578bf7fe78d6677690` | `readelf -nW tsc` |

## Safety (upstream issue #3)

- **Real runs are disabled** (see Status above). Before that, real agent runs refused to start without
  `--isolated` (or `LEANREA_BENCH_ISOLATED=1`); that check is kept behind the new refusal.
- **No blanket Bash.** The `claude-code` runner limits built-in tools with `--tools Bash,Read,Grep,Glob,Skill`,
  pre-approves only read-only inspection prefixes (`Bash(readelf:*)`, `Bash(nm:*)`, ...; see
  `CLAUDE_BASH_PREFIXES` in `runners.ts`), denies everything else with `--permission-mode dontAsk`, and
  disallows `Write,Edit,NotebookEdit,WebFetch,WebSearch`. `find`, `awk`, `rg`, `sed`, `xargs` and shells
  are left out because they can run other programs. The `opencode` runner writes an `opencode.json` into the
  run dir with the same allowlist (`"*": "deny"`, edits and webfetch denied). These flags match the
  `claude --help` / `opencode run --help` output observed on 2026-10-18; neither runner has been exercised
  against a live agent in this fork.
- **Env allowlist.** The agent gets only `PATH HOME USER LOGNAME SHELL LANG LC_ALL LC_CTYPE TERM TZ`, a
  private `TMPDIR` inside the run dir, plus what its CLI needs:
  - claude-code: `ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CONFIG_DIR ENABLE_TOOL_SEARCH`
  - opencode: `XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME ANTHROPIC_API_KEY OPENAI_API_KEY`
  - anything else only via an explicit `--pass-env NAME`.
- **One mktemp dir per run** under `<work>/runs/`; targets are copied in (reflink where supported), never
  modified in place.
- **Timeout** (`--timeout SEC`, default 1500) kills the agent's whole process group (SIGTERM, then
  SIGKILL after 5 s). Leftover group members are reaped when the agent exits.
- **Sanitized output.** Answers have ANSI/control characters stripped and are capped at 64 KB; results go to
  `<work>/results/<run>.json`.
- **Scoped cleanup.** `--clean` and `setup.sh` remove only real directories strictly inside the work root,
  after realpath checks; symlinks and the root itself are refused. All shell paths are quoted.
- **Untrusted content.** Strings and code in targets are data, never instructions (also stated in SKILL.md).

## Usage

```sh
npm ci && npm run build
bench/setup.sh linux                                   # downloads the target, checks sha256
node build/bench/run.js leanrea linux-rust 1 --dry-run # prints the plan, runs nothing
node build/bench/run.js leanrea linux-rust 1 --isolated # refused: real runs are disabled (issue #2)
```

The macOS tasks need `bench/setup.sh macos` on a Mac with Notion.app and Homebrew `gh`; their keys match
Notion 7.35.1 and a `gh` built with go1.27.1. The `rea` arm needs `--with-rea` and the `claude-code` runner.
