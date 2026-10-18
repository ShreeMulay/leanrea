/**
 * Golden smoke test. Every command run here is EXTRACTED FROM leanrea/SKILL.md,
 * so the doc and the test can't drift apart.
 *
 * 1. Compile test/fixtures/native/fixture.c and fixture.cpp with cc / c++ into a
 *    scratch dir (skipped with a message if no compiler is found).
 * 2. Run the native first move on the C fixture and assert it reports the
 *    connect import, the socket path string and the leanrea_fixture_check symbol.
 * 3. Run block N1 (one function by name) on leanrea_fixture_check and on the
 *    demangled C++ method; assert a call to connect / real instructions.
 * 4. Strip a copy: the first move must still succeed, and block N2 (full dump +
 *    exact-string xref) must find the connect call through the PLT/stub.
 * 5. Block N2's exact function reader: `main` must not match __libc_start_main,
 *    and a C++ name with regex metacharacters must work.
 * 6. Run the first move on the system ls.
 * Every run uses an empty cwd (must stay empty), TMPDIR pointed at a scratch
 * dir, and must print D= pointing at a mktemp dir under that TMPDIR.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { which } from "../src/installer.js";
import { findPackage } from "../src/skill.js";

const pkg = findPackage();
const skill = readFileSync(pkg.skillPath, "utf8");
const isMac = process.platform === "darwin";

function fail(msg: string): never {
  console.error(`smoke: FAIL: ${msg}`);
  process.exit(1);
}

/** The first ```sh block after the line containing `marker`. */
function blockAfter(text: string, marker: string): string {
  const i = text.indexOf(marker);
  if (i < 0) throw new Error(`SKILL.md: marker not found: ${marker}`);
  const m = /```sh\n([\s\S]*?)\n```/.exec(text.slice(i));
  if (!m?.[1]) throw new Error(`SKILL.md: no sh block after: ${marker}`);
  return m[1];
}

const sq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

if (process.platform !== "linux" && !isMac) {
  console.log(`smoke: skipped (no first move for ${process.platform})`);
  process.exit(0);
}

let first: string;
let n1: string[];
let n2: string[];
try {
  first = blockAfter(skill, "Native binary (");
  n1 = blockAfter(skill, "N1, one function").split("\n");
  n2 = blockAfter(skill, "N2, stripped or xrefs").split("\n");
} catch (e) {
  fail((e as Error).message);
}
if (!first.startsWith("T=./bin;")) fail("first move must start with T=./bin;");
if (/objdump -d|otool -tV/.test(first)) fail("first move must not disassemble");
const n1Line: string = n1[isMac ? 1 : 0] ?? "";
if (!n1Line.startsWith("F='NAME';")) fail(`N1 line for ${process.platform} must start with F='NAME';`);
const [n2Dump, n2Xref, n2Func] = n2;
if (!n2Dump || !n2Xref?.startsWith("X='<connect@plt>' ") || !n2Func?.startsWith("F='main' ")) fail("N2 block shape changed");
const dumpCmd = isMac ? (/# macOS: (.+)$/.exec(n2Dump)?.[1] ?? fail("N2: no macOS dump command")) : n2Dump.replace(/\s+#.*$/, "");

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "leanrea-smoke-")));
const tmp = join(scratch, "tmp");
const cwd = join(scratch, "cwd");
const bins = join(scratch, "bins");
for (const d of [tmp, cwd, bins]) mkdirSync(d);
const env = { ...process.env, TMPDIR: tmp };

interface Out {
  status: number | null;
  out: string;
  err: string;
}

function sh(script: string, label: string): Out {
  const r = spawnSync("bash", ["-c", script], { cwd, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 300_000 });
  if (r.error) fail(`${label}: ${String(r.error)}`);
  const left = readdirSync(cwd);
  if (left.length) fail(`${label} wrote into the cwd: ${left.join(", ")}`);
  return { status: r.status, out: r.stdout, err: r.stderr };
}

const HEADERS = isMac
  ? ["--- MACHO", "--- TOOLCHAIN", "--- IMPORTS", "--- EXPORTS", "--- HINTS", "--- SYMBOLS", "--- STRINGS (signals)", "--- STRINGS (text)"]
  : ["--- ELF", "--- TOOLCHAIN", "--- IMPORTS", "--- EXPORTS", "--- HINTS", "--- SYMBOLS", "--- STRINGS (signals)", "--- STRINGS (text)"];

