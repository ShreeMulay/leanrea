import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Arm = "none" | "leanrea" | "rea";
export const ARMS: readonly Arm[] = ["none", "leanrea", "rea"];

export interface Task {
  id: string;
  platform: "macos" | "linux";
  targets: string[];
  prompt: string;
  key: Record<string, string>;
}

export interface RunContext {
  arm: Arm;
  task: Task;
  rep: string;
  runDir: string;
  model: string;
  repoRoot: string;
  workRoot: string;
}

export interface Invocation {
  cmd: string;
  args: string[];
  stdin: string | null;
}

export interface Parsed {
  answer: string;
  turns: number | null;
  cost: number | null;
  usage: { in: number; cache_w: number; cache_r: number; out: number };
  isError: boolean;
  tools: string[];
}

export interface Runner {
  name: string;
  /** Env vars this agent CLI needs on top of BASE_ENV_ALLOWLIST. */
  envAllowlist: readonly string[];
  /** Write skill/config files into the run dir. Must only write inside ctx.runDir. */
  prepare(ctx: RunContext): void;
  invocation(ctx: RunContext): Invocation;
  parse(stdout: string, stderr: string): Parsed;
}

const SKILL_PREFIX: Record<Arm, string> = { none: "", leanrea: "/leanrea ", rea: "/reverse-engineer-anything " };

export function promptFor(arm: Arm, task: Task): string {
  return SKILL_PREFIX[arm] + task.prompt;
}

function installSkill(ctx: RunContext, skillsDir: string): void {
  if (ctx.arm === "leanrea") {
    mkdirSync(join(skillsDir, "leanrea"), { recursive: true });
    cpSync(join(ctx.repoRoot, "leanrea", "SKILL.md"), join(skillsDir, "leanrea", "SKILL.md"));
  } else if (ctx.arm === "rea") {
    cpSync(
      join(ctx.workRoot, "rea-install", "node_modules", "rea-agents", "skills", "reverse-engineer-anything"),
      join(skillsDir, "reverse-engineer-anything"),
      { recursive: true },
    );
  }
}

/**
 * Narrow pre-approved commands for static inspection. Replaces upstream's
 * blanket "Bash". Prefix rules use Claude Code's `Bash(prefix:*)` syntax.
 * Deliberately excluded because they can run other programs or write files:
 * find (-exec/-delete), awk (system()), rg (--pre), sed (-i/e), xargs, sh/bash, cp/mv/rm.
 * Use the Grep/Glob/Read tools for searching instead. Accepted residual risk: `sort -o` can
 * write a file; that is why real runs still require --isolated.
 */
export const CLAUDE_BASH_PREFIXES = [
  "file", "readelf", "nm", "objdump", "strings", "otool", "lipo", "xcrun dyld_info", "xcrun swift-demangle",
  "codesign -d", "go version -m", "jq", "grep", "head", "sort", "uniq", "wc", "tr", "ls",
  "echo", "mktemp -d", "npx -y @electron/asar@4.3.1 extract", "npx -y @electron/fuses@2.1.3 read",
] as const;

const EMPTY_USAGE = { in: 0, cache_w: 0, cache_r: 0, out: 0 };

/** Parse Claude Code `--output-format stream-json` (also used by the fake agent). */
export function parseClaudeStream(stdout: string, stderr: string): Parsed {
  let result: Record<string, unknown> | null = null;
  const tools: string[] = [];
  for (const line of stdout.split("\n")) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (ev.type === "result") result = ev;
    if (ev.type === "assistant") {
      const content = ((ev.message as { content?: unknown } | undefined)?.content ?? []) as Array<Record<string, unknown>>;
      for (const c of Array.isArray(content) ? content : []) {
        if (c.type !== "tool_use") continue;
        const name = String(c.name);
        const command = (c.input as { command?: unknown } | undefined)?.command;
        tools.push(name === "Bash" && typeof command === "string" && command.trim() ? `Bash:${command.trim().split(/\s+/)[0]}` : name);
      }
    }
  }
  if (!result) {
    return { answer: (stdout.slice(-2000) + stderr.slice(-2000)), turns: null, cost: null, usage: EMPTY_USAGE, isError: true, tools };
  }
  const u = (result.usage ?? {}) as Record<string, number | undefined>;
  return {
    answer: typeof result.result === "string" ? result.result : "",
    turns: typeof result.num_turns === "number" ? result.num_turns : null,
    cost: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
    usage: {
      in: u.input_tokens ?? 0,
      cache_w: u.cache_creation_input_tokens ?? 0,
      cache_r: u.cache_read_input_tokens ?? 0,
      out: u.output_tokens ?? 0,
    },
    isError: result.is_error === true,
    tools,
  };
}

