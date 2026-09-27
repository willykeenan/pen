// Compiles and runs the portable C tests for the hold-to-capture helper: the
// state machine and the stdio protocol. They use no operating-system headers,
// so the same suite runs on macOS, Windows and Linux CI.
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "native", "hold");
const compiler = findCompiler();
if (!compiler) {
  process.stderr.write("No C compiler (cc, clang, gcc or cl) was found for the native tests.\n");
  process.exit(1);
}

const workDirectory = await mkdtemp(path.join(os.tmpdir(), "ke-pen-native-test-"));
const suites = [
  { name: "hold_core", files: ["hold_core.c", "tests/hold_core_test.c"] },
  { name: "protocol", files: ["hold_core.c", "protocol.c", "tests/protocol_test.c"] },
];

let failed = false;
try {
  for (const suite of suites) {
    const output = path.join(workDirectory, `${suite.name}_test${process.platform === "win32" ? ".exe" : ""}`);
    const inputs = suite.files.map((file) => path.join(source, file));
    const args =
      compiler.kind === "msvc"
        ? ["/nologo", "/W4", "/O2", ...inputs, `/Fe:${output}`, `/Fo:${workDirectory}${path.sep}`]
        : ["-std=c99", "-O2", "-Wall", "-Wextra", "-Werror", "-o", output, ...inputs];
    const build = spawnSync(compiler.command, args, { encoding: "utf8", cwd: workDirectory });
    if (build.status !== 0) {
      process.stderr.write(`${build.stdout ?? ""}${build.stderr ?? ""}`);
      throw new Error(`Compiling the ${suite.name} tests failed with ${compiler.command}.`);
    }
    const run = spawnSync(output, [], { encoding: "utf8", timeout: 60_000 });
    process.stdout.write(run.stdout ?? "");
    process.stderr.write(run.stderr ?? "");
    if (run.status !== 0) failed = true;
  }
} finally {
  await rm(workDirectory, { recursive: true, force: true });
}

if (failed) {
  process.stderr.write("PEN_NATIVE_TESTS_FAILED\n");
  process.exit(1);
}
process.stdout.write(`PEN_NATIVE_TESTS_OK compiler=${compiler.command}\n`);

function findCompiler() {
  const candidates =
    process.platform === "win32"
      ? [
          { command: "clang", kind: "gnu" },
          { command: "gcc", kind: "gnu" },
          { command: "cl", kind: "msvc" },
        ]
      : [
          { command: "cc", kind: "gnu" },
          { command: "clang", kind: "gnu" },
          { command: "gcc", kind: "gnu" },
        ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, candidate.kind === "msvc" ? [] : ["--version"], {
      encoding: "utf8",
    });
    if (!probe.error && (candidate.kind === "msvc" || probe.status === 0)) return candidate;
  }
  return null;
}
