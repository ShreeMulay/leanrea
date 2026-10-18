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
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
if (!n1Line.includes("F='NAME'")) fail(`N1 line for ${process.platform} must set F='NAME'`);
const [n2Dump, n2Xref, n2Func, n2Got] = n2;
if (!n2Dump || !n2Xref?.startsWith("X='<connect@' ") || !n2Func?.startsWith("F='main' ") || !n2Got?.startsWith("G=$(objdump -R ")) {
  fail("N2 block shape changed");
}
const gotCmd = n2Got.replace(/\s+#[^"]*$/, "");
const dumpCmd = isMac ? (/# macOS: (.+)$/.exec(n2Dump)?.[1] ?? fail("N2: no macOS dump command")) : n2Dump.replace(/\s+#.*$/, "");

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "leanrea-smoke-")));
const tmp = join(scratch, "tmp");
const cwd = join(scratch, "cwd");
const bins = join(scratch, "bins");
for (const d of [tmp, cwd, bins]) mkdirSync(d);
const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, npm_config_cache: join(scratch, "npm-cache"), npm_config_update_notifier: "false" };

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

/** Diagnostic only: N2's otool -tV dump file plus its exact F= reader. */
function otoolSlice(bin: string, name: string): Out {
  const d = mkdtempSync(join(tmp, "n1fb-"));
  return sh(`T=${sq(bin)}; D=${sq(d)}; ${dumpCmd}; ${(n2Func ?? "").replace("F='main'", `F=${sq(name)}`)}`, "N1 diagnostic");
}

function n1Run(bin: string, name: string, label: string, mustMatch?: RegExp): string {
  const cmd = `T=${sq(bin)}; ${n1Line.replace("F='NAME'", `F=${sq(name)}`)}`;
  const r = sh(cmd, `N1 (${label})`);
  if (r.status !== 0) fail(`N1 (${label}) exited ${r.status}: ${r.err}`);
  const okInsns = insnCount(r.out) >= 3;
  const okMatch = mustMatch === undefined || mustMatch.test(r.out);
  if (!okInsns || !okMatch) {
    const extra = isMac ? `\n--- otool dump + N2 reader (diagnostic):\n${otoolSlice(bin, name).out}` : "";
    fail(`N1 (${label}) ${okInsns ? `did not match ${mustMatch}` : "printed no instructions"} for ${name}:\n${r.out}${r.err}${extra}`);
  }
  return r.out;
}

const NET_ERR = /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|network|fetch failed|socket hang up/i;

function skipOrFail(what: string, requireVar: string, msg: string): void {
  if (process.env[requireVar] === "1") fail(`${what}: ${msg} (${requireVar}=1, so this is a failure)`);
  console.log(`smoke: SKIPPED ${what}: ${msg}`);
}

