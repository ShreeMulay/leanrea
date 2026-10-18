import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AGENTS, type Agent, installOne, type InstallEnv } from "../src/installer.js";
import { KNOWN_RELEASES, sha256 } from "../src/known-releases.js";
import { PKG, run, type Sandbox, sandbox, tree } from "./helpers.js";

const SKILL = readFileSync(PKG.skillPath);
const V010 = readFileSync(join(PKG.root, "test", "fixtures", "releases", "0.1.0", "SKILL.md"));

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
  it("writes the Claude Code and Codex dirs only (OpenCode reads both)", () => {
    const r = run(sb, ["install", "--agent", "all"]);
    assert.equal(r.status, 0, r.out);
    assert.ok(readFileSync(expectedDest(sb, "claude-code", "global")).equals(SKILL));
    assert.ok(readFileSync(expectedDest(sb, "codex", "global")).equals(SKILL));
    assert.equal(existsSync(join(sb.xdg, "opencode")), false, "--agent all must not write the OpenCode dir");
    assert.doesNotMatch(r.out, /opencode \(global\)/);
  });

  it("project scope writes .claude and .agents only", () => {
    const r = run(sb, ["install", "--agent", "all", "--project"]);
    assert.equal(r.status, 0, r.out);
    assert.ok(existsSync(expectedDest(sb, "claude-code", "project")));
    assert.ok(existsSync(expectedDest(sb, "codex", "project")));
    assert.equal(existsSync(join(sb.proj, ".opencode")), false);
  });

  it("upgrades a known-old OpenCode-dir copy and warns about an unknown one", () => {
    const oc = expectedDest(sb, "opencode", "global");
    mkdirSync(join(oc, ".."), { recursive: true });
    writeFileSync(oc, V010);
    const r = run(sb, ["install", "--agent", "all"]);
    assert.equal(r.status, 0, r.out);
    assert.ok(readFileSync(oc).equals(SKILL));
    assert.match(r.out, /upgraded .* from leanrea 0\.1\.0 \(also read by opencode\)/);

    writeFileSync(oc, "my own skill\n");
    const r2 = run(sb, ["install", "--agent", "all"]);
    assert.equal(r2.status, 0, r2.out);
    assert.match(r2.stderr, /warning: .*opencode.*not a known release/);
    assert.equal(readFileSync(oc, "utf8"), "my own skill\n");
  });

  it("reports partial failure per agent and exits non-zero", () => {
    const blocked = expectedDest(sb, "claude-code", "global");
    mkdirSync(join(blocked, ".."), { recursive: true });
    writeFileSync(blocked, "different\n");
    const r = run(sb, ["install", "--agent", "all"]);
    assert.equal(r.status, 1);
    assert.match(r.out, /claude-code \(global\): refused/);
    assert.match(r.out, /codex \(global\): installed/);
    assert.ok(readFileSync(expectedDest(sb, "codex", "global")).equals(SKILL));
    assert.equal(readFileSync(blocked, "utf8"), "different\n");
  });
});