/** Run the first move on `target`; returns stdout and the scratch dir it printed. */
function firstMove(target: string, label: string): { out: string; d: string } {
  const r = sh(first.replace("T=./bin;", `T=${sq(target)};`), `first move (${label})`);
  if (r.status !== 0) fail(`first move (${label}) exited ${r.status}\n${r.err}`);
  for (const h of HEADERS) if (!r.out.includes(h)) fail(`first move (${label}): missing section ${h}\n${r.out.slice(0, 2000)}`);
  const d = /^D=(.+)$/m.exec(r.out)?.[1];
  if (!d) fail(`first move (${label}) did not print D=`);
  const rel = relative(tmp, d);
  if (rel.startsWith("..") || !rel.startsWith("leanrea.")) fail(`scratch dir ${d} is not a mktemp dir under TMPDIR`);
  if (existsSync(join(d, "dis.txt"))) fail(`first move (${label}) wrote a disassembly`);
  console.log(`ok   first move (${label}): ${r.out.length} bytes of output, D under TMPDIR, cwd untouched`);
  return { out: r.out, d };
}

/** Text between `--- NAME` and the next `--- ` header. */
function section(out: string, name: string): string {
  const i = out.indexOf(`--- ${name}`);
  if (i < 0) return "";
  const rest = out.slice(i + 4 + name.length);
  const j = rest.indexOf("\n--- ");
  return j < 0 ? rest : rest.slice(0, j);
}

