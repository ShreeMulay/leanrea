import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { grade } from "../bench/grader.js";
import { type CellOptions, loadTasks, runCell, runProcess } from "../bench/run.js";
import { claudeCode, fake, opencode, parseClaudeStream, parseOpencodeJson, type RunContext } from "../bench/runners.js";
import { filterEnv, safeRemove, sanitize } from "../bench/safety.js";
import { PKG } from "./helpers.js";

const PKG_ROOT = PKG.root;

const tasks = loadTasks();
const key = (id: string): Record<string, string> => {
  const t = tasks.find((x) => x.id === id);
  assert.ok(t, id);
  return t.key;
};

describe("tasks.json", () => {
  it("keeps upstream macOS tasks and adds Linux tasks", () => {
    assert.deepEqual(
      tasks.map((t) => `${t.id}:${t.platform}`),
      ["electron:macos", "native:macos", "go:macos", "deep:macos", "linux-rust:linux", "linux-elf:linux"],
    );
    assert.equal(key("go")["go ver"], "go1\\.27\\.1");
    for (const t of tasks) assert.ok(t.targets.length > 0);
  });
});

describe("grader (pure)", () => {
  it("scores a perfect linux-rust answer", () => {
    const a =
      "Rust. rustc 1.95.0 (commit 59807616e1fa2540724bfbac14d7976d7e4a3860). Crates: bumpalo 3.20.3, flate2 v1.1.10, tikv-jemalloc-ctl-0.7.0.";
    const g = grade(a, key("linux-rust"));
    assert.equal(g.score, "6/6");
    assert.deepEqual(g.miss, []);
  });

  it("misses wrong versions and keeps crate binding", () => {
    const a = "Written in Rust 1.94.0; bumpalo 3.20.2; flate2 1.1.10; tikv-jemalloc-ctl is present. tsc-rs 0.7.0.";
    const g = grade(a, key("linux-rust"));
    assert.deepEqual(g.miss.sort(), ["bumpalo", "jemalloc-ctl", "rustc commit", "rustc ver"]);
    assert.equal(g.score, "2/6");
  });

  it("scores a linux-elf answer", () => {
    const a = "ELF64 x86-64 executable, statically linked (no NEEDED libraries), musl libc, Build ID b40b93b641f5e1cbbe90bd578bf7fe78d6677690.";
    assert.equal(grade(a, key("linux-elf")).score, "5/5");
    assert.equal(grade("ELF 32-bit ARM, dynamically linked against glibc", key("linux-elf")).score, "0/5");
  });

  it("is case-insensitive like upstream (Go 1.27.1 vs go1.27.1 still needs the exact form)", () => {
    const g = grade("GO1.27.1, github.com/cli/cli/v2/cmd/gh, go-gh v2.16.1, x/crypto v0.57.0", key("go"));
    assert.equal(g.score, "4/4");
    assert.deepEqual(grade("Go 1.27.1", key("go")).miss.includes("go ver"), true);
  });

  it("handles an empty answer", () => {
    assert.equal(grade("", key("native")).points, 0);
  });
});

describe("sanitize", () => {
  it("strips ANSI and control chars", () => {
    assert.equal(sanitize("\u001b[1;31mred\u001b[0m\u0007 ok\r\n\u001b]0;title\u0007x"), "red ok\nx");
  });
  it("caps the size on a UTF-8 boundary", () => {
    const s = sanitize("é".repeat(100), 51);
    assert.match(s, /^é{25}\n\[truncated 150 bytes\]$/);
  });
});

