/**
 * Compiler parity gate: build every tsconfig*.json with tsc-rs and with the
 * reference compiler (typescript@7.1.0-dev.20261008.1, the exact commit tsc-rs
 * 0.7.0 is pinned to) into separate temp outDirs. Fails unless diagnostics,
 * exit codes and the emitted trees are byte-identical, and something was emitted.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPackage } from "../src/skill.js";

const root = findPackage().root;
const bin = (n: string): string => join(root, "node_modules", ".bin", n);

function walk(dir: string, rel = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    const r = rel ? `${rel}/${e}` : e;
    const st = lstatSync(p);
    if (st.isDirectory()) for (const [k, v] of walk(p, r)) out.set(k, v);
    else out.set(r, createHash("sha256").update(readFileSync(p)).digest("hex"));
  }
  return out;
}

interface Run {
  status: number | null;
  diag: string;
  files: Map<string, string>;
}

function compile(compiler: string, config: string, outDir: string): Run {
  const r = spawnSync(bin(compiler), ["-p", config, "--outDir", outDir, "--pretty", "false"], {
    cwd: root,
    encoding: "utf8",
    timeout: 300_000,
  });
  if (r.error) throw r.error;
  return { status: r.status, diag: (r.stdout + r.stderr).replaceAll(outDir, "<OUT>"), files: walk(outDir) };
}

/** Fixture with deliberate type errors: must produce diagnostics, so the comparison is not "both empty". */
const FIXTURE = "test/fixtures/parity/tsconfig.json";
const configs = [...readdirSync(root).filter((f) => /^tsconfig(\..+)?\.json$/.test(f)).sort(), FIXTURE];
const versions = [bin("tsc-rs"), bin("tsc")].map((b) => spawnSync(b, ["--version"], { encoding: "utf8" }).stdout.trim());
console.log(`parity: tsc-rs "${versions[0]}" vs tsc "${versions[1]}"; configs: ${configs.join(", ")}`);

let failed = false;
const scratch = mkdtempSync(join(tmpdir(), "leanrea-parity-"));
try {
  for (const cfg of configs) {
    const a = compile("tsc-rs", cfg, join(scratch, cfg, "tsc-rs"));
    const b = compile("tsc", cfg, join(scratch, cfg, "tsc"));
    const problems: string[] = [];
    if (a.status !== b.status) problems.push(`exit codes differ: tsc-rs=${a.status} tsc=${b.status}`);
    if (a.diag !== b.diag) problems.push(`diagnostics differ:\n--- tsc-rs\n${a.diag}\n--- tsc\n${b.diag}`);
    const keys = new Set([...a.files.keys(), ...b.files.keys()]);
    for (const k of [...keys].sort()) {
      if (a.files.get(k) !== b.files.get(k)) problems.push(`emit differs: ${k} (tsc-rs ${a.files.get(k) ?? "missing"}, tsc ${b.files.get(k) ?? "missing"})`);
    }
    if (a.files.size === 0) problems.push("nothing was emitted; parity on an empty tree proves nothing");
    const diagLines = a.diag.split("\n").filter(Boolean).length;
    if (cfg === FIXTURE && diagLines === 0) problems.push("fixture produced no diagnostics; expected deliberate errors");
    if (problems.length) {
      failed = true;
      console.error(`FAIL ${cfg}:\n  ${problems.join("\n  ")}`);
    } else {
      console.log(`ok   ${cfg}: exit ${a.status}, ${diagLines} diagnostic line(s) identical, ${a.files.size} emitted file(s) byte-identical`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
if (failed) {
  console.error("parity: FAILED (tsc-rs and tsc diverge; do not switch compilers without owner approval)");
  process.exitCode = 1;
} else {
  console.log("parity: ok");
}