describe("install: known releases", () => {
  it("the 0.1.0 fixture is the released file", () => {
    assert.equal(sha256(V010), KNOWN_RELEASES["0.1.0"]);
  });

  it("upgrades a known release without --force", () => {
    const dest = expectedDest(sb, "claude-code", "global");
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, V010);
    const r = run(sb, ["install", "--agent", "claude-code"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /claude-code \(global\): upgraded: upgraded .* from leanrea 0\.1\.0/);
    assert.ok(readFileSync(dest).equals(SKILL));
    assert.deepEqual(tree(join(dest, "..")), ["SKILL.md"], "temp files left behind");
  });

  it("refuses a modified known release without --force", () => {
    const dest = expectedDest(sb, "codex", "global");
    mkdirSync(join(dest, ".."), { recursive: true });
    const edited = Buffer.concat([V010, Buffer.from("\n- my local rule\n")]);
    writeFileSync(dest, edited);
    const r = run(sb, ["install", "--agent", "codex"]);
    assert.equal(r.status, 1);
    assert.match(r.out, /not a known leanrea release \(use --force\)/);
    assert.ok(readFileSync(dest).equals(edited));
  });

  it("dry run reports would-upgrade and writes nothing", () => {
    const dest = expectedDest(sb, "opencode", "global");
    const cc = expectedDest(sb, "claude-code", "global");
    for (const d of [dest, cc]) {
      mkdirSync(join(d, ".."), { recursive: true });
      writeFileSync(d, V010);
    }
    const before = [tree(sb.home), tree(sb.xdg)];
    const r = run(sb, ["install", "--dry-run"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /opencode \(global\): would-upgrade/);
    assert.match(r.out, /other copy \(read by opencode\): would-upgrade: .*\.claude/);
    assert.deepEqual([tree(sb.home), tree(sb.xdg)], before);
    assert.ok(readFileSync(dest).equals(V010));
    assert.ok(readFileSync(cc).equals(V010));
  });

  it("conflicting copies: known-old upgraded, unknown warned, exit 0", () => {
    const cc = expectedDest(sb, "claude-code", "global");
    const cx = expectedDest(sb, "codex", "global");
    for (const d of [cc, cx]) mkdirSync(join(d, ".."), { recursive: true });
    writeFileSync(cc, V010);
    writeFileSync(cx, "someone else's leanrea\n");
    const r = run(sb, ["install", "--agent", "opencode"]);
    assert.equal(r.status, 0, r.out);
    assert.ok(readFileSync(expectedDest(sb, "opencode", "global")).equals(SKILL));
    assert.ok(readFileSync(cc).equals(SKILL), "known-old copy was not upgraded");
    assert.match(r.stdout.toString(), /upgraded .*\.claude.* from leanrea 0\.1\.0 \(also read by opencode\)/);
    assert.equal(readFileSync(cx, "utf8"), "someone else's leanrea\n");
    assert.match(r.stderr, /warning: .*\.agents.*not a known release/);
    assert.doesNotMatch(r.stdout.toString(), /warning/);
  });

  it("does not scan dirs the selected agent doesn't read", () => {
    const oc = expectedDest(sb, "opencode", "global");
    mkdirSync(join(oc, ".."), { recursive: true });
    writeFileSync(oc, V010);
    const r = run(sb, ["install", "--agent", "codex"]);
    assert.equal(r.status, 0, r.out);
    assert.ok(readFileSync(oc).equals(V010));
  });

  it("a symlinked duplicate is warned about, never followed", () => {
    const victim = join(sb.outside, "victim.md");
    writeFileSync(victim, V010);
    const cc = expectedDest(sb, "claude-code", "global");
    mkdirSync(join(cc, ".."), { recursive: true });
    symlinkSync(victim, cc);
    const r = run(sb, ["install"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stderr, /not a regular file/);
    assert.ok(readFileSync(victim).equals(V010));
  });

  it("refuses when the file changes between the check and the rename", () => {
    const env: InstallEnv = { home: sb.home, cwd: sb.proj, path: sb.bin };
    const dest = expectedDest(sb, "codex", "global");
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, V010);
    const res = installOne({ label: "x", dest }, SKILL, env, {
      dryRun: false,
      force: false,
      beforeCommit: (d) => writeFileSync(d, "edited concurrently\n"),
    });
    assert.equal(res.status, "refused", res.message);
    assert.match(res.message, /changed while upgrading/);
    assert.equal(readFileSync(dest, "utf8"), "edited concurrently\n");
    assert.deepEqual(tree(join(dest, "..")), ["SKILL.md"], "temp file left behind");

    writeFileSync(dest, V010);
    const victim = join(sb.outside, "v.md");
    writeFileSync(victim, "keep\n");
    const res2 = installOne({ label: "x", dest }, SKILL, env, {
      dryRun: false,
      force: false,
      beforeCommit: (d) => {
        unlinkSync(d);
        symlinkSync(victim, d);
      },
    });
    assert.equal(res2.status, "refused", res2.message);
    assert.equal(readFileSync(victim, "utf8"), "keep\n");
  });

  it("chezmoi-managed known release is still refused", () => {
    const dest = expectedDest(sb, "claude-code", "global");
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, V010);
    const r = run(sb, ["install", "--agent", "claude-code"], { env: { FAKE_CHEZMOI_MANAGED: join(sb.home, ".claude") } });
    assert.equal(r.status, 1);
    assert.match(r.out, /managed by chezmoi/);
    assert.ok(readFileSync(dest).equals(V010));
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