describe("env allowlist", () => {
  it("passes only allowlisted names", () => {
    const env = filterEnv({ PATH: "/bin", HOME: "/h", AWS_SECRET_ACCESS_KEY: "s", GITHUB_TOKEN: "t" }, ["PATH", "HOME"], { TMPDIR: "/x" });
    assert.deepEqual(env, { PATH: "/bin", HOME: "/h", TMPDIR: "/x" });
  });
});

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "leanrea-bench-test-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("safeRemove", () => {
  it("removes a dir strictly inside the root", () => {
    const d = join(root, "runs", "a");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "f"), "x");
    safeRemove(root, d);
    assert.equal(existsSync(d), false);
  });
  it("refuses the root itself, paths outside, traversal and symlinks", () => {
    const outside = mkdtempSync(join(tmpdir(), "leanrea-outside-"));
    try {
      writeFileSync(join(outside, "keep"), "x");
      assert.throws(() => safeRemove(root, root), /not inside/);
      assert.throws(() => safeRemove(root, outside), /not inside/);
      assert.throws(() => safeRemove(root, join(root, "..", basename(outside))), /not inside/);
      symlinkSync(outside, join(root, "link"));
      assert.throws(() => safeRemove(root, join(root, "link")), /symlink/);
      assert.throws(() => safeRemove("relative", outside), /absolute/);
      assert.ok(existsSync(join(outside, "keep")));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
  it("handles paths with spaces and globs literally", () => {
    const d = join(root, "a b", "*");
    const sibling = join(root, "a b", "keep");
    mkdirSync(d, { recursive: true });
    mkdirSync(sibling);
    safeRemove(root, d);
    assert.equal(existsSync(d), false);
    assert.ok(existsSync(sibling));
  });
});

describe("runners", () => {
  const ctx = (arm: "none" | "leanrea" | "rea"): RunContext => ({
    arm,
    task: tasks[4]!,
    rep: "1",
    runDir: "/w/runs/x",
    model: "sonnet",
    repoRoot: "/repo",
    workRoot: "/w",
  });
  it("claude-code uses a narrow tool list, not blanket Bash", () => {
    const inv = claudeCode.invocation(ctx("leanrea"));
    const allowed = inv.args[inv.args.indexOf("--allowedTools") + 1] ?? "";
    assert.ok(!allowed.split(",").includes("Bash"), allowed);
    assert.ok(!allowed.includes("Write"));
    assert.match(allowed, /Bash\(readelf:\*\)/);
    assert.equal(inv.args[inv.args.indexOf("--permission-mode") + 1], "dontAsk");
    assert.match(inv.stdin ?? "", /^\/leanrea /);
    assert.ok(!claudeCode.invocation(ctx("none")).args.includes("--mcp-config"));
    assert.ok(claudeCode.invocation(ctx("rea")).args.includes("--mcp-config"));
  });
  it("opencode passes the prompt as an argument and rejects the rea arm", () => {
    const inv = opencode.invocation({ ...ctx("leanrea"), model: "anthropic/claude-sonnet" });
    assert.deepEqual(inv.args.slice(0, 5), ["run", "--format", "json", "--model", "anthropic/claude-sonnet"]);
    assert.throws(() => opencode.invocation(ctx("rea")), /not supported/);
  });
  it("parses claude stream-json and opencode json", () => {
    const s = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "readelf -h x" } }] } }),
      "noise",
      JSON.stringify({ type: "result", result: "hi", num_turns: 3, total_cost_usd: 0.1, is_error: false, usage: { input_tokens: 5 } }),
    ].join("\n");
    const p = parseClaudeStream(s, "");
    assert.equal(p.answer, "hi");
    assert.deepEqual(p.tools, ["Bash:readelf"]);
    assert.equal(p.usage.in, 5);
    assert.equal(parseClaudeStream("garbage", "boom").isError, true);
    const o = parseOpencodeJson([JSON.stringify({ type: "text", part: { text: "a" } }), JSON.stringify({ type: "text", part: { text: "b" } })].join("\n"), "");
    assert.equal(o.answer, "a\nb");
  });
});

function setupWork(): string {
  const work = join(root, "work dir");
  mkdirSync(join(work, "targets"), { recursive: true });
  writeFileSync(join(work, "targets", "tsc"), "\u007fELF fake target\n");
  return work;
}

function opts(work: string, over: Partial<CellOptions> = {}): CellOptions {
  return {
    arm: "leanrea",
    taskId: "linux-rust",
    rep: "1",
    runner: fake,
    workRoot: work,
    model: "sonnet",
    timeoutSec: 30,
    dryRun: false,
    isolated: false,
    clean: false,
    passEnv: [],
    log: () => {},
    sourceEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root },
    ...over,
  };
}

