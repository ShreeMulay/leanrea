import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MAX_BYTES = 10240;

const NPX_PINNED = /^npx\s+(?:-y\s+)?(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?=[\s`'"]|$)/;

/** Pure linter for SKILL.md content. Returns a list of problems (empty = ok). */
export function lintSkill(buf: Buffer): string[] {
  const errs: string[] = [];
  const text = buf.toString("utf8");
  if (buf.length > MAX_BYTES) errs.push(`size ${buf.length} B exceeds ${MAX_BYTES} B`);

  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const n = i + 1;
    if (line.includes("\\|")) errs.push(`line ${n}: contains an escaped pipe (\\|); move the command into a fenced code block`);
    if (line.includes("$TMPDIR/re")) errs.push(`line ${n}: uses $TMPDIR/re; use a mktemp -d scratch dir`);
    const re = /\bnpx\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (!NPX_PINNED.test(line.slice(m.index))) {
        errs.push(`line ${n}: npx must be followed by [-y] <pkg>@<exact-version>: ${line.slice(m.index, m.index + 60)}`);
      }
    }
  });

  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!fm) errs.push("missing YAML frontmatter (--- ... ---) at the top");
  else if (!/^name:\s*leanrea\s*$/m.test(fm[1] ?? "")) errs.push("frontmatter is missing `name: leanrea`");
  return errs;
}

function main(): number {
  const file = process.argv[2] ?? "leanrea/SKILL.md";
  const buf = readFileSync(file);
  const errs = lintSkill(buf);
  if (errs.length) {
    for (const e of errs) process.stderr.write(`${file}: ${e}\n`);
    process.stderr.write(`lint-skill: ${errs.length} problem(s)\n`);
    return 1;
  }
  process.stdout.write(`lint-skill: ${file} ok (${buf.length}/${MAX_BYTES} bytes)\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
