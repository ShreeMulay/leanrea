/**
 * Tree guard: every tracked file must match an explicit allowlist of this
 * repo's real paths, and no tracked file may exceed MAX_FILE_BYTES. Catches
 * stray scratch output (for example a measurement dir like m-x/strings.txt)
 * before it is committed or released. Run by CI and the release workflow.
 */
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findPackage } from "../src/skill.js";

export const MAX_FILE_BYTES = 128 * 1024;

/** Globs: `*` matches within one path segment, `**` matches across segments. */
export const ALLOWED: readonly string[] = [
  // top-level docs and config
  ".gitignore",
  "CHANGELOG.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  "tsconfig.dev.json",
  "tsconfig.json",
  // CI
  ".github/workflows/*.yml",
  ".github/dependabot.yml",
  // the skill
  "leanrea/SKILL.md",
  // code
  "src/*.ts",
  "scripts/*.ts",
  "test/*.ts",
  "test/fixtures/native/*.c",
  "test/fixtures/native/*.cpp",
  "test/fixtures/parity/*.ts",
  "test/fixtures/parity/tsconfig.json",
  "test/fixtures/releases/*/SKILL.md",
  // bench harness and upstream's historical results
  "bench/*.ts",
  "bench/*.sh",
  "bench/*.py",
  "bench/*.md",
  "bench/tasks.json",
  "bench/results/README.md",
  "bench/results/final.jsonl",
];

/** Named exceptions to the size cap (none needed today). */
export const SIZE_EXCEPTIONS: Readonly<Record<string, number>> = {};

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? "";
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") {
      re += "[^/]*";
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export interface TrackedFile {
  path: string;
  size: number;
}

/** Pure check. Returns a list of problems (empty = ok). */
export function checkTree(files: readonly TrackedFile[], allowed: readonly string[] = ALLOWED, maxBytes = MAX_FILE_BYTES): string[] {
  const res = allowed.map(globToRegExp);
  const errs: string[] = [];
  for (const f of files) {
    if (!res.some((r) => r.test(f.path))) errs.push(`not in the allowlist (scripts/check-tree.ts): ${f.path}`);
    const cap = SIZE_EXCEPTIONS[f.path] ?? maxBytes;
    if (f.size > cap) errs.push(`too large: ${f.path} is ${f.size} B (cap ${cap} B)`);
  }
  return errs;
}

export function trackedFiles(root: string): TrackedFile[] {
  const r = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
  return r.stdout
    .split("\0")
    .filter(Boolean)
    .map((path) => {
      // A tracked path deleted in the worktree but not yet staged has no size to check.
      const st = lstatSync(join(root, path), { throwIfNoEntry: false });
      return { path, size: st ? st.size : 0 };
    });
}

function main(): number {
  const root = findPackage().root;
  const files = trackedFiles(root);
  const errs = checkTree(files);
  if (errs.length) {
    for (const e of errs) process.stderr.write(`check-tree: ${e}\n`);
    process.stderr.write(`check-tree: ${errs.length} problem(s)\n`);
    return 1;
  }
  const total = files.reduce((n, f) => n + f.size, 0);
  process.stdout.write(`check-tree: ok (${files.length} tracked files, ${total} B, max ${MAX_FILE_BYTES} B each)\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
