import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { lintSkill, MAX_BYTES, parseFrontmatter } from "../scripts/lint-skill.js";
import { PKG } from "./helpers.js";

const FM = "---\nname: leanrea\ndescription: x\n---\n\n";
const lint = (s: string): string[] => lintSkill(Buffer.from(s));

describe("lint-skill", () => {
  it("passes the shipped SKILL.md", () => {
    assert.deepEqual(lintSkill(readFileSync(PKG.skillPath), { version: PKG.version }), []);
  });
  it("shipped frontmatter has license, compatibility and OpenCode slash metadata", () => {
    const text = readFileSync(PKG.skillPath, "utf8");
    const fm = parseFrontmatter(/^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "");
    assert.equal(fm.fields.get("license"), "MIT");
    assert.ok((fm.fields.get("compatibility") ?? "").length > 0);
    assert.equal(fm.metadata.get("opencode/slash"), "true");
    assert.equal(fm.metadata.get("version"), PKG.version);
  });
  it("enforces metadata.version == package.json version", () => {
    const f = FM.replace("---\n\n", 'metadata:\n  version: "0.0.1"\n---\n\n');
    assert.deepEqual(lint(f), []);
    assert.deepEqual(lintSkill(Buffer.from(f), { version: "0.0.1" }), []);
    assert.ok(lintSkill(Buffer.from(f), { version: "0.2.0" }).some((e) => /metadata.version/.test(e)));
    assert.ok(lintSkill(Buffer.from(FM), { version: "0.2.0" }).some((e) => /metadata.version/.test(e)));
  });
  it("enforces name, description and compatibility limits", () => {
    assert.ok(lint("---\nname: Leanrea\ndescription: x\n---\n").some((e) => /name/.test(e)));
    assert.ok(lint("---\nname: leanrea\n---\n").some((e) => /description/.test(e)));
    assert.ok(lint(`---\nname: leanrea\ndescription: ${"d".repeat(1025)}\n---\n`).some((e) => /description is 1025/.test(e)));
    assert.deepEqual(lint(`---\nname: leanrea\ndescription: ${"d".repeat(1024)}\n---\n`), []);
    assert.ok(lint(`---\nname: leanrea\ndescription: x\ncompatibility: ${"c".repeat(501)}\n---\n`).some((e) => /compatibility is 501/.test(e)));
  });
  it("rejects frontmatter shapes outside the supported subset", () => {
    assert.ok(lint("---\nname: leanrea\ndescription: a: b\n---\n").some((e) => /needs quoting/.test(e)));
    assert.ok(lint("---\nname: leanrea\ndescription: x\nmetadata:\n  version: 1\n---\n").some((e) => /quoted/.test(e)));
    assert.ok(lint("---\nname: leanrea\ndescription: x\n  stray: \"y\"\n---\n").some((e) => /indented/.test(e)));
    assert.ok(lint("---\nname: leanrea\nname: leanrea\ndescription: x\n---\n").some((e) => /duplicate/.test(e)));
  });
  it("passes a minimal valid file", () => {
    assert.deepEqual(lint(FM + "`npx -y prettier@3.9.10 --parser babel F`\n`npx @electron/asar@4.3.1 extract`\n"), []);
  });
  it("flags oversize files", () => {
    assert.ok(lint(FM + "x".repeat(MAX_BYTES)).some((e) => /exceeds/.test(e)));
  });
  it("flags escaped pipes", () => {
    assert.ok(lint(FM + "| a | `x \\| y` |\n").some((e) => /escaped pipe/.test(e)));
  });
  it("flags $TMPDIR/re", () => {
    assert.ok(lint(FM + "D=$TMPDIR/re/x\n").some((e) => /TMPDIR\/re/.test(e)));
  });
  it("flags unpinned npx", () => {
    for (const bad of ["npx -y prettier --parser", "npx @electron/asar extract", "npx -y foo@latest", "npx -y foo@^1.2.3", "npx foo@1.2"]) {
      assert.ok(lint(FM + bad + "\n").some((e) => /npx must be/.test(e)), bad);
    }
  });
  it("flags missing frontmatter name", () => {
    assert.ok(lint("# no frontmatter\n").some((e) => /frontmatter/.test(e)));
    assert.ok(lint("---\nname: other\n---\n").some((e) => /name: leanrea/.test(e)));
  });
});
