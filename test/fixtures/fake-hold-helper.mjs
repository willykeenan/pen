// A stand-in for ke-pen-hold-helper that speaks the same stdio protocol but
// never touches real input. Used by the supervisor unit tests and by the
// --hold-proof runtime gate. Behaviour comes from the environment:
//   FAKE_HOLD_MODE     normal | crash | silent | needs-permission | wrong-version | hold-on-arm
//   FAKE_HOLD_VERSION  version to report in "ready" (default 0.0.0-test)
//   FAKE_HOLD_LOG      file that receives every command line, one per line
//   FAKE_HOLD_COUNT    hold-on-arm: how many holds to send in total (default 1)
//   FAKE_HOLD_IGNORE_QUIT  "1": ignore {"cmd":"quit"} and wait for stdin to close
import { appendFileSync } from "node:fs";

const mode = process.env.FAKE_HOLD_MODE ?? "normal";
const version = process.env.FAKE_HOLD_VERSION ?? "0.0.0-test";
const log = process.env.FAKE_HOLD_LOG;
const holdLimit = Number(process.env.FAKE_HOLD_COUNT ?? 1);
let holdsSent = 0;
let armed = false;

function send(message) {
  process.stdout.write(`${JSON.stringify({ v: 1, ...message })}\n`);
}

if (mode === "crash") {
  send({ type: "ready", name: "ke-pen-hold-helper", version, protocol: 1, platform: "test" });
  setTimeout(() => process.exit(3), 20);
} else if (mode !== "silent") {
  send({
    type: "ready",
    name: "ke-pen-hold-helper",
    version: mode === "wrong-version" ? "9.9.9" : version,
    protocol: 1,
    platform: "test",
  });
  if (mode === "needs-permission") send({ type: "needs-permission", permission: "accessibility" });
  else if (mode !== "wrong-version") send({ type: "active" });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (log) appendFileSync(log, `${line}\n`);
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      send({ type: "error", code: "bad-syntax" });
      continue;
    }
    if (command.cmd === "quit" && process.env.FAKE_HOLD_IGNORE_QUIT !== "1") process.exit(0);
    if (command.cmd === "arm") {
      armed = true;
      if (mode === "hold-on-arm" && holdsSent < holdLimit) {
        setTimeout(() => {
          if (!armed) return;
          holdsSent += 1;
          send({ type: "hold", seq: holdsSent });
        }, 150);
      }
    }
    if (command.cmd === "disarm") armed = false;
  }
});
process.stdin.on("end", () => process.exit(0));
