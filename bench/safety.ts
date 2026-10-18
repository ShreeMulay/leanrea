import { lstatSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

/** Strip ANSI/VT escape sequences and other control characters (keeps \n and \t), then cap the size. */
export function sanitize(text: string, maxBytes = 64 * 1024): string {
  const clean = text
    // CSI, OSC (BEL or ST terminated), and single-char ESC sequences
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "")
    .replace(/\u009b[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
  const buf = Buffer.from(clean, "utf8");
  if (buf.length <= maxBytes) return clean;
  // Cut on a UTF-8 boundary.
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8") + `\n[truncated ${buf.length - end} bytes]`;
}

export function isStrictlyInside(root: string, p: string): boolean {
  const r = relative(root, p);
  return r !== "" && r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r);
}

/**
 * Remove `target` recursively only if, after realpath, it is strictly inside
 * the realpath of `root`, and `target` itself is not a symlink. Throws otherwise.
 */
export function safeRemove(root: string, target: string): void {
  if (!isAbsolute(root) || !isAbsolute(target)) throw new Error(`safeRemove: paths must be absolute: ${root}, ${target}`);
  const st = lstatSync(target, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isSymbolicLink()) throw new Error(`safeRemove: refusing to remove a symlink: ${target}`);
  const realRoot = realpathSync(root);
  const realTarget = realpathSync(target);
  if (!isStrictlyInside(realRoot, realTarget)) {
    throw new Error(`safeRemove: refusing to remove ${realTarget}: not inside the bench work root ${realRoot}`);
  }
  rmSync(realTarget, { recursive: true, force: true });
}

/** Env vars every runner may receive. Everything else is dropped unless a runner or --pass-env adds it. */
export const BASE_ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ"] as const;

export function filterEnv(
  source: NodeJS.ProcessEnv,
  allow: readonly string[],
  overrides: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of allow) {
    const v = source[k];
    if (v !== undefined) out[k] = v;
  }
  return { ...out, ...overrides };
}
