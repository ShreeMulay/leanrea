import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { KNOWN_RELEASES, knownReleaseOf, sha256, UNRELEASED } from "../src/known-releases.js";
import { PKG } from "./helpers.js";

describe("known releases", () => {
  it("lists the published 0.1.0 SKILL.md", () => {
    assert.equal(KNOWN_RELEASES["0.1.0"], "b339328030986eacb37d3dde96383699ae23e3cbcc8835631505b17bf79306d6");
    const v010 = readFileSync(join(PKG.root, "test", "fixtures", "releases", "0.1.0", "SKILL.md"));
    assert.equal(knownReleaseOf(v010), "0.1.0");
  });

  it("current SKILL.md is listed for the package version, or the version is marked UNRELEASED", () => {
    const h = sha256(readFileSync(PKG.skillPath));
    if (UNRELEASED === PKG.version) {
      assert.equal(KNOWN_RELEASES[PKG.version], undefined, "a listed version can't also be UNRELEASED");
      return;
    }
    assert.equal(
      KNOWN_RELEASES[PKG.version],
      h,
      `leanrea/SKILL.md (sha256 ${h}) is not listed for ${PKG.version} in src/known-releases.ts; update the hash or set UNRELEASED`,
    );
  });

  it("hashes are unique lowercase sha256", () => {
    const vals = Object.values(KNOWN_RELEASES);
    for (const v of vals) assert.match(v, /^[0-9a-f]{64}$/);
    assert.equal(new Set(vals).size, vals.length);
  });

  it("unknown bytes are not a release", () => {
    assert.equal(knownReleaseOf(Buffer.from("x")), undefined);
  });
});
