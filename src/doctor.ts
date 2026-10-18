import { which } from "./installer.js";

export const TOOL_GROUPS: ReadonlyArray<{ group: string; tools: readonly string[] }> = [
  { group: "Linux (ELF first move)", tools: ["file", "readelf", "nm", "objdump", "strings", "grep", "awk", "rg", "jq"] },
  { group: "macOS (Mach-O first move, Xcode CLT)", tools: ["file", "lipo", "otool", "nm", "strings", "codesign", "xcrun", "plutil"] },
  {
    group: "optional",
    tools: [
      "node",
      "npx",
      "go",
      "cargo",
      "llvm-objdump",
      "llvm-nm",
      "jadx",
      "apktool",
      "r2",
      "analyzeHeadless",
      "binwalk",
      "unblob",
      "wasm-objdump",
      "tshark",
      "sqlite3",
      "ilspycmd",
      "strace",
      "gdb",
      "lldb",
    ],
  },
];

export function doctorReport(pathEnv: string, platform: NodeJS.Platform = process.platform): string {
  const lines: string[] = [`leanrea doctor (platform: ${platform})`];
  for (const { group, tools } of TOOL_GROUPS) {
    lines.push("", `${group}:`);
    for (const t of tools) {
      const p = which(t, pathEnv);
      lines.push(`  ${p ? "ok     " : "missing"} ${t}${p ? `  (${p})` : ""}`);
    }
  }
  lines.push("", "Missing tools are not blockers; SKILL.md lists fallbacks. Ask before installing anything.");
  return lines.join("\n") + "\n";
}
