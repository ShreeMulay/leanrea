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
| Bench runner | Python, blanket `Bash` pre-approval, inherits the whole environment ([#3](https://github.com/aicodeking/leanrea/issues/3)) | TypeScript harness; real agent runs disabled until a redesign ([#2](https://github.com/ShreeMulay/leanrea/issues/2)) |
| Installer | `npx skills add` (third-party CLI) | `npx skills add` still works; plus `leanrea install` from a GitHub Release tarball (safe upgrades, duplicate-copy checks), or copy one file |

The router, speed patterns and the seen / inferred / unknown evidence rule are upstream's.

## Install

Pick one. All three put the same single file, `leanrea/SKILL.md`, where your agent looks for skills.

**1. skills CLI** (third-party, reads this repo; lists exactly one skill, `leanrea`):

```sh
npx skills add ShreeMulay/leanrea
```

**2. Release tarball** (this repo's installer; zero runtime dependencies, no npm registry publish, Node >= 22.12):

```sh
npx https://github.com/ShreeMulay/leanrea/releases/download/v0.2.0/leanrea-0.2.0.tgz install
```

That installs for OpenCode at user level. Other forms:

```sh
TGZ=https://github.com/ShreeMulay/leanrea/releases/download/v0.2.0/leanrea-0.2.0.tgz
npx "$TGZ" install --agent claude-code            # or codex, or all
npx "$TGZ" install --agent opencode --project     # into ./.opencode/skills/
npx "$TGZ" install --dest /some/dir/SKILL.md      # exact path
npx "$TGZ" install --agent all --dry-run          # show what would happen
npx "$TGZ" print > SKILL.md                       # just the file
npx "$TGZ" doctor                                 # which router tools are on PATH
```

Use the versioned URL with `npx`. Each release also attaches the same tarball as `leanrea.tgz`
(`.../releases/latest/download/leanrea.tgz`), but npx caches URL specs by URL: in a local test (npm 10.9.9),
serving a newer tarball at the same URL still ran the first one from the npx cache. That stable name is for
`curl` and scripts that download and verify it themselves.

**3. Manual copy.** Each release attaches `SKILL.md` and `SHA256SUMS`:

```sh
mkdir -p ~/.claude/skills/leanrea
curl -fsSLo ~/.claude/skills/leanrea/SKILL.md \
  https://github.com/ShreeMulay/leanrea/releases/download/v0.2.0/SKILL.md
```

If an agent has no skills support, paste `leanrea/SKILL.md` into its rules or system prompt; it is plain text.

### Using it

| agent | how to invoke |
|---|---|
| OpenCode | `/leanrea How does the search feature in ./foo work?` (the frontmatter sets `metadata: opencode/slash: "true"`, which adds `/leanrea` to the TUI), or just ask; the agent loads skills by description. |
| Claude Code | `/leanrea How does the search feature in ./foo work?`, or just ask. |
| Codex | Ask, or name the skill in your prompt (`use the leanrea skill to ...`). Codex reads `~/.agents/skills` and selects skills by description; see the Codex skills docs for explicit invocation. |

The frontmatter also carries `license`, `compatibility` (tools needed) and `metadata.version`. Claude Code accepts
and ignores those fields.

### Agent destinations

| agent | `--global` (default) | `--project` (relative to the current directory) |
|---|---|---|
| opencode (default) | `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/leanrea/SKILL.md` | `.opencode/skills/leanrea/SKILL.md` |
| claude-code | `$HOME/.claude/skills/leanrea/SKILL.md` | `.claude/skills/leanrea/SKILL.md` |
| codex | `$HOME/.agents/skills/leanrea/SKILL.md` | `.agents/skills/leanrea/SKILL.md` |

`--agent all` writes the claude-code and codex rows only: OpenCode reads `~/.claude/skills` and `~/.agents/skills`
(and `.claude/skills`, `.agents/skills` in a project) as well as its own dir, so one copy each serves all three.

Sources for these locations: opencode skills docs (<https://opencode.ai/docs/skills/>), Claude Code skills docs
(<https://code.claude.com/docs/en/skills>), Codex skills docs (<https://developers.openai.com/codex/skills>).
Agents change these paths over time; if yours differs, use `--dest`.

### Upgrades and duplicate copies

- **Upgrades.** If the destination holds the exact bytes of a released `SKILL.md` (sha256 listed in
  [`src/known-releases.ts`](src/known-releases.ts)), `install` replaces it without `--force` and reports
  `upgraded`. A file that differs from every release (for example one you edited) is refused unless you pass
  `--force`. `--dry-run` reports `would-upgrade`.
- **Duplicates.** OpenCode finds skills in three dirs and, when more than one has a `leanrea`, keeps whichever
  copy it scans last, without a warning. So after installing, `install` also looks at the other dirs the selected
  agents read: an older released copy there is upgraded the same safe way (`upgraded ... (also read by opencode)`);
  any other copy gets a warning on stderr with its path and is left alone. Nothing is ever deleted.
- **Exit code.** 0 when every target is installed, upgraded or up to date, even with warnings about other
  copies; 1 when a target was refused or failed; 2 for usage errors.

### Installer safety

- `--dest` excludes `--agent all`, `--global` and `--project`; `--global` with `--project` is an error (exit 2).
  `--dest` installs exactly one file and skips the duplicate check.
- Refuses if the destination, or any existing parent directory below `$HOME` (or up to `/` for paths outside
  `$HOME`), is a symlink. On macOS this means `--dest` paths under `/tmp` or `/var` (both symlinks) are refused;
  use the real `/private/...` path.
- Project scope refuses destinations that resolve outside the current directory.
- Writes go to a temp file in the same directory and are fsynced. A new file is hard-linked into place (no
  clobber race). An upgrade re-checks the destination (lstat and sha256) right before the atomic rename and
  refuses if it changed in between. `--force` renames over the destination.
- Refuses chezmoi-managed targets (when `chezmoi source-path <dest>` succeeds), even with `--force`: edit your
  chezmoi source instead.

**Limitations:** skills dirs reached through a symlinked parent (for example a dotfiles-managed `~/.claude`
symlink) are refused, not followed; there is no `uninstall` (delete the `leanrea` dir yourself).

## What's in the skill

- **Safety and rules:** static only by default, untrusted extracted content, a mktemp scratch dir, work on a copy,
  route by `file` and magic bytes first, slice minified files, batch probes, `rg -uu` for bundler dot-folders,
  mark each claim seen / inferred / unknown, GNU vs BSD differences.
- **First moves:** one paste-and-run call for native binaries (Linux ELF with binutils, macOS Mach-O with Xcode
  tools) that inventories headers, toolchain, imports, exports, symbols and strings without disassembling, and
  one for Electron apps. Then one function by name (N1), or a full dump only for stripped binaries and xrefs
  (N2).
- **Router:** the fastest command per target: Electron/asar, web bundles, Hermes/bytenode, ELF, Mach-O, native
  disassembly, PE, Go, Rust, .NET, APKs, Flutter, WASM, SQLite, plists, pcap/HAR, firmware, websites, runtime
  tracing (on request only).
- **Speed patterns:** strings and imports first, find a string's function, read call sequences, diff inventories
  before code.

## Development

Requires Node >= 22.12 and npm. TypeScript is compiled with [tsc-rs](https://github.com/pingdotgg/ts-rust) 0.7.0, a
Rust port of the TypeScript 7 compiler.

```sh
npm ci --ignore-scripts  # tsc-rs's postinstall only speeds up its launcher; CI skips it
npm run lint:skill   # size <= 10240 B, no \|, no $TMPDIR/re, npx pinned, frontmatter (name, description <= 1024,
                     # compatibility <= 500, metadata.version == package.json version)
npm run build        # tsc-rs -p tsconfig.json (dist/, shipped) and tsconfig.dev.json (build/: tests, scripts, bench)
npm test             # node --test on the compiled tests (temp HOME/XDG/cwd, fake chezmoi on PATH)
npm run parity       # tsc-rs vs the reference compiler, see below
npm run smoke        # golden smoke: compiles C/C++ fixtures and runs the SKILL.md blocks on them, then on ls
npm run pack-test    # npm pack, install offline into an isolated prefix, exercise the bin, upgrade a 0.1.0 copy
npm run check-release  # the version is listed in src/known-releases.ts with SKILL.md's sha256
```

`npm run smoke` extracts the native first move and blocks N1/N2 from `SKILL.md` itself, compiles
`test/fixtures/native/fixture.c` and `fixture.cpp` with `cc`/`c++`, and checks that the first move reports the
`connect` import, the socket path string and the `leanrea_fixture_check` symbol; that N1 shows the call to
`connect` and disassembles the demangled C++ method; that a stripped copy still works and N2 finds the `connect`
call through the PLT/stub; and that nothing is written to the current directory.

**Why parity:** tsc-rs 0.7.0 is pinned to microsoft/TypeScript commit `fed0bf24`, which is exactly the commit of
npm `typescript@7.1.0-dev.20261008.1`. `npm run parity` compiles every tsconfig (plus a fixture with deliberate
type errors, so the comparison is never two empty outputs) with both compilers into separate temp dirs using
`--pretty false`, and fails unless exit codes, diagnostics and every emitted file are byte-identical. If they
ever diverge, CI fails; we don't silently switch compilers.

tsc-rs (MIT AND Apache-2.0) and typescript are devDependencies only. Neither is redistributed in the tarball or
release assets; see [NOTICE](NOTICE).

Releases: add the new `SKILL.md` sha256 to `src/known-releases.ts`, then push a tag `vX.Y.Z` that matches
`package.json`. The release workflow checks both, re-runs every check on Ubuntu and macOS, then a separate job with
`contents: write` publishes the tested tarball (as `leanrea-X.Y.Z.tgz` and `leanrea.tgz`), `SKILL.md` and
`SHA256SUMS` as a GitHub Release. Nothing is published to npm or crates.io.

## Benchmark

The numbers upstream reports (leanrea vs no skill vs REA, 4 tasks x 3 reps) are **upstream's macOS arm64 results
for the upstream skill**, kept as historical data in [bench/BENCHMARK.md](bench/BENCHMARK.md) and
[bench/results/final.jsonl](bench/results/final.jsonl). This fork makes **no agent speed, cost or accuracy
claims**.

Real agent runs in this fork's harness are **disabled** until it is redesigned
([#2](https://github.com/ShreeMulay/leanrea/issues/2)): its command allowlist blocks the skill's own first-move
commands, runs see the real `HOME` and agent config, and `--isolated` is only an honor flag. `bench/run.js` refuses
every runner except the test-only `fake` one; `--dry-run` still prints the plan. Details, the Linux task set and how
its answer keys were derived are in [bench/README.md](bench/README.md).

The only numbers this release reports are local probe timings of the native first move itself (no agent
involved); see [CHANGELOG.md](CHANGELOG.md).

## Credit

leanrea was created by AICodeKing ([aicodeking/leanrea](https://github.com/aicodeking/leanrea)). Most of the
gotchas came from [REA](https://github.com/morluto/rea) by the morluto team; leanrea isn't affiliated with REA.
This fork is maintained by Shree Mulay.

MIT licensed; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