describe("runCell with the fake runner", () => {
  it("runs in its own mktemp dir, copies targets and the skill, grades and writes results", async () => {
    const work = setupWork();
    const answer = "Rust 1.95.0 59807616e1fa2540724bfbac14d7976d7e4a3860 bumpalo 3.20.3 flate2 1.1.10 tikv-jemalloc-ctl 0.7.0";
    const row = await runCell(opts(work, { sourceEnv: { PATH: process.env.PATH ?? "", HOME: root, FAKE_AGENT_ANSWER: answer } }));
    assert.ok(row);
    assert.equal(row.score, "6/6");
    assert.equal(row.err, false);
    assert.deepEqual(row.tools, ["Bash:readelf"]);
    const runs = readdirSync(join(work, "runs"));
    assert.equal(runs.length, 1);
    assert.match(runs[0]!, /^leanrea-linux-rust-1-[A-Za-z0-9]{6}$/);
    const runDir = join(work, "runs", runs[0]!);
    assert.ok(existsSync(join(runDir, "tsc")));
    assert.ok(existsSync(join(runDir, ".claude", "skills", "leanrea", "SKILL.md")));
    const saved = JSON.parse(readFileSync(join(work, "results", `${runs[0]}.json`), "utf8")) as { answer: string };
    assert.equal(saved.answer, answer);
  });

  it("passes only allowlisted env vars", async () => {
    const work = setupWork();
    const row = await runCell(
      opts(work, {
        clean: true,
        sourceEnv: { PATH: process.env.PATH ?? "", HOME: root, FAKE_AGENT_MODE: "env", GITHUB_TOKEN: "secret", AWS_PROFILE: "x", NPM_TOKEN: "y" },
      }),
    );
    assert.ok(row);
    const res = readdirSync(join(work, "results"));
    const saved = JSON.parse(readFileSync(join(work, "results", res[0]!), "utf8")) as { answer: string };
    const names = saved.answer.split(",");
    for (const bad of ["GITHUB_TOKEN", "AWS_PROFILE", "NPM_TOKEN"]) assert.ok(!names.includes(bad), bad);
    assert.ok(names.includes("TMPDIR"));
    assert.deepEqual(readdirSync(join(work, "runs")), [], "--clean removed the run dir");
  });

  it("sanitizes and caps the answer", async () => {
    const work = setupWork();
    await runCell(opts(work, { sourceEnv: { PATH: process.env.PATH ?? "", HOME: root, FAKE_AGENT_MODE: "ansi", FAKE_AGENT_ANSWER: "flate2 1.1.10" } }));
    const res = readdirSync(join(work, "results"));
    const saved = JSON.parse(readFileSync(join(work, "results", res[0]!), "utf8")) as { answer: string; score: string };
    assert.ok(!saved.answer.includes("\u001b"));
    assert.ok(Buffer.byteLength(saved.answer) < 70 * 1024);
    assert.match(saved.answer, /truncated/);
    assert.equal(saved.score, "1/6");
  });

  it("kills the whole process group on timeout", async () => {
    const work = setupWork();
    const pidfile = join(root, "grandchild.pid");
    const row = await runCell(
      opts(work, { timeoutSec: 1, sourceEnv: { PATH: process.env.PATH ?? "", HOME: root, FAKE_AGENT_MODE: "hang", FAKE_AGENT_PIDFILE: pidfile } }),
    );
    assert.ok(row);
    assert.equal(row.timed_out, true);
    assert.equal(row.err, true);
    const gpid = Number(readFileSync(pidfile, "utf8"));
    await new Promise((r) => setTimeout(r, 200));
    assert.throws(() => process.kill(gpid, 0), /ESRCH/, "grandchild survived");
  });

  it("dry run prints the plan and creates nothing", async () => {
    const lines: string[] = [];
    const work = join(root, "nonexistent");
    await runCell(opts(work, { dryRun: true, runner: claudeCode, log: (l) => lines.push(l) }));
    const plan = JSON.parse(lines.join("\n")) as { cmd: string; env_passed: string[]; requires_isolated: boolean; real_run_disabled: boolean; note: string };
    assert.equal(plan.cmd, "claude");
    assert.equal(plan.requires_isolated, true);
    assert.equal(plan.real_run_disabled, true);
    assert.match(plan.note, /disabled.*issues\/2/);
    assert.ok(!plan.env_passed.includes("GITHUB_TOKEN"));
    assert.equal(existsSync(work), false);
  });

  it("refuses every real runner (issue #2), even with --isolated; bad reps and missing targets", async () => {
    const work = setupWork();
    for (const runner of [claudeCode, opencode]) {
      for (const isolated of [false, true]) {
        await assert.rejects(runCell(opts(work, { runner, isolated, model: "anthropic/x" })), /disabled.*leanrea\/issues\/2/);
      }
    }
    assert.equal(existsSync(join(work, "runs")), false, "a refused run must not create anything");
    await assert.rejects(runCell(opts(work, { rep: "../x" })), /rep must match/);
    await assert.rejects(runCell(opts(work, { taskId: "go" })), /target missing/);
    await assert.rejects(runCell(opts(work, { taskId: "nope" })), /unknown task/);
  });

  it("runProcess reports exit codes", async () => {
    const r = await runProcess(process.execPath, ["-e", "process.exit(3)"], { cwd: root, env: {}, stdin: null, timeoutMs: 10_000 });
    assert.equal(r.exit, 3);
    assert.equal(r.timedOut, false);
  });
});

describe("bench/ctx.sh", () => {
  it("refuses before creating anything or starting claude", () => {
    const bin = join(root, "bin");
    const work = join(root, "work");
    const marker = join(root, "claude-ran");
    mkdirSync(bin);
    mkdirSync(work);
    writeFileSync(join(bin, "claude"), `#!/bin/sh\ntouch '${marker}'\necho '{}'\n`, { mode: 0o755 });
    writeFileSync(join(bin, "jq"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const r = spawnSync("bash", [join(PKG_ROOT, "bench", "ctx.sh")], {
      cwd: root,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, LEANREA_WORK: work },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /disabled.*leanrea\/issues\/2/);
    assert.equal(existsSync(marker), false, "claude (or jq) was started");
    assert.deepEqual(readdirSync(work), [], "ctx.sh created something under LEANREA_WORK");
  });
});
