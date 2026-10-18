import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { findPackage } from "../src/skill.js";

export const MAX_BYTES = 10240;
export const MAX_DESCRIPTION = 1024;
export const MAX_COMPATIBILITY = 500;
export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface Frontmatter {
  /** Top-level scalar fields (unquoted). */
  fields: Map<string, string>;
  /** metadata: string -> string map. */
  metadata: Map<string, string>;
}

function unquote(v: string, where: string): string {
  const t = v.trim();
  if (t.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(t)) throw new Error(`${where}: bad double-quoted string`);
    return JSON.parse(t) as string;
  }
  if (t.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(t)) throw new Error(`${where}: bad single-quoted string`);
    return t.slice(1, -1).replaceAll("''", "'");
  }
  if (/: | #|^[-?:,[\]{}#&*!|>'"%@`]/.test(t)) throw new Error(`${where}: plain value needs quoting`);
  return t;
}

/**
 * Parse the small YAML subset SKILL.md frontmatter uses: `key: scalar` lines and
 * one `metadata:` map of `  key: "string"` lines. Anything else is an error, so
 * the linter never silently accepts a shape the agents might read differently.
 */
export function parseFrontmatter(src: string): Frontmatter {
  const fields = new Map<string, string>();
  const metadata = new Map<string, string>();
  let inMeta = false;
  for (const [i, line] of src.split("\n").entries()) {
    const where = `frontmatter line ${i + 2}`;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const nested = /^ {2}([A-Za-z0-9_./-]+):[ ]+(.+)$/.exec(line);
    if (nested) {
      if (!inMeta) throw new Error(`${where}: unexpected indented line`);
      const val = nested[2] ?? "";
      if (!/^["']/.test(val.trim())) throw new Error(`${where}: metadata values must be quoted strings`);
      metadata.set(nested[1] ?? "", unquote(val, where));
      continue;
    }
    const top = /^([a-z][a-z0-9_-]*):(?:[ ]+(.*))?$/.exec(line);
    if (!top) throw new Error(`${where}: cannot parse ${JSON.stringify(line.slice(0, 60))}`);
    const key = top[1] ?? "";
    const val = top[2];
    if (fields.has(key) || (key === "metadata" && inMeta)) throw new Error(`${where}: duplicate key ${key}`);
    if (key === "metadata") {
      if (val !== undefined && val.trim() !== "") throw new Error(`${where}: metadata must be a map`);
      inMeta = true;
      continue;
    }
    inMeta = false;
    if (val === undefined || val.trim() === "") throw new Error(`${where}: ${key} has no value`);
    fields.set(key, unquote(val, where));
  }
  return { fields, metadata };
}

const NPX_PINNED = /^npx\s+(?:-y\s+)?(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?=[\s`'"]|$)/;

/** Pure linter for SKILL.md content. Returns a list of problems (empty = ok). */
export function lintSkill(buf: Buffer, opts: { version?: string } = {}): string[] {
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
  if (!fm) {
    errs.push("missing YAML frontmatter (--- ... ---) at the top");
    return errs;
  }
  let meta: Frontmatter;
  try {
    meta = parseFrontmatter(fm[1] ?? "");
  } catch (e) {
    errs.push(`frontmatter: ${(e as Error).message}`);
    return errs;
  }
  const name = meta.fields.get("name");
  if (name !== "leanrea") errs.push("frontmatter is missing `name: leanrea`");
  if (name !== undefined && (!NAME_RE.test(name) || name.length > 64)) errs.push(`frontmatter name ${JSON.stringify(name)} must match ${NAME_RE} (max 64 chars)`);
  const desc = meta.fields.get("description");
  if (!desc) errs.push("frontmatter is missing a description");
  else if (desc.length > MAX_DESCRIPTION) errs.push(`description is ${desc.length} chars (max ${MAX_DESCRIPTION})`);
  const compat = meta.fields.get("compatibility");
  if (compat !== undefined && compat.length > MAX_COMPATIBILITY) errs.push(`compatibility is ${compat.length} chars (max ${MAX_COMPATIBILITY})`);
  if (opts.version !== undefined) {
    const v = meta.metadata.get("version");
    if (v !== opts.version) errs.push(`metadata.version ${JSON.stringify(v ?? null)} != package.json version ${JSON.stringify(opts.version)}`);
  }
  return errs;
}

function main(): number {
  const file = process.argv[2] ?? "leanrea/SKILL.md";
  const buf = readFileSync(file);
  const errs = lintSkill(buf, { version: findPackage().version });
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
