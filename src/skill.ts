import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PackageInfo {
  root: string;
  name: string;
  version: string;
  skillPath: string;
}

/**
 * Walk up from this module until we find the package root: a package.json
 * named "leanrea" next to leanrea/SKILL.md. Works for dist/ (shipped) and
 * build/src/ (tests) layouts alike.
 */
export function findPackage(startDir: string = dirname(fileURLToPath(import.meta.url))): PackageInfo {
  let dir = startDir;
  for (;;) {
    const pkgPath = join(dir, "package.json");
    const skillPath = join(dir, "leanrea", "SKILL.md");
    if (existsSync(pkgPath) && existsSync(skillPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown; version?: unknown };
      if (pkg.name === "leanrea" && typeof pkg.version === "string") {
        return { root: dir, name: pkg.name, version: pkg.version, skillPath };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("leanrea: cannot locate package root (package.json + leanrea/SKILL.md)");
    }
    dir = parent;
  }
}

export function readSkill(info: PackageInfo = findPackage()): Buffer {
  return readFileSync(info.skillPath);
}
