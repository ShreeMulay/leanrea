import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkTree, globToRegExp, MAX_FILE_BYTES, trackedFiles } from "../scripts/check-tree.js";
import { PKG } from "./helpers.js";

describe("check-tree", () => {
  it("the real tree passes", () => {
    assert.deepEqual(checkTree(trackedFiles(PKG.root)), []);
  });

  it("rejects stray scratch output", () => {
    const errs = checkTree([
      { path: "src/cli.ts", size: 10 },
      { path: "m-x/strings.txt", size: 10 },
      { path: "first.sh", size: 10 },
      { path: "bench/work/targets/tsc", size: 10 },
    ]);
    assert.equal(errs.length, 3);
    for (const p of ["m-x/strings.txt", "first.sh", "bench/work/targets/tsc"]) assert.ok(errs.some((e) => e.includes(p)), p);
  });

  it("rejects an oversized file even if allowlisted", () => {
    const errs = checkTree([{ path: "src/big.ts", size: MAX_FILE_BYTES + 1 }]);
    assert.equal(errs.length, 1);
    assert.match(errs[0] ?? "", /too large: src\/big\.ts/);
    assert.deepEqual(checkTree([{ path: "src/ok.ts", size: MAX_FILE_BYTES }]), []);
  });

  it("globs: * stays in one segment, ** crosses segments, dots are literal", () => {
    assert.ok(globToRegExp("src/*.ts").test("src/a.ts"));
    assert.ok(!globToRegExp("src/*.ts").test("src/x/a.ts"));
    assert.ok(globToRegExp("a/**").test("a/b/c.txt"));
    assert.ok(!globToRegExp("LICENSE").test("LICENSEx"));
    assert.ok(!globToRegExp("bench/tasks.json").test("bench/tasksXjson"));
  });
});
