/**
 * Smoke test: run the SKILL.md "first move" one-liner for this platform on the
 * system ls binary, in an empty cwd with TMPDIR pointed at a scratch dir.
 * Checks every section header prints, dis.txt is non-empty, the scratch dir
 * came from mktemp under TMPDIR, and nothing was written into the cwd.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { findPackage } from "../src/skill.js";

const pkg = findPackage();
const skill = readFileSync(pkg.skillPath, "utf8");

interface Plan {
  marker: string;
  headers: string[];
  followMarker: string;
  func: (dis: string) => string | undefined;
}

const PLANS: Partial<Record<NodeJS.Platform, Plan>> = {
  linux: {
    marker: "Native, Linux (ELF",
    headers: ["--- HEADER", "--- EXPORTS", "--- STRINGS", "--- FUNCS"],
    followMarker: "Then read one function (FUNC",
    func: (dis) => /^[0-9a-f]+ <([^>]+)>:$/m.exec(dis)?.[1],
  },
  darwin: {
    marker: "Native, macOS (Mach-O",
    headers: ["--- EXPORTS", "--- IMPORTS", "--- STRINGS", "--- FUNCS"],
    followMarker: "Then read one function:",
    func: (dis) => /^([_a-zA-Z][^\s]*):$/m.exec(dis)?.[1],
  },
};

/** The first ```sh block after the line starting with `marker`. */
function blockAfter(marker: string): string {
  const i = skill.indexOf(marker);
  if (i < 0) throw new Error(`SKILL.md: marker not found: ${marker}`);
  const m = /```sh\n([\s\S]*?)\n```/.exec(skill.slice(i));
  if (!m?.[1]) throw new Error(`SKILL.md: no sh block after: ${marker}`);
  return m[1];
}

function fail(msg: string): never {
  console.error(`smoke: FAIL: ${msg}`);
  process.exit(1);
}

const plan = PLANS[process.platform];
if (!plan) {
  console.log(`smoke: skipped (no first move for ${process.platform})`);
  process.exit(0);
}
const target = ["/usr/bin/ls", "/bin/ls"].find((p) => existsSync(p));
if (!target) fail("no ls binary found");

const first = blockAfter(plan.marker);
if (!first.startsWith("T=./bin;")) fail("first move must start with T=./bin;");
const cmd = first.replace("T=./bin;", `T='${target}';`);

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "leanrea-smoke-")));
try {
  const tmp = join(scratch, "tmp");
  const cwd = join(scratch, "cwd");
  mkdirSync(tmp);
  mkdirSync(cwd);
  const env = { ...process.env, TMPDIR: tmp };
  const r = spawnSync("bash", ["-c", cmd], { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  if (r.error) fail(String(r.error));
  const out = r.stdout;
  console.log(out.split("\n").filter((l) => l.startsWith("---") || l.startsWith("D=") || l.includes(target)).join("\n"));
  for (const h of plan.headers) if (!out.includes(`${h}\n`)) fail(`missing section header ${h}\n${r.stderr}`);
  const d = /^D=(.+)$/m.exec(out)?.[1];
  if (!d) fail("first move did not print D=");
  const rel = relative(tmp, d);
  if (rel.startsWith("..") || !rel.startsWith("leanrea.")) fail(`scratch dir ${d} is not a mktemp dir under TMPDIR`);
  const dis = join(d, "dis.txt");
  if (!existsSync(dis) || statSync(dis).size === 0) fail("dis.txt is missing or empty");
  if (readdirSync(cwd).length) fail(`first move wrote into the cwd: ${readdirSync(cwd).join(", ")}`);
  console.log(`dis.txt: ${statSync(dis).size} bytes`);

  const fn = plan.func(readFileSync(dis, "utf8"));
  if (fn) {
    const follow = blockAfter(plan.followMarker)
      .replaceAll("FUNC_LABEL", fn.replace(/[.[\]()*+?^$\\/|{}]/g, "\\$&"))
      .replaceAll("<FUNC>", `<${fn.replace(/[.[\]()*+?^$\\/|{}]/g, "\\$&")}>`);
    const f = spawnSync("bash", ["-c", `D='${d}'; ${follow}`], { cwd, env, encoding: "utf8", timeout: 60_000 });
    if (f.status !== 0) fail(`function slice exited ${f.status}: ${f.stderr}`);
    console.log(`function slice for ${fn}: ok (${f.stdout.split("\n").filter(Boolean).length} line(s))`);
  }
  console.log(`smoke: ok (${process.platform}, ${target})`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