function electron(): void {
  let electronBlock: string;
  let e1: string;
  try {
    electronBlock = blockAfter(skill, "Electron (");
    e1 = blockAfter(skill, "E1, Electron IPC");
  } catch (e) {
    fail((e as Error).message);
  }
  if (!electronBlock.startsWith("A=./app.asar;")) fail("Electron first move must start with A=./app.asar;");
  if (!e1.includes('"$X/MAIN.js"')) fail('E1 must reference "$X/MAIN.js"');
  const asarPin = /npx -y (@electron\/asar@\d+\.\d+\.\d+) /.exec(electronBlock)?.[1];
  if (!asarPin) fail("Electron first move has no pinned @electron/asar");

  const ed = join(scratch, "electron");
  const app = join(ed, "app");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "leanrea-smoke-app", version: "1.2.3", main: "main.js" }, null, 2));
  writeFileSync(
    join(app, "main.js"),
    "const { app, BrowserWindow, ipcMain } = require('electron');\n" +
      "ipcMain.handle('demo:ping', () => 'pong');\n" +
      "app.whenReady().then(() => new BrowserWindow({ webPreferences: { preload: __dirname + '/preload.js', contextIsolation: true } }));\n",
  );
  writeFileSync(join(app, "preload.js"), "const { contextBridge, ipcRenderer } = require('electron');\ncontextBridge.exposeInMainWorld('demo', { ping: () => ipcRenderer.invoke('demo:ping') });\n");
  writeFileSync(join(app, "addon.node"), "LEANREA-FAKE-ADDON\n");

  let packed: ReturnType<typeof spawnSync> | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    packed = spawnSync("npx", ["-y", asarPin, "pack", "app", "app.asar", "--unpack", "*.node"], { cwd: ed, env, encoding: "utf8", timeout: 300_000 });
    if (packed.status === 0) break;
    const why = `${String(packed.stderr ?? "")}${String(packed.error ?? "")}`;
    if (!NET_ERR.test(why)) fail(`npx ${asarPin} pack failed:\n${why}`);
    console.log(`npx ${asarPin} pack: network error (attempt ${attempt}): ${why.trim().split("\n")[0]}`);
  }
  if (packed?.status !== 0) {
    skipOrFail("Electron checks", "LEANREA_SMOKE_REQUIRE_NETWORK", `npx ${asarPin} could not be fetched (network)`);
    return;
  }
  if (!existsSync(join(ed, "app.asar.unpacked", "addon.node"))) fail("asar pack --unpack '*.node' did not create app.asar.unpacked/addon.node");

  // The trap: app.asar copied alone can't be extracted (unpacked files are read from beside it).
  const alone = join(ed, "alone");
  mkdirSync(alone);
  copyFileSync(join(ed, "app.asar"), join(alone, "app.asar"));
  const lone = spawnSync("npx", ["-y", asarPin, "extract", join(alone, "app.asar"), join(alone, "x")], { cwd: ed, env, encoding: "utf8", timeout: 300_000 });
  if (lone.status === 0 && existsSync(join(alone, "x", "addon.node"))) fail("extracting app.asar without app.asar.unpacked/ unexpectedly worked; the SKILL.md trap may be stale");
  console.log("ok   Electron trap: app.asar copied without app.asar.unpacked/ does not extract fully");

  // Copy app.asar together with app.asar.unpacked/, as the skill instructs.
  const copy = join(ed, "copy");
  mkdirSync(copy);
  copyFileSync(join(ed, "app.asar"), join(copy, "app.asar"));
  cpSync(join(ed, "app.asar.unpacked"), join(copy, "app.asar.unpacked"), { recursive: true });

  const r = sh(electronBlock.replace("A=./app.asar;", `A=${sq(join(copy, "app.asar"))};`), "Electron first move");
  const d = /^D=(.+)$/m.exec(r.out)?.[1];
  if (!d) fail(`Electron first move did not print D=:\n${r.out}${r.err}`);
  const rel = relative(tmp, d);
  if (rel.startsWith("..") || !rel.startsWith("leanrea.")) fail(`Electron scratch dir ${d} is not a mktemp dir under TMPDIR`);
  const x = join(d, "asar");
  if (which("jq", process.env.PATH ?? "")) {
    if (!/"name": "leanrea-smoke-app"/.test(r.out) || !/"version": "1\.2\.3"/.test(r.out)) fail(`Electron first move did not print name/version:\n${r.out}${r.err}`);
  } else {
    console.log("smoke: SKIPPED Electron name/version assertion: jq not on PATH");
  }
  if (!r.out.split("\n").some((l) => l.endsWith("/preload.js"))) fail(`Electron first move did not list preload.js:\n${r.out}`);
  if (!existsSync(join(x, "addon.node")) || readFileSync(join(x, "addon.node"), "utf8") !== "LEANREA-FAKE-ADDON\n") fail("addon.node missing from the extraction");
  const hits = r.out.split("\n").filter((l) => l.endsWith("/preload.js")).length;
  if (hits < 2) fail(`exposeInMainWorld grep did not report preload.js (find + grep should list it twice):\n${r.out}`);
  console.log(`ok   Electron first move: name/version, preload.js, addon.node from app.asar.unpacked/, exposeInMainWorld`);

  const e = sh(`X=${sq(x)}; ${e1.replaceAll('"$X/MAIN.js"', '"$X/main.js"')}`, "E1");
  if (!e.out.includes("'demo:ping'")) fail(`E1 did not find the single-quoted channel 'demo:ping':\n${e.out}${e.err}`);
  console.log("ok   E1: single-quoted channel 'demo:ping' found");
}