export const claudeCode: Runner = {
  name: "claude-code",
  envAllowlist: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "ENABLE_TOOL_SEARCH"],
  prepare(ctx) {
    installSkill(ctx, join(ctx.runDir, ".claude", "skills"));
  },
  invocation(ctx) {
    const allowed = ["Read", "Grep", "Glob", "Skill", ...CLAUDE_BASH_PREFIXES.map((p) => `Bash(${p}:*)`)];
    const args = [
      "-p", "--model", ctx.model, "--output-format", "stream-json", "--verbose",
      "--strict-mcp-config", "--no-session-persistence", "--max-budget-usd", "4",
      // Built-in tools that exist at all; Bash stays available but only the prefixes below are pre-approved.
      "--tools", "Bash,Read,Grep,Glob,Skill",
      // Anything not pre-approved is denied instead of prompting.
      "--permission-mode", "dontAsk",
      "--disallowedTools", "Write,Edit,NotebookEdit,WebFetch,WebSearch",
    ];
    if (ctx.arm === "rea") {
      allowed.push("mcp__rea");
      args.push("--mcp-config", join(ctx.workRoot, "rea-mcp.json"));
    }
    args.push("--allowedTools", allowed.join(","));
    return { cmd: "claude", args, stdin: promptFor(ctx.arm, ctx.task) };
  },
  parse: parseClaudeStream,
};

/** Parse `opencode run --format json` event lines; falls back to raw stdout. */
export function parseOpencodeJson(stdout: string, stderr: string): Parsed {
  const texts: string[] = [];
  const tools: string[] = [];
  let sawEvent = false;
  let isError = false;
  for (const line of stdout.split("\n")) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    sawEvent = true;
    const part = (ev.part ?? {}) as Record<string, unknown>;
    if (ev.type === "text" && typeof part.text === "string") texts.push(part.text);
    if (ev.type === "tool_use" || part.type === "tool") tools.push(String(part.tool ?? part.name ?? "tool"));
    if (ev.type === "error") isError = true;
  }
  const answer = sawEvent ? texts.join("\n") : stdout;
  return { answer, turns: null, cost: null, usage: EMPTY_USAGE, isError: isError || (!answer && !!stderr), tools };
}

export const opencode: Runner = {
  name: "opencode",
  envAllowlist: [
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
  ],
  prepare(ctx) {
    installSkill(ctx, join(ctx.runDir, ".opencode", "skills"));
    // Project config in the run dir: deny edits/web, allow only the inspection prefixes.
    const bash: Record<string, string> = { "*": "deny" };
    for (const p of CLAUDE_BASH_PREFIXES) {
      bash[p] = "allow";
      bash[`${p} *`] = "allow";
    }
    writeFileSync(
      join(ctx.runDir, "opencode.json"),
      JSON.stringify({ $schema: "https://opencode.ai/config.json", permission: { edit: "deny", webfetch: "deny", bash } }, null, 2),
    );
  },
  invocation(ctx) {
    if (ctx.arm === "rea") throw new Error("opencode runner: the rea arm is not supported (needs an MCP config)");
    return { cmd: "opencode", args: ["run", "--format", "json", "--model", ctx.model, promptFor(ctx.arm, ctx.task)], stdin: null };
  },
  parse: parseOpencodeJson,
};

/** Test runner: a local Node script that pretends to be an agent. Never touches the network. */
export const fake: Runner = {
  name: "fake",
  envAllowlist: ["FAKE_AGENT_ANSWER", "FAKE_AGENT_MODE", "FAKE_AGENT_PIDFILE"],
  prepare(ctx) {
    installSkill(ctx, join(ctx.runDir, ".claude", "skills"));
  },
  invocation(ctx) {
    const script = fileURLToPath(new URL("./fake-agent.js", import.meta.url));
    return { cmd: process.execPath, args: [script], stdin: promptFor(ctx.arm, ctx.task) };
  },
  parse: parseClaudeStream,
};

export const RUNNERS: Record<string, Runner> = { "claude-code": claudeCode, opencode, fake };