/** The symbol name as `nm -C` (or plain `nm`) prints it for the first line containing `needle`. */
function nmName(bin: string, needle: string, demangle: boolean): string {
  const r = spawnSync("nm", demangle ? ["-C", bin] : [bin], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  for (const line of r.stdout.split("\n")) {
    const m = /^[0-9a-fA-F]*\s+[A-Za-z]\s+(.+)$/.exec(line);
    if (m?.[1] && m[1].includes(needle)) return m[1];
  }
  fail(`nm${demangle ? " -C" : ""} ${bin}: no symbol containing ${needle}`);
}

const insnCount = (s: string): number => s.split("\n").filter((l) => /^\s*[0-9a-f]+:?\s/.test(l)).length;

function n1Run(bin: string, name: string, label: string, rawNeedle: string): string {
  const cmd = `T=${sq(bin)}; ${n1Line.replace("F='NAME';", `F=${sq(name)};`)}`;
  const r = sh(cmd, `N1 (${label})`);
  if (r.status !== 0) fail(`N1 (${label}) exited ${r.status}: ${r.err}`);
  if (insnCount(r.out) < 3) {
    let extra = "";
    if (isMac) {
      const fb = sh(`otool -tV -p ${sq(nmName(bin, rawNeedle, false))} ${sq(bin)} | head -40`, "otool fallback");
      extra = `\n--- otool fallback (diagnostic):\n${fb.out}${fb.err}`;
    }
    fail(`N1 (${label}) printed no instructions for ${name}:\n${r.out}${r.err}${extra}`);
  }
  return r.out;
}

try {
  const cc = which("cc", process.env.PATH ?? "");
  const cxx = which("c++", process.env.PATH ?? "");
  const fx = join(pkg.root, "test", "fixtures", "native");
  if (!cc || !cxx) {
    console.log(`smoke: SKIPPED fixture checks: ${!cc ? "cc" : "c++"} not found on PATH (CI has both)`);
  } else {
    const cBin = join(bins, "fixture-c");
    const cppBin = join(bins, "fixture-cpp");
    const stripped = join(bins, "fixture-c-stripped");
    // -rdynamic: export leanrea_fixture_check from the ELF executable (Mach-O exports globals by default).
    const ccArgs = ["-O0", ...(isMac ? [] : ["-rdynamic"]), "-o", cBin, join(fx, "fixture.c")];
    for (const [c, args] of [
      [cc, ccArgs],
      [cxx, ["-O0", "-o", cppBin, join(fx, "fixture.cpp")]],
    ] as const) {
      const r = spawnSync(c, args, { encoding: "utf8" });
      if (r.status !== 0) fail(`${c} ${args.join(" ")} failed: ${r.stderr}`);
    }
    copyFileSync(cBin, stripped);
    const st = spawnSync("strip", [stripped], { encoding: "utf8" });
    if (st.status !== 0) fail(`strip failed: ${st.stderr}`);
    console.log(`compiled fixtures with ${cc} and ${cxx}; stripped a copy`);

    // 2. first move on the C fixture
    const c = firstMove(cBin, "C fixture");
    if (!/(^|[\s_])connect(\s|$)/m.test(section(c.out, "IMPORTS"))) fail(`IMPORTS lacks connect:\n${section(c.out, "IMPORTS")}`);
    if (!c.out.includes("/tmp/leanrea-fixture.sock")) fail("first move output lacks the socket path string");
    if (!c.out.includes("leanrea_fixture_check")) fail("first move output lacks the leanrea_fixture_check symbol");
    console.log("ok   C fixture: connect import, socket path string and leanrea_fixture_check symbol present");

    // 3. N1 on the C function and the demangled C++ method
    const cName = nmName(cBin, "leanrea_fixture_check", true);
    const cDis = n1Run(cBin, cName, "C", "leanrea_fixture_check");
    if (!/connect/.test(cDis)) fail(`N1 (C): no call to connect in:\n${cDis}`);
    console.log(`ok   N1 ${cName}: ${insnCount(cDis)} instruction lines, calls connect`);
    const cppName = nmName(cppBin, "Fixture::probe", true);
    const cppDis = n1Run(cppBin, cppName, "C++", "probe");
    console.log(`ok   N1 ${cppName}: ${insnCount(cppDis)} instruction lines`);

    // 4. stripped copy: first move still works; N2 dump + exact xref finds connect via PLT/stub
    firstMove(stripped, "stripped C fixture");
    const xrefCmd = isMac ? n2Xref.replace("X='<connect@plt>'", "X='symbol stub for: _connect'") : n2Xref;
    const sd = mkdtempSync(join(tmp, "n2-"));
    const x = sh(`T=${sq(stripped)}; D=${sq(sd)}; ${dumpCmd}; ${xrefCmd}`, "N2 xref (stripped)");
    if (x.status !== 0 || !/connect/.test(x.out)) fail(`N2 xref on the stripped binary found no connect call:\n${x.out}${x.err}`);
    console.log(`ok   N2 stripped xref: ${x.out.trim().split("\n").length} connect call site(s)`);

    // 5. N2 exact function reader: no substring hits, regex metacharacters are literal
    const ud = mkdtempSync(join(tmp, "n2u-"));
    const dumped = sh(`T=${sq(cBin)}; D=${sq(ud)}; ${dumpCmd}`, "N2 dump (C)");
    if (dumped.status !== 0) fail(`N2 dump failed: ${dumped.err}`);
    const mainName = isMac ? "_main" : "main";
    const fn = sh(`D=${sq(ud)}; ${n2Func.replace("F='main'", `F=${sq(mainName)}`)}`, "N2 func (main)");
    if (insnCount(fn.out) < 3 || !/leanrea_fixture_check/.test(fn.out)) fail(`N2 reader did not print main (calling leanrea_fixture_check):\n${fn.out}`);
    if (/libc_start_main/.test(fn.out) && !isMac) {
      // main itself never calls __libc_start_main; seeing it means _start was matched.
      fail(`N2 reader matched more than main:\n${fn.out}`);
    }
    const none = sh(`D=${sq(ud)}; ${n2Func.replace("F='main'", "F='ain'")}`, "N2 func (substring)");
    if (none.out.trim() !== "") fail(`N2 reader matched a substring ('ain'):\n${none.out}`);
    if (!isMac) {
      const pd = mkdtempSync(join(tmp, "n2p-"));
      sh(`T=${sq(cppBin)}; D=${sq(pd)}; ${dumpCmd}`, "N2 dump (C++)");
      const meta = sh(`D=${sq(pd)}; ${n2Func.replace("F='main'", `F=${sq(cppName)}`)}`, "N2 func (C++)");
      if (insnCount(meta.out) < 3) fail(`N2 reader found nothing for ${cppName}:\n${meta.out}`);
      const dot = sh(`D=${sq(pd)}; ${n2Func.replace("F='main'", `F=${sq(cppName.replace("(", "."))}`)}`, "N2 func (metachar)");
      if (dot.out.trim() !== "") fail("N2 reader treated '.' as a regex wildcard");
    }
    console.log("ok   N2 reader: exact match (main only, no substring hits, metacharacters literal)");
  }

  // 6. the system ls
  const ls = ["/usr/bin/ls", "/bin/ls"].find((p) => existsSync(p));
  if (!ls) fail("no ls binary found");
  firstMove(ls, ls);
  console.log(`smoke: ok (${process.platform})`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