function goWithoutToolchain(): void {
  const go = which("go", process.env.PATH ?? "");
  if (!go) {
    skipOrFail("Go G1 check", "LEANREA_SMOKE_REQUIRE_GO", "go not on PATH");
    return;
  }
  let g1: string[];
  try {
    g1 = blockAfter(skill, "G1, Go without").split("\n");
  } catch (e) {
    fail((e as Error).message);
  }
  if (g1.length < 2 || /\bgo /.test(g1.join("\n"))) fail("G1 must have two lines and not call the go toolchain");
  const gd = join(scratch, "go");
  mkdirSync(gd);
  writeFileSync(join(gd, "go.mod"), "module example.com/leanreaprobe\n\ngo 1.21\n");
  writeFileSync(
    join(gd, "main.go"),
    'package main\n\nimport "fmt"\n\n//go:noinline\nfunc leanreaGoProbe(n int) int { return n*3 + 1 }\n\nfunc main() { fmt.Println("leanrea go probe", leanreaGoProbe(len("x"))) }\n',
  );
  const bin = join(bins, "goprobe");
  const goEnv = { ...env, GOCACHE: join(scratch, "gocache"), GOPATH: join(scratch, "gopath"), GOTOOLCHAIN: "local", GOFLAGS: "-mod=mod", CGO_ENABLED: "0" };
  const b = spawnSync(go, ["build", "-o", bin, "."], { cwd: gd, env: goEnv, encoding: "utf8", timeout: 300_000 });
  if (b.status !== 0) fail(`go build failed:\n${b.stderr}`);
  // PATH with only the tools G1 needs: proves it works without the Go toolchain.
  const shim = join(scratch, "shim");
  mkdirSync(shim);
  for (const t of ["strings", "nm", "grep", "head"]) {
    const p = which(t, process.env.PATH ?? "");
    if (!p) fail(`${t} not on PATH`);
    symlinkSync(p, join(shim, t));
  }
  const noGo = { ...env, PATH: shim };
  const run = (script: string): string => {
    const r = spawnSync("/bin/bash", ["-c", script], { cwd, env: noGo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
    if (readdirSync(cwd).length) fail("G1 wrote into the cwd");
    return r.stdout + r.stderr;
  };
  if (!run("command -v go || echo NO-GO").includes("NO-GO")) fail("go is still reachable in the filtered PATH");
  const l1 = run(`T=${sq(bin)}; ${g1[0]}`);
  if (!/^path\s+example\.com\/leanreaprobe/m.test(l1)) fail(`G1 line 1 did not print the buildinfo path:\n${l1.slice(0, 2000)}`);
  const l2 = run(`T=${sq(bin)}; ${g1[1]}`);
  if (!/main\.main/.test(l2)) fail(`G1 line 2 did not find main.main:\n${l2.slice(0, 2000)}`);
  console.log(`ok   G1 without go on PATH: buildinfo path and main.main (${l2.trim().split("\n").length} main.* symbols)`);
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
    // N1 names: Linux as `nm -C` prints them; macOS (otool -tV labels) as plain `nm` prints them.
    const cName = nmName(cBin, "leanrea_fixture_check", !isMac);
    const cDis = n1Run(cBin, cName, "C", /connect/);
    console.log(`ok   N1 ${cName}: ${insnCount(cDis)} instruction lines, calls connect`);
    const cppName = nmName(cppBin, isMac ? "7Fixture5probe" : "Fixture::probe", !isMac);
    const cppDis = n1Run(cppBin, cppName, "C++");
    console.log(`ok   N1 ${cppName}: ${insnCount(cppDis)} instruction lines`);

    // 4. stripped copy: first move still works; N2 dump + exact xref finds connect via PLT/stub
    firstMove(stripped, "stripped C fixture");
    const xrefCmd = isMac ? n2Xref.replace("X='<connect@'", "X='symbol stub for: _connect'") : n2Xref;
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

    // 5b. -fno-plt (Linux, x86-64 objdump syntax): calls go through the GOT, not the PLT.
    if (!isMac) {
      const np = join(bins, "fixture-c-noplt");
      const nps = join(bins, "fixture-c-noplt-stripped");
      const r = spawnSync(cc, ["-O0", "-rdynamic", "-fno-plt", "-o", np, join(fx, "fixture.c")], { encoding: "utf8" });
      if (r.status !== 0) {
        console.log(`smoke: SKIPPED -fno-plt checks: ${cc} -fno-plt failed: ${r.stderr.trim().split("\n")[0]}`);
      } else {
        copyFileSync(np, nps);
        if (spawnSync("strip", [nps]).status !== 0) fail("strip (-fno-plt) failed");
        const d1 = mkdtempSync(join(tmp, "noplt-"));
        const x1 = sh(`T=${sq(np)}; D=${sq(d1)}; ${dumpCmd}; ${xrefCmd}`, "N2 xref (-fno-plt)");
        if (!/connect@/.test(x1.out)) fail(`N2 xref '<connect@' missed the -fno-plt call:\n${x1.out}${x1.err}`);
        if (/connect@plt/.test(x1.out)) fail("-fno-plt fixture still calls through the PLT");
        console.log(`ok   N2 xref -fno-plt: ${x1.out.trim().split("\n")[0]}`);
        const d2 = mkdtempSync(join(tmp, "noplts-"));
        const x2 = sh(`T=${sq(nps)}; D=${sq(d2)}; ${dumpCmd}; ${gotCmd}`, "N2 GOT slot (-fno-plt, stripped)");
        const slot = spawnSync("bash", ["-c", `objdump -R ${sq(nps)} | grep -w connect`], { encoding: "utf8" }).stdout.trim();
        if (!slot) fail("objdump -R shows no connect relocation in the stripped -fno-plt fixture");
        if (!/call\s+\*.*# [0-9a-f]+ /.test(x2.out)) fail(`GOT-slot grep found no indirect call (slot: ${slot}):\n${x2.out}${x2.err}`);
        console.log(`ok   N2 GOT slot (stripped -fno-plt): ${slot.split(/\s+/)[0]} -> ${x2.out.trim().split("\n")[0]}`);
      }
    }
  }

  // 7. Electron: pack a tiny app with the pinned asar, copy it as the skill says, run the first move and E1.
  electron();

  // 8. Go without the toolchain (G1)
  goWithoutToolchain();

  // 6. the system ls
  const ls = ["/usr/bin/ls", "/bin/ls"].find((p) => existsSync(p));
  if (!ls) fail("no ls binary found");
  firstMove(ls, ls);
  console.log(`smoke: ok (${process.platform})`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
