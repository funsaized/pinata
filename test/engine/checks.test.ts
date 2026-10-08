import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { environment, runCheck, runChecks } from "../../engine/verify/checks.ts";
import { tempDir } from "./helpers.ts";

const node = process.execPath;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("checks pass and fail by exit code; logs are kept and hashed; the first failure stops the list", async (t) => {
  const dir = await tempDir(t);
  const env = environment();
  const results = await runChecks(
    [
      { id: "ok", argv: [node, "-e", "console.log('hello'); console.error('warn')"] },
      { id: "bad", argv: [node, "-e", "process.exit(3)"] },
      { id: "never", argv: [node, "-e", "0"] },
    ],
    { cwd: dir, env, logDir: join(dir, "logs") },
  );
  assert.deepEqual(
    results.map((r) => [r.id, r.passed, r.code]),
    [
      ["ok", true, 0],
      ["bad", false, 3],
    ],
  );
  assert.equal((await readFile(results[0].stdout, "utf8")).trim(), "hello");
  assert.equal((await readFile(results[0].stderr, "utf8")).trim(), "warn");
  assert.match(results[0].stdoutSha256, /^[0-9a-f]{64}$/);
});

test("a timed-out check is killed with everything it started", async (t) => {
  const dir = await tempDir(t);
  const pidFile = join(dir, "grandchild.pid");
  const script = `
    const { spawn } = require("node:child_process");
    const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
    setInterval(() => {}, 1000);`;
  const r = await runCheck(
    { id: "hang", argv: [node, "-e", script], timeoutMs: 1500 },
    { cwd: dir, env: environment(), logDir: dir },
  );
  assert.equal(r.passed, false);
  assert.equal(r.reason, "timed out");
  const grandchild = Number(await readFile(pidFile, "utf8"));
  for (let i = 0; i < 50 && alive(grandchild); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(grandchild), false, "no survivors");
});

test("runaway output is stopped at the log limit", async (t) => {
  const dir = await tempDir(t);
  const r = await runCheck(
    {
      id: "loud",
      argv: [
        node,
        "-e",
        "const b = 'x'.repeat(65536); setInterval(() => process.stdout.write(b), 1)",
      ],
      timeoutMs: 10_000,
    },
    { cwd: dir, env: environment(), logDir: dir, maxLog: 1024 * 1024 },
  );
  assert.equal(r.passed, false);
  assert.equal(r.reason, "output exceeded the limit");
});

test("checks get an allowlisted environment, passEnv, and the recursion guard", async (t) => {
  const dir = await tempDir(t);
  process.env.PINATA_TEST_SECRET = "do-not-leak";
  process.env.PINATA_TEST_PASS = "passed";
  try {
    const r = await runCheck(
      {
        id: "env",
        argv: [
          node,
          "-e",
          "console.log(JSON.stringify({ s: process.env.PINATA_TEST_SECRET, p: process.env.PINATA_TEST_PASS, a: process.env.PINATA_AGENT }))",
        ],
      },
      { cwd: dir, env: environment(["PINATA_TEST_PASS"]), logDir: dir },
    );
    assert.deepEqual(JSON.parse(await readFile(r.stdout, "utf8")), { p: "passed", a: "1" });
  } finally {
    delete process.env.PINATA_TEST_SECRET;
    delete process.env.PINATA_TEST_PASS;
  }
});

test("a command that does not exist fails cleanly", async (t) => {
  const dir = await tempDir(t);
  const r = await runCheck(
    { id: "missing", argv: ["pinata-no-such-command-xyz"] },
    { cwd: dir, env: environment(), logDir: dir },
  );
  assert.equal(r.passed, false);
  assert.match(r.reason ?? String(r.code), /cannot launch|1|9009/);
});

test(
  "Windows .cmd launchers run without a shell string and keep awkward arguments",
  { skip: process.platform !== "win32" },
  async (t) => {
    const dir = await tempDir(t);
    await writeFile(
      join(dir, "echo-args.cmd"),
      `@"${node}" -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n`,
    );
    const args = ["plain", "with space", 'quote"inside', "amp&and", "pipe|x", "percent%PATH%"];
    const env = {
      ...environment(),
      PATH: `${dir};${process.env.PATH}`,
      Path: `${dir};${process.env.Path ?? process.env.PATH}`,
    };
    const r = await runCheck(
      { id: "cmd", argv: ["echo-args", ...args] },
      { cwd: dir, env, logDir: dir },
    );
    assert.equal(r.passed, true, await readFile(r.stderr, "utf8"));
    assert.deepEqual(JSON.parse(await readFile(r.stdout, "utf8")), args);
  },
);
