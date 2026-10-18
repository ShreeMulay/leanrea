/**
 * Pack test: npm pack -> check the file list -> install the tarball into an
 * isolated temp prefix (temp HOME, temp npm cache/userconfig, offline, no
 * devDependencies) -> exercise the installed `leanrea` bin.
 *
 * LEANREA_PACK_OUT=<dir>: copy the tested tarball there (used by release.yml).
 */
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { KNOWN_RELEASES, sha256 } from "../src/known-releases.js";
import { findPackage } from "../src/skill.js";

const pkg = findPackage();
const skill = readFileSync(pkg.skillPath);
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

function fail(msg: string): never {
  console.error(`pack-test: FAIL: ${msg}`);
  process.exit(1);
}

function sh(cmd: string, args: string[], opts: SpawnSyncOptions & { allowFail?: boolean } = {}): { status: number | null; stdout: Buffer; out: string } {
  const r = spawnSync(cmd, args, { timeout: 180_000, ...opts });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  const stdout = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(String(r.stdout ?? ""));
  const out = stdout.toString() + String(r.stderr ?? "");
  if (!opts.allowFail && r.status !== 0) fail(`${cmd} ${args.join(" ")} exited ${r.status}\n${out}`);
  return { status: r.status, stdout, out };
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "leanrea-pack-")));
try {
  const packDir = join(scratch, "pack");
  const home = join(scratch, "home");
  const prefix = join(scratch, "prefix");
  const stub = join(scratch, "stub");
  for (const d of [packDir, home, prefix, stub]) mkdirSync(d);
  // A chezmoi stub that manages nothing, so a host chezmoi cannot interfere.
  writeFileSync(join(stub, "chezmoi"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(stub, "chezmoi"), 0o755);

  const npmEnv = {
    HOME: home,
    PATH: [stub, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    npm_config_cache: join(scratch, "npm-cache"),
    npm_config_userconfig: join(scratch, "npmrc"),
    npm_config_globalconfig: join(scratch, "npmrc-global"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };

  // 1. pack (from the repo, with the real environment for npm itself)
  const packed = sh(npmCmd, ["pack", "--json", "--pack-destination", packDir], { cwd: pkg.root, encoding: "utf8" });
  const info = JSON.parse(packed.stdout.toString()) as Array<{ filename: string; files: Array<{ path: string }> }>;
  const entry = info[0];
  if (!entry) fail("npm pack returned no entries");
  const expectedName = `leanrea-${pkg.version}.tgz`;
  if (entry.filename !== expectedName) fail(`tarball name ${entry.filename} != ${expectedName}`);
  const tarball = join(packDir, entry.filename);
  const files = entry.files.map((f) => f.path).sort();
  console.log(`packed ${entry.filename}: ${files.join(", ")}`);
  const allowed = (f: string): boolean =>
    ["package.json", "leanrea/SKILL.md", "LICENSE", "NOTICE", "README.md"].includes(f) || /^dist\/[a-z-]+\.js$/.test(f);
  const extra = files.filter((f) => !allowed(f));
  if (extra.length) fail(`unexpected files in tarball: ${extra.join(", ")}`);
  for (const must of ["package.json", "leanrea/SKILL.md", "LICENSE", "NOTICE", "README.md", "dist/cli.js", "dist/known-releases.js"]) {
    if (!files.includes(must)) fail(`tarball is missing ${must}`);
  }
  if (files.some((f) => /test/.test(f))) fail("tarball contains test files");

  // 2. install into an isolated prefix, offline, without devDependencies
  sh(npmCmd, ["install", "--global", "--prefix", prefix, "--omit=dev", "--offline", "--no-audit", "--no-fund", tarball], {
    cwd: scratch,
    env: npmEnv,
    encoding: "utf8",
  });
  const libRoot = existsSync(join(prefix, "lib", "node_modules")) ? join(prefix, "lib", "node_modules") : join(prefix, "node_modules");
  const installed = join(libRoot, "leanrea");
  if (existsSync(join(installed, "node_modules"))) fail("installed package has node_modules (expected zero runtime deps)");
  if (readdirSync(libRoot).filter((n) => !n.startsWith(".")).join(",") !== "leanrea") fail(`unexpected packages in prefix: ${readdirSync(libRoot).join(",")}`);
  const bin = join(prefix, "bin", "leanrea");
  if (!existsSync(bin)) fail(`bin not found at ${bin}`);

  const runEnv = { HOME: home, PATH: npmEnv.PATH };
  const run = (args: string[]): { status: number | null; stdout: Buffer; out: string } => sh(bin, args, { cwd: scratch, env: runEnv });

  // 3. exercise the installed bin
  const v = run(["--version"]).out.trim();
  if (v !== pkg.version) fail(`--version printed ${v}, expected ${pkg.version}`);
  console.log(`leanrea --version: ${v}`);

  if (!run(["print"]).stdout.equals(skill)) fail("print output differs from leanrea/SKILL.md");
  console.log("leanrea print: byte-identical to SKILL.md");

  const dest = join(home, ".config", "opencode", "skills", "leanrea", "SKILL.md");
  const dry = run(["install", "--agent", "opencode", "--global", "--dry-run"]);
  if (!/would install/.test(dry.out)) fail(`dry run output unexpected: ${dry.out}`);
  if (existsSync(join(home, ".config"))) fail("dry run created files");
  console.log(`dry run: ${dry.out.trim()}`);

  const real = run(["install", "--agent", "opencode", "--global"]);
  console.log(`install: ${real.out.trim()}`);
  if (!existsSync(dest) || !readFileSync(dest).equals(skill)) fail(`installed file at ${dest} differs from SKILL.md`);
  const again = run(["install", "--agent", "opencode", "--global"]);
  if (!/already up to date/.test(again.out)) fail(`second install not up to date: ${again.out}`);

  // 4. upgrade a v0.1.0 install (the released bytes, kept as a test fixture) without --force
  const v010 = readFileSync(join(pkg.root, "test", "fixtures", "releases", "0.1.0", "SKILL.md"));
  if (sha256(v010) !== KNOWN_RELEASES["0.1.0"]) fail("test/fixtures/releases/0.1.0/SKILL.md is not the released 0.1.0 file");
  const ccDest = join(home, ".claude", "skills", "leanrea", "SKILL.md");
  mkdirSync(dirname(ccDest), { recursive: true });
  writeFileSync(ccDest, v010);
  const up = run(["install", "--agent", "claude-code", "--global"]);
  console.log(`upgrade from 0.1.0: ${up.out.trim()}`);
  if (!/upgraded: upgraded .* from leanrea 0\.1\.0/.test(up.out)) fail(`expected an upgrade from 0.1.0: ${up.out}`);
  if (!readFileSync(ccDest).equals(skill)) fail("upgraded file differs from SKILL.md");
  const edited = Buffer.concat([v010, Buffer.from("\nlocal edit\n")]);
  writeFileSync(ccDest, edited);
  const refused = sh(bin, ["install", "--agent", "claude-code", "--global"], { cwd: scratch, env: runEnv, allowFail: true });
  if (refused.status !== 1 || !readFileSync(ccDest).equals(edited)) fail(`an edited 0.1.0 file must be refused without --force: ${refused.out}`);
  console.log("edited 0.1.0 copy: refused without --force, left untouched");

  const outDir = process.env.LEANREA_PACK_OUT;
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    copyFileSync(tarball, join(outDir, entry.filename));
    console.log(`copied tested tarball to ${join(outDir, entry.filename)}`);
  }
  console.log("pack-test: ok");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
