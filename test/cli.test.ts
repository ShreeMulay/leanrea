import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AGENTS, type Agent, installOne, type InstallEnv } from "../src/installer.js";
import { PKG, run, type Sandbox, sandbox, tree } from "./helpers.js";

const SKILL = readFileSync(PKG.skillPath);

function expectedDest(sb: Sandbox, agent: Agent, scope: "global" | "project"): string {
  const rel = join("skills", "leanrea", "SKILL.md");
  if (scope === "project") {
    return join(sb.proj, agent === "opencode" ? ".opencode" : agent === "claude-code" ? ".claude" : ".agents", rel);
  }
  if (agent === "opencode") return join(sb.xdg, "opencode", rel);
  if (agent === "claude-code") return join(sb.home, ".claude", rel);
  return join(sb.home, ".agents", rel);
}

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => {
  sb.cleanup();
});

describe("basic commands", () => {
  it("--version prints the package version", () => {
    const r = run(sb, ["--version"]);
    assert.equal(r.status, 0);
    assert.equal(r.out.trim(), PKG.version);
  });

  it("--help exits 0", () => {
    const r = run(sb, ["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.out, /Usage: leanrea/);
  });

  it("print output byte-equals SKILL.md", () => {
    const r = run(sb, ["print"]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.equals(SKILL), "print output differs from SKILL.md");
  });

  it("doctor exits 0 and prints groups", () => {
    const r = run(sb, ["doctor"]);
    assert.equal(r.status, 0);
    assert.match(r.out, /Linux/);
    assert.match(r.out, /macOS/);
    assert.match(r.out, /optional/);
  });

  it("unknown command exits 2", () => {
    assert.equal(run(sb, ["frobnicate"]).status, 2);
  });
});

describe("install: fresh", () => {
  for (const agent of AGENTS) {
    for (const scope of ["global", "project"] as const) {
      it(`${agent} ${scope}`, () => {
        const r = run(sb, ["install", "--agent", agent, `--${scope}`]);
        assert.equal(r.status, 0, r.out);
        const dest = expectedDest(sb, agent, scope);
        assert.ok(readFileSync(dest).equals(SKILL), `bytes differ at ${dest}`);
        assert.match(r.out, /installed/);
        const leftovers = tree(join(dest, "..")).filter((f) => f !== "SKILL.md");
        assert.deepEqual(leftovers, [], "temp files left behind");
      });
    }
  }

  it("defaults to opencode global", () => {
    const r = run(sb, ["install"]);
    assert.equal(r.status, 0, r.out);
    assert.ok(existsSync(expectedDest(sb, "opencode", "global")));
  });

  it("opencode global falls back to ~/.config without XDG_CONFIG_HOME", () => {
    const r = run(sb, ["install"], { xdg: false });
    assert.equal(r.status, 0, r.out);
    assert.ok(existsSync(join(sb.home, ".config", "opencode", "skills", "leanrea", "SKILL.md")));
  });

  it("--dest installs to an exact path", () => {
    const dest = join(sb.outside, "custom", "SKILL.md");
    const r = run(sb, ["install", "--dest", dest]);
    assert.equal(r.status, 0, r.out);
    assert.ok(readFileSync(dest).equals(SKILL));
  });
});

describe("install: existing files", () => {
  it("identical file reports up to date", () => {
    assert.equal(run(sb, ["install"]).status, 0);
    const r = run(sb, ["install"]);
    assert.equal(r.status, 0);
    assert.match(r.out, /already up to date/);
  });

  it("different file is refused without --force and replaced with it", () => {
    const dest = expectedDest(sb, "claude-code", "global");
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, "user edits\n");
    const r1 = run(sb, ["install", "--agent", "claude-code"]);
    assert.equal(r1.status, 1);
    assert.match(r1.out, /use --force/);
    assert.equal(readFileSync(dest, "utf8"), "user edits\n");

    const r2 = run(sb, ["install", "--agent", "claude-code", "--force"]);
    assert.equal(r2.status, 0, r2.out);
    assert.ok(readFileSync(dest).equals(SKILL));
  });
});

describe("install: symlinks and containment", () => {
  it("refuses a symlinked destination, even with --force", () => {
    const dest = expectedDest(sb, "codex", "global");
    mkdirSync(join(dest, ".."), { recursive: true });
    const victim = join(sb.outside, "victim.txt");
    writeFileSync(victim, "keep me\n");
    symlinkSync(victim, dest);
    const r = run(sb, ["install", "--agent", "codex", "--force"]);
    assert.equal(r.status, 1);
    assert.match(r.out, /destination is a symlink/);
    assert.equal(readFileSync(victim, "utf8"), "keep me\n");
  });

  it("refuses a symlinked ancestor below HOME", () => {
    const real = join(sb.outside, "real-claude");
    mkdirSync(real);
    symlinkSync(real, join(sb.home, ".claude"));
    const r = run(sb, ["install", "--agent", "claude-code"]);
    assert.equal(r.status, 1);
    assert.match(r.out, /ancestor is a symlink/);
    assert.deepEqual(tree(real), []);
  });

  it("refuses a symlinked ancestor outside HOME (up to /)", () => {
    const real = join(sb.outside, "real");
    mkdirSync(real);
    symlinkSync(real, join(sb.outside, "link"));
    const r = run(sb, ["install", "--dest", join(sb.outside, "link", "sub", "SKILL.md")]);
    assert.equal(r.status, 1);
    assert.match(r.out, /ancestor is a symlink/);
    assert.deepEqual(tree(real), []);
  });

  it("project scope refuses a skills dir that escapes the project", () => {
    const real = join(sb.outside, "escape");
    mkdirSync(real);
    symlinkSync(real, join(sb.proj, ".claude"));
    const r = run(sb, ["install", "--agent", "claude-code", "--project"]);
    assert.equal(r.status, 1);
    assert.deepEqual(tree(real), []);
  });

  it("project containment check rejects a resolved path outside cwd", () => {
    const env: InstallEnv = { home: sb.home, cwd: sb.proj, path: sb.bin };
    const res = installOne(
      { label: "x", dest: join(sb.outside, "SKILL.md"), containWithin: sb.proj },
      SKILL,
      env,
      { dryRun: false, force: false },
    );
    assert.equal(res.status, "refused");
    assert.match(res.message, /outside the project directory/);
    assert.equal(existsSync(join(sb.outside, "SKILL.md")), false);
  });

  it("project scope works when cwd is outside HOME", () => {
    const r = run(sb, ["install", "--project", "--agent", "codex"], { cwd: sb.outside });
    assert.equal(r.status, 0, r.out);
    assert.ok(existsSync(join(sb.outside, ".agents", "skills", "leanrea", "SKILL.md")));
  });
});

describe("install: flags", () => {
  const bad: string[][] = [
    ["install", "--global", "--project"],
    ["install", "--dest", "/tmp/x/SKILL.md", "--agent", "all"],
    ["install", "--dest", "/tmp/x/SKILL.md", "--global"],
    ["install", "--dest", "/tmp/x/SKILL.md", "--project"],
    ["install", "--agent", "vim"],
    ["install", "--bogus"],
    ["print", "--force"],
  ];
  for (const args of bad) {
    it(`exit 2: ${args.join(" ")}`, () => {
      const r = run(sb, args);
      assert.equal(r.status, 2, r.out);
      assert.deepEqual(tree(sb.home).filter((f) => f !== "proj"), []);
    });
  }
});

describe("install: --agent all", () => {
  it("installs every agent", () => {
    const r = run(sb, ["install", "--agent", "all"]);
    assert.equal(r.status, 0, r.out);
    for (const a of AGENTS) assert.ok(readFileSync(expectedDest(sb, a, "global")).equals(SKILL));
  });

  it("reports partial failure per agent and exits non-zero", () => {
    const blocked = expectedDest(sb, "claude-code", "global");
    mkdirSync(join(blocked, ".."), { recursive: true });
    writeFileSync(blocked, "different\n");
    const r = run(sb, ["install", "--agent", "all"]);
    assert.equal(r.status, 1);
    assert.match(r.out, /opencode \(global\): installed/);
    assert.match(r.out, /claude-code \(global\): refused/);
    assert.match(r.out, /codex \(global\): installed/);
    assert.ok(readFileSync(expectedDest(sb, "opencode", "global")).equals(SKILL));
    assert.ok(readFileSync(expectedDest(sb, "codex", "global")).equals(SKILL));
    assert.equal(readFileSync(blocked, "utf8"), "different\n");
  });
});

describe("install: dry run and chezmoi", () => {
  it("--dry-run writes nothing", () => {
    const before = [tree(sb.home), tree(sb.xdg)];
    const r = run(sb, ["install", "--agent", "all", "--dry-run"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /would install/);
    assert.deepEqual([tree(sb.home), tree(sb.xdg)], before);

    const r2 = run(sb, ["install", "--agent", "opencode", "--project", "--dry-run"]);
    assert.equal(r2.status, 0, r2.out);
    assert.deepEqual([tree(sb.home), tree(sb.xdg)], before);
  });

  it("--dry-run on a different file reports would overwrite with --force, refusal without", () => {
    const dest = expectedDest(sb, "opencode", "global");
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, "old\n");
    assert.equal(run(sb, ["install", "--dry-run"]).status, 1);
    const r = run(sb, ["install", "--dry-run", "--force"]);
    assert.equal(r.status, 0);
    assert.match(r.out, /would overwrite/);
    assert.equal(readFileSync(dest, "utf8"), "old\n");
  });

  it("refuses chezmoi-managed targets even with --force", () => {
    const r = run(sb, ["install", "--agent", "claude-code", "--force"], {
      env: { FAKE_CHEZMOI_MANAGED: join(sb.home, ".claude") },
    });
    assert.equal(r.status, 1);
    assert.match(r.out, /managed by chezmoi/);
    assert.equal(existsSync(join(sb.home, ".claude")), false);
  });

  it("unmanaged targets install normally with chezmoi on PATH", () => {
    const r = run(sb, ["install", "--agent", "codex"], { env: { FAKE_CHEZMOI_MANAGED: join(sb.home, ".claude") } });
    assert.equal(r.status, 0, r.out);
  });
});
