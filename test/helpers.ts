import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPackage } from "../src/skill.js";

export const PKG = findPackage();
export const CLI = join(PKG.root, "dist", "cli.js");

export interface Sandbox {
  root: string;
  home: string;
  xdg: string;
  proj: string;
  outside: string;
  bin: string;
  cleanup(): void;
}

const FAKE_CHEZMOI = `#!/bin/sh
# fake chezmoi for tests: "managed" iff $2 starts with $FAKE_CHEZMOI_MANAGED
[ "$1" = source-path ] || exit 2
if [ -n "$FAKE_CHEZMOI_MANAGED" ]; then
  case "$2" in "$FAKE_CHEZMOI_MANAGED"*) echo "/fake-source/$2"; exit 0 ;; esac
fi
echo "chezmoi: not managed" >&2
exit 1
`;

export function sandbox(): Sandbox {
  // realpath: macOS tmpdir lives under /var -> /private/var (a symlink).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "leanrea-test-")));
  const home = join(root, "home");
  const xdg = join(root, "xdg");
  const proj = join(home, "proj");
  const outside = join(root, "outside");
  const bin = join(root, "bin");
  for (const d of [home, xdg, proj, outside, bin]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, "chezmoi"), FAKE_CHEZMOI);
  chmodSync(join(bin, "chezmoi"), 0o755);
  return { root, home, xdg, proj, outside, bin, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export interface RunResult {
  status: number | null;
  stdout: Buffer;
  stderr: string;
  out: string;
}

export function run(
  sb: Sandbox,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; xdg?: boolean } = {},
): RunResult {
  const env: Record<string, string> = {
    HOME: sb.home,
    PATH: [sb.bin, "/usr/bin", "/bin"].join(":"),
    ...(opts.xdg === false ? {} : { XDG_CONFIG_HOME: sb.xdg }),
    ...opts.env,
  };
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: opts.cwd ?? sb.proj, env, timeout: 30_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr.toString(), out: r.stdout.toString() + r.stderr.toString() };
}

/** Recursive listing of all paths (files and dirs) under dir. */
export function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const r = rel ? `${rel}/${e}` : e;
      out.push(r);
      if (lstatSync(p).isDirectory()) walk(p, r);
    }
  };
  walk(dir, "");
  return out.sort();
}
