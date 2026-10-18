# Changelog

## 0.1.0 (unreleased)

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
