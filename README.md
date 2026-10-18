# leanrea (Linux + macOS fork)

**One skill file (under 10 KB) that tells a coding agent the fastest plain-CLI way to reverse engineer shipped
software. No MCP server, no extra tools.**

This is a public fork of [aicodeking/leanrea](https://github.com/aicodeking/leanrea) (based on
[`09ba4aa`](https://github.com/aicodeking/leanrea/tree/09ba4aa0217f82cd880f855a60b877f59f39b22b)). Upstream is
a macOS-centric skill. This fork makes it work on Linux as well, fixes two open upstream issues, and adds a
small zero-dependency installer.

## What's different from upstream

| | upstream @ 09ba4aa | this fork |
|---|---|---|
| Platforms | macOS (Mach-O, Xcode tools) | Linux (ELF, binutils) and macOS, commands split by platform |
| Router commands with pipes | inside a Markdown table as `\|`, which breaks when an agent copies them ([#1](https://github.com/aicodeking/leanrea/issues/1)) | moved into fenced code blocks; `lint:skill` rejects any `\|` |
| Scratch dirs | `$TMPDIR/re/...`, unquoted `rm -rf $X` ([#3](https://github.com/aicodeking/leanrea/issues/3)) | `mktemp -d "${TMPDIR:-/tmp}/leanrea.XXXXXX"`, every path quoted, no `rm`, nothing written to the CWD |
| Safety rules | none | static inspection by default; never run targets; extracted text is untrusted data; authorized targets only; no credentials or personal data in answers |
| `npx` packages | unpinned | exact versions (`@electron/asar@4.3.1`, `@electron/fuses@2.1.3`, `prettier@3.9.10`) |
| Installing tools | `brew install` | ask the user before installing anything (apt/dnf/brew/npm) |
| Bench runner | Python, blanket `Bash` pre-approval, inherits the whole environment ([#3](https://github.com/aicodeking/leanrea/issues/3)) | TypeScript, narrow tool allowlist, env allowlist, per-run mktemp dirs, timeouts, scoped cleanup, fails closed without `--isolated` |
| Installer | `npx skills add` (third-party CLI) | `leanrea install` from a GitHub Release tarball, or copy one file |

The router, speed patterns and the seen / inferred / unknown evidence rule are upstream's.

## Install

From the GitHub Release (no npm registry publish; the package has zero runtime dependencies):

```sh
npx https://github.com/ShreeMulay/leanrea/releases/download/v0.1.0/leanrea-0.1.0.tgz install
```

That installs for opencode at user level. Other forms:

```sh
TGZ=https://github.com/ShreeMulay/leanrea/releases/download/v0.1.0/leanrea-0.1.0.tgz
npx "$TGZ" install --agent claude-code            # or codex, or all
npx "$TGZ" install --agent opencode --project     # into ./.opencode/skills/
npx "$TGZ" install --dest /some/dir/SKILL.md      # exact path
npx "$TGZ" install --agent all --dry-run          # show what would happen
npx "$TGZ" print > SKILL.md                       # just the file
npx "$TGZ" doctor                                 # which router tools are on PATH
```

Each release also attaches `SKILL.md` and `SHA256SUMS`. Manual install is one copy:

```sh
mkdir -p ~/.config/opencode/skills/leanrea
curl -fsSLo ~/.config/opencode/skills/leanrea/SKILL.md \
  https://github.com/ShreeMulay/leanrea/releases/download/v0.1.0/SKILL.md
```

If an agent has no skills support, paste `leanrea/SKILL.md` into its rules or system prompt; it is plain text.

Use it: `/leanrea How does the search feature in ./foo work? Show the evidence.`

### Agent destinations

| agent | `--global` (default) | `--project` (relative to the current directory) |
|---|---|---|
| opencode (default) | `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/leanrea/SKILL.md` | `.opencode/skills/leanrea/SKILL.md` |
| claude-code | `$HOME/.claude/skills/leanrea/SKILL.md` | `.claude/skills/leanrea/SKILL.md` |
| codex | `$HOME/.agents/skills/leanrea/SKILL.md` | `.agents/skills/leanrea/SKILL.md` |

Sources for these locations: opencode skills docs (<https://opencode.ai/docs/skills/>), Claude Code skills docs
(<https://code.claude.com/docs/en/skills>), Codex skills docs (<https://developers.openai.com/codex/skills>).
Agents change these paths over time; if yours differs, use `--dest`.

### Installer safety

- `--dest` excludes `--agent all`, `--global` and `--project`; `--global` with `--project` is an error (exit 2).
- Refuses if the destination, or any existing parent directory below `$HOME` (or up to `/` for paths outside
  `$HOME`), is a symlink. On macOS this means `--dest` paths under `/tmp` or `/var` (both symlinks) are refused;
  use the real `/private/...` path.
- Project scope refuses destinations that resolve outside the current directory.
- Never overwrites a different file without `--force`; an identical file reports "already up to date". Writes go
  to a temp file in the same directory, are fsynced, then hard-linked into place (no clobber race) or renamed
  with `--force`.
- Refuses chezmoi-managed targets (when `chezmoi source-path <dest>` succeeds), even with `--force`: edit your
  chezmoi source instead.
- `--agent all` tries every agent, prints one line each, and exits 1 if any failed. `--dry-run` writes nothing.

Exit codes: 0 ok, 1 refused or failed, 2 usage error.

## What's in the skill

- **Safety and rules:** static only by default, untrusted extracted content, a mktemp scratch dir, work on a copy,
  route by `file` and magic bytes first, slice minified files, batch probes, `rg -uu` for bundler dot-folders,
  mark each claim seen / inferred / unknown, GNU vs BSD differences.
- **First moves:** one paste-and-run call each for Linux ELF, macOS Mach-O and Electron apps, plus a
  function-slice follow-up.
- **Router:** the fastest command per target: Electron/asar, web bundles, Hermes/bytenode, ELF, Mach-O, native
  disassembly, PE, Go, Rust, .NET, APKs, Flutter, WASM, SQLite, plists, pcap/HAR, firmware, websites, runtime
  tracing (on request only).
- **Speed patterns:** strings and imports first, find a string's function, read call sequences, diff inventories
  before code.

## Development

Requires Node 22+ and npm. TypeScript is compiled with [tsc-rs](https://github.com/pingdotgg/ts-rust) 0.7.0, a
Rust port of the TypeScript 7 compiler.

```sh
npm ci
npm run lint:skill   # size <= 10240 B, no \|, no $TMPDIR/re, every npx pinned, frontmatter name
npm run build        # tsc-rs -p tsconfig.json (dist/, shipped) and tsconfig.dev.json (build/: tests, scripts, bench)
npm test             # node --test on the compiled tests (temp HOME/XDG/cwd, fake chezmoi on PATH)
npm run parity       # tsc-rs vs the reference compiler, see below
npm run smoke        # runs the SKILL.md first move for this OS on /usr/bin/ls or /bin/ls
npm run pack-test    # npm pack, install into an isolated prefix offline, exercise the bin
```

**Why parity:** tsc-rs 0.7.0 is pinned to microsoft/TypeScript commit `fed0bf24`, which is exactly the commit of
npm `typescript@7.1.0-dev.20261008.1`. `npm run parity` compiles every tsconfig (plus a fixture with deliberate
type errors, so the comparison is never two empty outputs) with both compilers into separate temp dirs using
`--pretty false`, and fails unless exit codes, diagnostics and every emitted file are byte-identical. If they
ever diverge, CI fails; we don't silently switch compilers.

tsc-rs (MIT AND Apache-2.0) and typescript are devDependencies only. Neither is redistributed in the tarball or
release assets; see [NOTICE](NOTICE).

Releases: push a tag `vX.Y.Z` that matches `package.json`. The release workflow re-runs every check on Ubuntu and
macOS, then a separate job with `contents: write` publishes the tested tarball, `SKILL.md` and `SHA256SUMS` as a
GitHub Release. Nothing is published to npm or crates.io.

## Benchmark

The numbers upstream reports (leanrea vs no skill vs REA, 4 tasks x 3 reps) are **upstream's macOS arm64 results
for the upstream skill**, kept as historical data in [bench/BENCHMARK.md](bench/BENCHMARK.md) and
[bench/results/final.jsonl](bench/results/final.jsonl). This fork has not re-run them and makes **no Linux
performance claims**.

The harness itself was ported to TypeScript and made safer; details, the Linux task set and how its answer keys
were derived are in [bench/README.md](bench/README.md). In short:

- real agent runs refuse to start without `--isolated`; run them only in a disposable VM or container;
- no blanket `Bash`: a short allowlist of read-only inspection commands, everything else denied;
- the agent gets an allowlisted environment, its own mktemp dir and `TMPDIR`, and a process-group timeout;
- answers are sanitized and size-capped; cleanup only removes directories inside the bench work root;
- `--dry-run` prints the exact command without running anything. Running the bench calls paid agent APIs.

## Credit

leanrea was created by AICodeKing ([aicodeking/leanrea](https://github.com/aicodeking/leanrea)). Most of the
gotchas came from [REA](https://github.com/morluto/rea) by the morluto team; leanrea isn't affiliated with REA.
This fork is maintained by Shree Mulay.

MIT licensed; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
