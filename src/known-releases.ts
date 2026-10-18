import { createHash } from "node:crypto";

/**
 * sha256 of leanrea/SKILL.md as shipped in each GitHub Release. The installer
 * upgrades an existing copy without --force only if its bytes match one of
 * these. The release workflow (scripts/check-release.js) fails unless the
 * version being released is listed here with the hash of leanrea/SKILL.md,
 * and test/known-releases.test.ts fails if the current SKILL.md is neither
 * listed for the current version nor that version is marked UNRELEASED.
 *
 * Add the new version's hash in the same commit that finalizes SKILL.md for a
 * release; never edit or remove a published entry.
 */
export const KNOWN_RELEASES: Readonly<Record<string, string>> = Object.freeze({
  "0.1.0": "b339328030986eacb37d3dde96383699ae23e3cbcc8835631505b17bf79306d6",
  "0.2.0": "d6bd96e093b7ea06aa78c9dffb1cbe65ae5da8eb4b633ccd5ad3ad6c7616df00",
});

/**
 * Set to the package version while SKILL.md is still changing for a release
 * that is not yet listed in KNOWN_RELEASES; null otherwise.
 */
export const UNRELEASED: string | null = null;

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The release whose SKILL.md has exactly these bytes, if any. */
export function knownReleaseOf(data: Buffer): string | undefined {
  const h = sha256(data);
  return Object.keys(KNOWN_RELEASES).find((v) => KNOWN_RELEASES[v] === h);
}
