import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { projectRoot, provenance, resolvePiLauncher } from "../../bench/evidence.ts";

const executeFile = promisify(execFile);

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pinata-bench-launcher-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

const nodeScript = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  if (typeof globalThis.gc !== "function") throw new Error("Pi version probe has no GC");
  process.stdout.write("fixture-pi-1.0");
} else {
  globalThis.gc();
  process.stdout.write(JSON.stringify({
    interpreter: process.execPath,
    gc: typeof globalThis.gc,
    execArgv: process.execArgv,
    args: process.argv.slice(1),
  }));
}
`;

test("Pi Node entrypoints run with the selected interpreter and exposed GC", async (t) => {
  const path = await directory(t);
  const entrypoint = join(path, "pi cli.mjs");
  await writeFile(entrypoint, nodeScript);
  const launch = await resolvePiLauncher(entrypoint, process.execPath);
  const interpreter = await realpath(process.execPath);
  assert.equal(launch.kind, "node-script");
  assert.equal(launch.shebang, "#!/usr/bin/env node");
  assert.equal(launch.command, interpreter);
  assert.deepEqual(launch.args, ["--expose-gc", await realpath(entrypoint)]);
  const args = ["--mode", "rpc", "argument with spaces", "literal;$value"];
  const { stdout } = await executeFile(launch.command, [...launch.args, ...args]);
  assert.deepEqual(JSON.parse(stdout), {
    interpreter,
    gc: "function",
    execArgv: ["--expose-gc"],
    args: [await realpath(entrypoint), ...args],
  });

  const metadata = await provenance(await projectRoot(), {
    piLauncher: launch,
    configuration: {},
    workloads: [],
    agentDir: path,
    storageDirectory: path,
  });
  assert.deepEqual(metadata.piLauncher, {
    path: await realpath(entrypoint),
    digest: createHash("sha256").update(nodeScript).digest("hex"),
    version: "fixture-pi-1.0",
    kind: "node-script",
    shebang: "#!/usr/bin/env node",
    command: [interpreter, "--expose-gc", await realpath(entrypoint)],
    interpreter: {
      path: interpreter,
      node: process.version,
      digest: createHash("sha256")
        .update(await readFile(interpreter))
        .digest("hex"),
    },
  });
});

test(
  "extensionless Pi symlinks resolve to their Node entrypoint before choosing GC flags",
  { skip: process.platform === "win32" },
  async (t) => {
    const path = await directory(t);
    const entrypoint = join(path, "entrypoint.js");
    const link = join(path, "pi");
    await writeFile(entrypoint, nodeScript);
    await symlink(entrypoint, link);
    const launch = await resolvePiLauncher(link, process.execPath);
    const { stdout } = await executeFile(launch.command, [...launch.args, "--mode", "rpc"]);
    assert.equal(launch.path, await realpath(entrypoint));
    assert.equal(launch.kind, "node-script");
    assert.deepEqual(JSON.parse(stdout).args, [await realpath(entrypoint), "--mode", "rpc"]);
    assert.equal(JSON.parse(stdout).gc, "function");
  },
);

test("Pi launcher classification preserves native executables and unknown wrappers", async (t) => {
  const path = await directory(t);
  const fixtures = [
    { name: "absolute.cjs", shebang: "#!/opt/node/bin/node", kind: "node-script" },
    { name: "spaces.mjs", shebang: "#! /usr/bin/env node  ", kind: "node-script" },
    { name: "flagged.js", shebang: "#!/usr/bin/env -S node --no-warnings", kind: "script" },
    { name: "shell.js", shebang: "#!/bin/sh", kind: "script" },
    { name: "extensionless", shebang: "#!/usr/bin/env node", kind: "script" },
    { name: "plain.js", shebang: "", kind: "executable" },
  ];
  const interpreter = await realpath(process.execPath);
  for (const fixture of fixtures) {
    const entrypoint = join(path, fixture.name);
    await writeFile(entrypoint, `${fixture.shebang}\n`);
    const launch = await resolvePiLauncher(entrypoint, process.execPath);
    const canonical = await realpath(entrypoint);
    assert.equal(launch.kind, fixture.kind, fixture.name);
    assert.equal(launch.shebang, fixture.shebang || null, fixture.name);
    assert.equal(launch.command, fixture.kind === "node-script" ? interpreter : canonical);
    assert.deepEqual(launch.args, fixture.kind === "node-script" ? ["--expose-gc", canonical] : []);
  }
  assert.deepEqual(await resolvePiLauncher(process.execPath, process.execPath), {
    path: interpreter,
    command: interpreter,
    args: [],
    kind: "executable",
    shebang: null,
  });
});
