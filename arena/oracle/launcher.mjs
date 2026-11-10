import { spawn } from "node:child_process";

// Only the trusted oracle inherits the score pipe. Its candidate worker creates
// fresh stdio/IPC channels and cannot inherit this descriptor.
const child = spawn(process.execPath, [process.argv[2], process.argv[3]], {
  env: { ...process.env, ARENA_SCORE_FD: "3" },
  stdio: ["ignore", "pipe", "pipe", "pipe"],
});
const scores = [];
let bytes = 0;
let failure;
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => process.stderr.write(chunk));
child.stdio[3].on("data", (chunk) => {
  bytes += chunk.length;
  if (bytes > 4 * 1024 * 1024) {
    failure = "Oracle score channel exceeded allowance";
    child.kill("SIGKILL");
  } else scores.push(chunk);
});
child.once("error", (error) => {
  failure = error.message;
});
child.once("close", (code, signal) => {
  if (failure || signal || ![0, 1].includes(code)) {
    process.stderr.write(`${failure ?? `Oracle exited ${code}/${signal}`}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(Buffer.concat(scores));
  process.exitCode = code;
});
