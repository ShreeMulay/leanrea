/**
 * Release gate (run by .github/workflows/release.yml): the version being
 * released must be listed in src/known-releases.ts with the sha256 of
 * leanrea/SKILL.md, and must not be marked UNRELEASED. Optional argument: the
 * tag (vX.Y.Z), which must equal v + package.json version.
 */
import { readFileSync } from "node:fs";
import { KNOWN_RELEASES, sha256, UNRELEASED } from "../src/known-releases.js";
import { findPackage } from "../src/skill.js";

const pkg = findPackage();
const hash = sha256(readFileSync(pkg.skillPath));
const tag = process.argv[2];
const problems: string[] = [];
if (tag !== undefined && tag !== `v${pkg.version}`) problems.push(`tag ${tag} does not match package.json version v${pkg.version}`);
if (UNRELEASED === pkg.version) problems.push(`${pkg.version} is still marked UNRELEASED in src/known-releases.ts`);
if (KNOWN_RELEASES[pkg.version] !== hash) {
  problems.push(`src/known-releases.ts lists ${KNOWN_RELEASES[pkg.version] ?? "nothing"} for ${pkg.version}; leanrea/SKILL.md is ${hash}`);
}
if (problems.length) {
  for (const p of problems) console.error(`check-release: ${p}`);
  process.exitCode = 1;
} else {
  console.log(`check-release: ok (${pkg.version}, SKILL.md sha256 ${hash})`);
}
