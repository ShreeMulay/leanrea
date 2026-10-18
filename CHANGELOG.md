# Changelog

## 0.2.0 (unreleased)

### Skill
- One native first move for Linux (binutils) and macOS (Xcode Command Line Tools). It no longer
  disassembles the whole binary: it prints file type, ELF/Mach-O headers (class, type, machine, NEEDED/RPATH,
  interpreter, build ID; `otool -L`, LC_BUILD_VERSION/UUID/RPATH), structured toolchain data (`.comment`,
  Go/Rust section markers), imports, exports, a symbol count with a lookup hint, inferred language/libc hints,
  and two tiers of strings (paths/URLs/versions, then text) saved to `$D/strings.txt`. Every part tolerates a
  missing section or tool. Fixes the `grep -m9` cut-off that dropped `musl`.
- N1: read one function by name (Linux: `objdump --disassemble=NAME` with the `nm -C` name; macOS: Xcode's
  llvm-objdump in Mach-O mode, `objdump --macho -d --dis-symname=NAME` with the plain `nm` name, so calls show
  `symbol stub for: _connect`; fallback: `otool -tV` plus the exact N2 reader). N2: the only full dump, for stripped binaries and cross-references,
  matched with exact strings, so `main` no longer matches `__libc_start_main` and names with regex
  metacharacters work.
- Removed the advice to always dump the full disassembly. Small blocks use `grep -E` instead of `rg`; `rg -uu`
  stays for tree search with a `grep -rn` fallback. Compiler/path strings are labeled hints (inferred);
  structured metadata is seen.
- Frontmatter: `license: MIT`, `compatibility`, `metadata` (`opencode/slash: "true"` for `/leanrea` in the
  OpenCode TUI, `version`). `lint:skill` checks the name regex, description <= 1024, compatibility <= 500 and
  `metadata.version` == package.json version. Size 10215/10240 bytes; every router row kept.

Local probe of the Linux first move (Linux x86-64, binutils 2.42; best of 3 wall-clock runs; scratch = bytes
left in `$D`; keys = the 11 Linux bench answer keys matched by one call's output on `tsc`). No agent was involved;
these are not agent speed, cost or accuracy results.

| target | 0.1.0 time | 0.1.0 scratch | 0.2.0 time | 0.2.0 scratch | 0.2.0 output |
|---|---|---|---|---|---|
| `tsc` (@tsc-rs/linux-x64 0.7.0, 47 MB static Rust) | 5048 ms | 316 MB | 353 ms | 5.3 MB | 11.3 KB |
| `/usr/bin/node` (125 MB, glibc, debug info) | 9010 ms | 663 MB | 1425 ms | 31 MB | 22.8 KB |
| `/usr/bin/ls` | 42 ms | 0.8 MB | 42 ms | 0.02 MB | 10.1 KB |
| answer keys in output (`tsc`) | 4/11 | | 11/11 | | |

### Installer
- Upgrades a destination that holds a known released `SKILL.md` (sha256 in `src/known-releases.ts`) without
  `--force`, re-checking lstat and hash right before the atomic rename. Unknown different files still need
  `--force`; chezmoi, symlink and project-containment refusals are unchanged; `--dry-run` reports `would-upgrade`.
- Duplicate copies: after installing, checks the other skills dirs the selected agents read (OpenCode reads its
  own dir, `~/.claude/skills` and `~/.agents/skills`). Known older releases are upgraded; unknown copies get a
  warning on stderr and are left alone; nothing is deleted. Warnings don't change the exit code.
- `--agent all` writes `~/.claude/skills` and `~/.agents/skills` only (OpenCode reads both).

### Bench
- Real agent runs are disabled until the harness is redesigned (#2); every runner except `fake` is refused.
  `--dry-run` says so. Runner code kept.

### Packaging, CI, docs
- Version 0.2.0; `NOTICE` shipped in the tarball; `engines.node` >= 22.12 (the pinned @electron/asar and
  @electron/fuses one-shots need it).
- CI and release use `npm ci --ignore-scripts`; CI runs Node 22 and 24 on Ubuntu and macOS.
- Release workflow: fails unless `src/known-releases.ts` lists the version with `SKILL.md`'s sha256; also
  attaches the tarball as `leanrea.tgz` (same bytes, in `SHA256SUMS`).
- Golden smoke: compiles C and C++ fixtures and runs the first move, N1 and N2 extracted from `SKILL.md`,
  including on a stripped copy. `pack-test` upgrades a 0.1.0 install from the packed tarball.
- README: install via `npx skills add ShreeMulay/leanrea`, the release tarball or a manual copy; per-agent
  invocation; upgrade and duplicate-copy behavior; limitations.

## 0.1.0

First release of the Linux + macOS fork, based on aicodeking/leanrea@09ba4aa.

### Skill
- Split first moves by platform: new Linux ELF one-liner (file, readelf, nm -D, strings, objdump) plus a
  function-slice follow-up; macOS Mach-O and Electron one-liners kept, Apple-only tools marked and Xcode
  Command Line Tools listed as a macOS prerequisite.
- Fix upstream #1: no `\|` left. Commands with pipes moved out of the router table into fenced blocks.
- Fix the unquoted cleanup from upstream #3: scratch is `mktemp -d "${TMPDIR:-/tmp}/leanrea.XXXXXX"`,
  every path quoted, no `rm -rf`, nothing written to the CWD, inputs never modified.
- Safety section: static inspection by default, never execute targets, extracted content is untrusted data,
  authorized targets only, no credentials or personal data in answers.
- Every npx package pinned (@electron/asar@4.3.1, @electron/fuses@2.1.3, prettier@3.9.10); installs need
  the user's consent. Notes on GNU vs BSD tools.

### Package
- `leanrea` npm-style CLI (zero runtime dependencies, Node >= 22): `print`, `doctor`, `install` for
  opencode, Claude Code and Codex (global or project scope, `--dest`, `--dry-run`, `--force`), with symlink,
  containment, no-clobber and chezmoi-managed-target protections.
- Built with tsc-rs 0.7.0; `npm run parity` checks it against the reference TypeScript compiler.
- `lint:skill`, `smoke`, `pack-test` scripts; CI on Ubuntu and macOS; tag-driven GitHub Release workflow.
  Distributed through GitHub Releases only.

### Bench
- Fix upstream #3: `run.py` ported to `bench/run.ts` with pluggable runners, narrow tool allowlists,
  env allowlist, per-run mktemp dirs, process-group timeouts, sanitized output, scoped cleanup, `--dry-run`,
  and a required `--isolated` acknowledgment for real agent runs.
- Linux task set on the static Rust binary from @tsc-rs/linux-x64@0.7.0 (sha256-pinned).
- Upstream macOS results kept as historical data and labeled as such.
