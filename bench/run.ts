/**
 * Run one benchmark cell (TypeScript port of upstream run.py, with issue #3 fixed).
 *
 *   node build/bench/run.js <arm> <task> <rep> [--runner claude-code|opencode|fake]
 *        [--dry-run] [--isolated] [--timeout SEC] [--work DIR] [--model M] [--clean] [--pass-env NAME]...
 *
 * Arms: none | leanrea | rea. Work root: --work, $LEANREA_WORK, or bench/work.
 * Real agent runs (every runner except `fake`) are DISABLED until the bench is
 * redesigned: https://github.com/ShreeMulay/leanrea/issues/2. --dry-run and the
 * fake runner still work. See bench/README.md.
 */
import { spawn } from "node:child_process";
import {
  constants as fsc,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { findPackage } from "../src/skill.js";
import { grade } from "./grader.js";
import { type Arm, ARMS, type Parsed, promptFor, type RunContext, type Runner, RUNNERS, type Task } from "./runners.js";
import { BASE_ENV_ALLOWLIST, filterEnv, safeRemove, sanitize } from "./safety.js";

export const ANSWER_CAP = 64 * 1024;
const STREAM_CAP = 16 * 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9_-]{1,40}$/;
export const REDESIGN_ISSUE = "https://github.com/ShreeMulay/leanrea/issues/2";
export const REAL_RUNS_DISABLED =
  `real agent runs are disabled until the bench is redesigned (${REDESIGN_ISSUE}): the command allowlist blocks the ` +
  "skill's own first-move commands, runs leak the real HOME/agent config, and --isolated is an honor flag, not isolation. " +
  "--dry-run and the fake runner still work.";

export interface CellOptions {
  arm: Arm;
  taskId: string;
  rep: string;
  runner: Runner;
  workRoot: string;
  model: string;
  timeoutSec: number;
  dryRun: boolean;
  isolated: boolean;
  clean: boolean;
  passEnv: string[];
  sourceEnv?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface Row {
  arm: Arm;
  task: string;
  rep: string;
  runner: string;
  wall_s: number;
  timed_out: boolean;
  exit: number | null;
  turns: number | null;
  cost: number | null;
  in: number;
  cache_w: number;
  cache_r: number;
  out: number;
  score: string;
  miss: string[];
  err: boolean;
  tools: string[];
}

export function repoRoot(): string {
  return findPackage().root;
}

export function loadTasks(root = repoRoot()): Task[] {
  return JSON.parse(readFileSync(join(root, "bench", "tasks.json"), "utf8")) as Task[];
}

function hostPlatform(): Task["platform"] | null {
  return process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : null;
}

/** Copy a target into the run dir: regular files (reflink when possible) and dirs; symlinks are skipped. */
function copyTarget(src: string, dst: string): void {
  const st = lstatSync(src);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const e of readdirSync(src)) copyTarget(join(src, e), join(dst, e));
  } else if (st.isFile()) {
    copyFileSync(src, dst, fsc.COPYFILE_FICLONE);
  }
}

interface ProcResult {
  stdout: string;
  stderr: string;
  exit: number | null;
  timedOut: boolean;
  wall: number;
}

function killGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    // group already gone
  }
}

