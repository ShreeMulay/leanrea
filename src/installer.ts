import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsc,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const AGENTS = ["opencode", "claude-code", "codex"] as const;
export type Agent = (typeof AGENTS)[number];
export type Scope = "global" | "project";

export interface InstallEnv {
  home: string;
  xdgConfigHome?: string | undefined;
  cwd: string;
  /** PATH used to look up chezmoi. */
  path: string;
}

export type InstallStatus =
  | "installed"
  | "overwritten"
  | "up-to-date"
  | "would-install"
  | "would-overwrite"
  | "refused"
  | "error";

export interface InstallResult {
  label: string;
  dest: string;
  status: InstallStatus;
  message: string;
}

export interface InstallTarget {
  label: string;
  dest: string;
  /** Set for project scope: the resolved dest must stay inside this dir. */
  containWithin?: string | undefined;
}

export interface InstallOptions {
  dryRun: boolean;
  force: boolean;
}

export function isAgent(x: string): x is Agent {
  return (AGENTS as readonly string[]).includes(x);
}

/** Documented destinations; see README "Agent destinations". */
export function destinationFor(agent: Agent, scope: Scope, env: InstallEnv): string {
  const rel = ["skills", "leanrea", "SKILL.md"];
  if (scope === "project") {
    const dir = agent === "opencode" ? ".opencode" : agent === "claude-code" ? ".claude" : ".agents";
    return join(env.cwd, dir, ...rel);
  }
  switch (agent) {
    case "opencode": {
      // XDG spec: ignore an empty or relative XDG_CONFIG_HOME.
      const xdg = env.xdgConfigHome && isAbsolute(env.xdgConfigHome) ? env.xdgConfigHome : join(env.home, ".config");
      return join(xdg, "opencode", ...rel);
    }
    case "claude-code":
      return join(env.home, ".claude", ...rel);
    case "codex":
      return join(env.home, ".agents", ...rel);
  }
}

function isInside(parent: string, child: string, allowEqual = false): boolean {
  const r = relative(parent, child);
  if (r === "") return allowEqual;
  return !r.startsWith(".." + sep) && r !== ".." && !isAbsolute(r);
}

function lstatOrNull(p: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Returns a refusal reason if dest, or any existing ancestor, is a symlink.
 * Ancestors are checked up to (not including) $HOME when dest is inside HOME,
 * else up to the filesystem root.
 */
export function symlinkProblem(dest: string, home: string): string | null {
  const absHome = resolve(home);
  const stopAt = isInside(absHome, dest) ? absHome : null;
  let p = dest;
  for (;;) {
    if (stopAt !== null && p === stopAt) return null;
    const st = lstatOrNull(p);
    if (st?.isSymbolicLink()) {
      return p === dest ? `destination is a symlink: ${p}` : `ancestor is a symlink: ${p}`;
    }
    const parent = dirname(p);
    if (parent === p) return null;
    p = parent;
  }
}

/** Resolve the deepest existing ancestor with realpath and re-append the rest. */
function resolveExisting(p: string): string {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = dirname(cur);
      if (parent === cur) return p;
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/** Search PATH for an executable named `name`. */
export function which(name: string, pathEnv: string): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const cand = join(dir, name);
    try {
      const st = lstatSync(cand);
      if (!st.isDirectory()) {
        // follow symlinks for the mode check
        const real = realpathSync(cand);
        const rst = lstatSync(real);
        if (rst.isFile() && (rst.mode & 0o111) !== 0) return cand;
      }
    } catch {
      // not here
    }
  }
  return null;
}

/** True if chezmoi is on PATH and reports dest as a managed target. */
export function chezmoiManages(dest: string, pathEnv: string): boolean {
  const bin = which("chezmoi", pathEnv);
  if (!bin) return false;
  const r = spawnSync(bin, ["source-path", dest], {
    stdio: "ignore",
    timeout: 15_000,
    env: { ...process.env, PATH: pathEnv },
  });
  return r.status === 0;
}

function sameBytes(file: string, data: Buffer): boolean {
  return readFileSync(file).equals(data);
}

function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // not supported on every platform/filesystem; best effort
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeTemp(dir: string, data: Buffer): string {
  const tmp = join(dir, `.SKILL.md.leanrea-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o644);
  try {
    let off = 0;
    while (off < data.length) off += writeSync(fd, data, off, data.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return tmp;
}

function safeUnlink(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    // already gone
  }
}

export function installOne(target: InstallTarget, data: Buffer, env: InstallEnv, opts: InstallOptions): InstallResult {
  const dest = resolve(env.cwd, target.dest);
  const r = (status: InstallStatus, message: string): InstallResult => ({ label: target.label, dest, status, message });
  try {
    if (chezmoiManages(dest, env.path)) {
      return r(
        "refused",
        `${dest} is managed by chezmoi; edit the chezmoi source instead (chezmoi source-path "${dest}"), then chezmoi apply`,
      );
    }
    const check = (): InstallResult | null => {
      const sl = symlinkProblem(dest, env.home);
      if (sl) return r("refused", `refusing: ${sl}`);
      if (target.containWithin !== undefined) {
        const root = resolveExisting(target.containWithin);
        const real = resolveExisting(dest);
        if (!isInside(root, real)) return r("refused", `refusing: ${real} is outside the project directory ${root}`);
      }
      return null;
    };
    const bad = check();
    if (bad) return bad;

    const st = lstatOrNull(dest);
    if (st && !st.isFile()) return r("refused", `refusing: destination exists and is not a regular file: ${dest}`);
    if (st && sameBytes(dest, data)) return r("up-to-date", `already up to date: ${dest}`);
    if (st && !opts.force) {
      return r("refused", `refusing to overwrite a different existing file (use --force): ${dest}`);
    }
    if (opts.dryRun) {
      return st ? r("would-overwrite", `dry run: would overwrite ${dest}`) : r("would-install", `dry run: would install ${dest}`);
    }

    const dir = dirname(dest);
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    // Re-check after creating directories, in case something raced us.
    const bad2 = check();
    if (bad2) return bad2;

    const tmp = writeTemp(dir, data);
    try {
      if (opts.force) {
        renameSync(tmp, dest);
      } else {
        // Exclusive: link() fails with EEXIST instead of clobbering.
        try {
          linkSync(tmp, dest);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EEXIST") return r("refused", `refusing: ${dest} appeared while installing (use --force)`);
          if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV" && code !== "ENOSYS") throw e;
          // Filesystem without hard links: exclusive create.
          const fd = openSync(dest, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o644);
          try {
            let off = 0;
            while (off < data.length) off += writeSync(fd, data, off, data.length - off);
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        }
      }
    } finally {
      safeUnlink(tmp);
    }
    fsyncDir(dir);
    return st ? r("overwritten", `overwrote ${dest}`) : r("installed", `installed ${dest}`);
  } catch (e) {
    return r("error", `error: ${(e as Error).message}`);
  }
}

export function isFailure(res: InstallResult): boolean {
  return res.status === "refused" || res.status === "error";
}
