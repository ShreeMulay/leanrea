/**
 * Fake agent for bench tests. Emits Claude-style stream-json. Modes (FAKE_AGENT_MODE):
 *   answer (default): answer = FAKE_AGENT_ANSWER
 *   env:    answer = sorted env var names this process received
 *   cwd:    answer = process.cwd() and the files in it
 *   ansi:   answer wrapped in ANSI escapes and padded past the size cap
 *   hang:   spawn a grandchild in the same process group, write its pid to FAKE_AGENT_PIDFILE, never exit
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const prompt = readFileSync(0, "utf8");
const mode = process.env.FAKE_AGENT_MODE ?? "answer";

function emit(answer: string): void {
  const tool = { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "readelf -hW ./tsc" } }] } };
  const result = {
    type: "result",
    result: answer,
    num_turns: 2,
    total_cost_usd: 0,
    is_error: false,
    usage: { input_tokens: prompt.length, output_tokens: answer.length, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
  process.stdout.write(JSON.stringify(tool) + "\n" + JSON.stringify(result) + "\n");
}

switch (mode) {
  case "env":
    emit(Object.keys(process.env).sort().join(","));
    break;
  case "cwd":
    emit(`${process.cwd()}\n${readdirSync(".").sort().join(",")}`);
    break;
  case "ansi":
    emit(`\u001b[31m${process.env.FAKE_AGENT_ANSWER ?? ""}\u001b[0m\u0007` + "x".repeat(200_000));
    break;
  case "hang": {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    if (process.env.FAKE_AGENT_PIDFILE) writeFileSync(process.env.FAKE_AGENT_PIDFILE, String(child.pid));
    setInterval(() => {}, 1000);
    break;
  }
  default:
    emit(process.env.FAKE_AGENT_ANSWER ?? "");
}