/** Spawn in a new process group; on timeout SIGTERM then SIGKILL the whole group. */
export function runProcess(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; stdin: string | null; timeoutMs: number; graceMs?: number },
): Promise<ProcResult> {
  return new Promise((resolvePromise, reject) => {
    const t0 = performance.now();
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    child.stdout.on("data", (b: Buffer) => {
      if (outLen < STREAM_CAP) out.push(b);
      outLen += b.length;
    });
    child.stderr.on("data", (b: Buffer) => {
      if (errLen < STREAM_CAP) err.push(b);
      errLen += b.length;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        killGroup(child.pid, "SIGTERM");
        const pid = child.pid;
        killTimer = setTimeout(() => killGroup(pid, "SIGKILL"), opts.graceMs ?? 5000);
      }
    }, opts.timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      // Reap anything the agent left behind in its group.
      if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
      resolvePromise({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        exit: code,
        timedOut,
        wall: (performance.now() - t0) / 1000,
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.stdin ?? "");
  });
}

export function envFor(o: CellOptions, extra: Record<string, string>): Record<string, string> {
  return filterEnv(o.sourceEnv ?? process.env, [...BASE_ENV_ALLOWLIST, ...o.runner.envAllowlist, ...o.passEnv], extra);
}

export async function runCell(o: CellOptions): Promise<Row | null> {
  const log = o.log ?? ((l: string) => process.stdout.write(l + "\n"));
  const root = repoRoot();
  if (!ARMS.includes(o.arm)) throw new Error(`unknown arm: ${o.arm}`);
  if (!SAFE_NAME.test(o.rep)) throw new Error(`rep must match ${SAFE_NAME}`);
  const task = loadTasks(root).find((t) => t.id === o.taskId);
  if (!task) throw new Error(`unknown task: ${o.taskId}`);
  if (!isAbsolute(o.workRoot)) throw new Error(`work root must be absolute: ${o.workRoot}`);
  if (!Number.isFinite(o.timeoutSec) || o.timeoutSec <= 0) throw new Error("timeout must be > 0");

  const placeholder = join(o.workRoot, "runs", `${o.arm}-${task.id}-${o.rep}-XXXXXX`);
  const planCtx: RunContext = { arm: o.arm, task, rep: o.rep, runDir: placeholder, model: o.model, repoRoot: root, workRoot: o.workRoot };

  if (o.dryRun) {
    const inv = o.runner.invocation(planCtx);
    const env = envFor(o, { TMPDIR: join(placeholder, ".tmp") });
    log(
      JSON.stringify(
        {
          dry_run: true,
          runner: o.runner.name,
          arm: o.arm,
          task: task.id,
          platform: task.platform,
          rep: o.rep,
          run_dir: placeholder,
          targets: task.targets.map((t) => join(o.workRoot, "targets", t)),
          cmd: inv.cmd,
          args: inv.args,
          stdin: inv.stdin,
          env_passed: Object.keys(env).sort(),
          timeout_s: o.timeoutSec,
          requires_isolated: o.runner.name !== "fake",
          real_run_disabled: o.runner.name !== "fake",
          note: o.runner.name !== "fake" ? REAL_RUNS_DISABLED : undefined,
        },
        null,
        1,
      ),
    );
    return null;
  }

  if (o.runner.name !== "fake") {
    throw new Error(REAL_RUNS_DISABLED);
  }
  if (o.runner.name !== "fake") {
    // Kept for the redesign (issue #2); unreachable while real runs are disabled.
    if (!o.isolated) {
      throw new Error("refusing a real agent run without --isolated: run inside a disposable VM/container, then pass --isolated");
    }
    if (task.platform !== hostPlatform()) throw new Error(`task ${task.id} is ${task.platform}-only; this host is ${process.platform}`);
  }
  if (!existsSync(o.workRoot)) throw new Error(`work root not found: ${o.workRoot} (run bench/setup.sh first)`);
  const work = realpathSync(o.workRoot);
  for (const t of task.targets) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(t) || t.includes("..")) throw new Error(`bad target name: ${t}`);
    const p = join(work, "targets", t);
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink()) throw new Error(`target missing or a symlink: ${p} (run bench/setup.sh)`);
  }

  const runs = join(work, "runs");
  mkdirSync(runs, { recursive: true });
  const runDir = mkdtempSync(join(runs, `${o.arm}-${task.id}-${o.rep}-`));
  const ctx: RunContext = { ...planCtx, runDir, workRoot: work };
  for (const t of task.targets) copyTarget(join(work, "targets", t), join(runDir, t));
  o.runner.prepare(ctx);
  const tmp = join(runDir, ".tmp");
  mkdirSync(tmp);

  const inv = o.runner.invocation(ctx);
  const proc = await runProcess(inv.cmd, inv.args, {
    cwd: runDir,
    env: envFor(o, { TMPDIR: tmp }),
    stdin: inv.stdin,
    timeoutMs: o.timeoutSec * 1000,
  });
  const parsed: Parsed = o.runner.parse(proc.stdout, proc.stderr);
  const answer = sanitize(parsed.answer, ANSWER_CAP);
  const g = grade(answer, task.key);
  const row: Row = {
    arm: o.arm,
    task: task.id,
    rep: o.rep,
    runner: o.runner.name,
    wall_s: Math.round(proc.wall * 10) / 10,
    timed_out: proc.timedOut,
    exit: proc.exit,
    turns: parsed.turns,
    cost: parsed.cost,
    in: parsed.usage.in,
    cache_w: parsed.usage.cache_w,
    cache_r: parsed.usage.cache_r,
    out: parsed.usage.out,
    score: g.score,
    miss: g.miss,
    err: parsed.isError || proc.timedOut || proc.exit !== 0,
    tools: parsed.tools.map((t) => sanitize(t, 200)),
  };
  const results = join(work, "results");
  mkdirSync(results, { recursive: true });
  writeFileSync(
    join(results, `${basename(runDir)}.json`),
    JSON.stringify({ ...row, answer, stderr_tail: sanitize(proc.stderr.slice(-4000), 4000) }, null, 1),
  );
  if (o.clean) safeRemove(work, runDir);
  log(JSON.stringify(row));
  return row;
}

async function main(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      runner: { type: "string", default: "claude-code" },
      "dry-run": { type: "boolean" },
      isolated: { type: "boolean" },
      timeout: { type: "string", default: "1500" },
      work: { type: "string" },
      model: { type: "string" },
      clean: { type: "boolean" },
      "pass-env": { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
  });
  if (v.help || positionals.length !== 3) {
    process.stdout.write(
      "usage: run.js <none|leanrea|rea> <task> <rep> [--runner claude-code|opencode|fake] [--dry-run] [--isolated]\n" +
        "              [--timeout SEC] [--work DIR] [--model M] [--clean] [--pass-env NAME]...\n" +
        `tasks: ${loadTasks().map((t) => `${t.id} (${t.platform})`).join(", ")}\n` +
        `note: ${REAL_RUNS_DISABLED}\n`,
    );
    return v.help ? 0 : 2;
  }
  const [arm, taskId, rep] = positionals as [string, string, string];
  const runner = RUNNERS[v.runner ?? ""];
  if (!runner) throw new Error(`unknown runner: ${v.runner}`);
  const model = v.model ?? process.env.BENCH_MODEL ?? (runner.name === "opencode" ? "" : "sonnet");
  if (runner.name === "opencode" && !model.includes("/")) throw new Error("opencode runner needs --model provider/model");
  for (const n of v["pass-env"] ?? []) if (!/^[A-Z_][A-Z0-9_]*$/.test(n)) throw new Error(`bad --pass-env name: ${n}`);
  await runCell({
    arm: arm as Arm,
    taskId,
    rep,
    runner,
    workRoot: resolve(v.work ?? process.env.LEANREA_WORK ?? join(repoRoot(), "bench", "work")),
    model,
    timeoutSec: Number(v.timeout),
    dryRun: !!v["dry-run"],
    isolated: !!v.isolated || process.env.LEANREA_BENCH_ISOLATED === "1",
    clean: !!v.clean,
    passEnv: v["pass-env"] ?? [],
  });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (c) => (process.exitCode = c),
    (e: Error) => {
      process.stderr.write(`bench: ${e.message}\n`);
      process.exitCode = 1;
    },
  );
}
