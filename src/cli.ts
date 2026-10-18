#!/usr/bin/env node
import { parseArgs } from "node:util";
import { doctorReport } from "./doctor.js";
import {
  AGENTS,
  type Agent,
  consistencyCheck,
  destinationFor,
  type InstallEnv,
  installOne,
  type InstallTarget,
  isAgent,
  isFailure,
  type Scope,
} from "./installer.js";
import { findPackage, readSkill } from "./skill.js";

const HELP = `Usage: leanrea <command> [options]

Commands:
  print                      Write leanrea/SKILL.md to stdout
  doctor                     Show which router tools are on PATH (always exits 0)
  install [options]          Install SKILL.md for an agent

Install options:
  --agent <name>             opencode (default) | claude-code | codex | all
                             (all writes the Claude Code and Codex dirs; OpenCode reads both)
  --global                   User-level skills dir (default)
  --project                  Skills dir under the current directory
  --dest <path>              Exact SKILL.md path (excludes --agent all, --global, --project)
  --dry-run                  Show what would happen; write nothing
  --force                    Overwrite an existing different file that is not a known release

Existing copies of a known leanrea release are upgraded without --force. Other
skills dirs the selected agents also read are checked: known older releases are
upgraded, unknown copies get a warning on stderr and are left alone.

Global options:
  -h, --help                 Show this help
  -v, --version              Show the version

Exit codes: 0 ok (warnings allowed), 1 a target was refused or failed, 2 usage error.
`;

class UsageError extends Error {}

function main(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        agent: { type: "string" },
        global: { type: "boolean" },
        project: { type: "boolean" },
        dest: { type: "string" },
        "dry-run": { type: "boolean" },
        force: { type: "boolean" },
      },
    });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const { values: v, positionals } = parsed;

  if (v.version) {
    process.stdout.write(`${findPackage().version}\n`);
    return 0;
  }
  const cmd = positionals[0];
  if (v.help || cmd === undefined || cmd === "help") {
    process.stdout.write(HELP);
    return cmd === undefined && !v.help ? 2 : 0;
  }
  if (positionals.length > 1) throw new UsageError(`unexpected argument: ${positionals[1]}`);

  const installOnly = v.agent !== undefined || v.global || v.project || v.dest !== undefined || v["dry-run"] || v.force;
  if (cmd !== "install" && installOnly) throw new UsageError(`install options are only valid with 'install'`);

  switch (cmd) {
    case "print":
      process.stdout.write(readSkill());
      return 0;
    case "doctor":
      process.stdout.write(doctorReport(process.env.PATH ?? ""));
      return 0;
    case "install":
      return install(v);
    default:
      throw new UsageError(`unknown command: ${cmd}`);
  }
}

interface InstallFlags {
  agent?: string | undefined;
  global?: boolean | undefined;
  project?: boolean | undefined;
  dest?: string | undefined;
  "dry-run"?: boolean | undefined;
  force?: boolean | undefined;
}

function install(v: InstallFlags): number {
  if (v.global && v.project) throw new UsageError("--global and --project are mutually exclusive");
  const agentArg = v.agent ?? "opencode";
  if (agentArg !== "all" && !isAgent(agentArg)) {
    throw new UsageError(`unknown agent: ${agentArg} (expected ${AGENTS.join(", ")} or all)`);
  }
  if (v.dest !== undefined) {
    if (agentArg === "all") throw new UsageError("--dest cannot be combined with --agent all");
    if (v.global || v.project) throw new UsageError("--dest cannot be combined with --global or --project");
    if (v.dest === "") throw new UsageError("--dest needs a path");
  }

  const home = process.env.HOME;
  if (!home) throw new UsageError("HOME is not set");
  const env: InstallEnv = {
    home,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    cwd: process.cwd(),
    path: process.env.PATH ?? "",
  };
  const scope: Scope = v.project ? "project" : "global";
  // Readers to keep consistent; for "all", every agent.
  const agents: Agent[] = agentArg === "all" ? [...AGENTS] : [agentArg as Agent];
  // OpenCode also reads ~/.claude/skills and ~/.agents/skills, so "all" writes only those two.
  const writeFor: Agent[] = agentArg === "all" ? ["claude-code", "codex"] : agents;
  const targets: InstallTarget[] =
    v.dest !== undefined
      ? [{ label: "custom", dest: v.dest }]
      : writeFor.map((a) => ({
          label: `${a} (${scope})`,
          dest: destinationFor(a, scope, env),
          containWithin: scope === "project" ? env.cwd : undefined,
        }));

  const data = readSkill();
  const opts = { dryRun: !!v["dry-run"], force: !!v.force };
  let failed = false;
  for (const t of targets) {
    const res = installOne(t, data, env, opts);
    const line = `${res.label}: ${res.status}: ${res.message}\n`;
    if (isFailure(res)) {
      failed = true;
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  }
  if (v.dest === undefined) {
    const dests = targets.map((t) => t.dest);
    for (const res of consistencyCheck(agents, scope, env, data, dests, opts)) {
      const line = `${res.label}: ${res.status}: ${res.message}\n`;
      if (res.status === "warning") process.stderr.write(line);
      else process.stdout.write(line);
    }
  }
  return failed ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof UsageError) {
    process.stderr.write(`leanrea: ${e.message}\nRun 'leanrea --help' for usage.\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`leanrea: ${(e as Error).message}\n`);
    process.exitCode = 1;
  }
}
