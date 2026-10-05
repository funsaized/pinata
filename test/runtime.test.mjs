import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveNode } from "../lib/runtime.mjs";
import { doctor } from "../lib/preflight.mjs";
import { atomic, readJson, sleep, living, shellQuote } from "../lib/core.mjs";
import { start } from "../lib/pinata.mjs";
import { fixture, task, settled } from "./helpers.mjs";

test("preflight resolves a standalone script runner and reports its actual Node version", async () => {
  const runtime = await resolveNode();
  assert.equal(runtime.node, await fs.realpath(process.execPath));
  assert.equal(runtime.version, process.version);
});

test("preflight rejects missing, non-Node and unsupported runtimes before probing Pi", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinata-node-"));
  const previous = process.env.PATH;
  process.env.PATH = dir;
  t.after(async () => {
    process.env.PATH = previous;
    await fs.rm(dir, { recursive: true, force: true });
  });
  const check = () => doctor({ pi: "/must-not-launch-pi", herdr: "/must-not-launch-herdr" });
  await assert.rejects(check(), /Missing executable: node/);
  for (const [output, error] of [
    ["1.0.3", /Standalone Node cannot execute scripts/],
    [JSON.stringify({ version: "24.3.0", bun: true }), /Standalone Node cannot execute scripts/],
    [JSON.stringify({ version: "22.18.0", bun: false }), /Node >=22.19.0/],
  ]) {
    await fs.writeFile(path.join(dir, "node"), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, {
      mode: 0o700,
    });
    await assert.rejects(check(), error);
  }
});

test("version-manager wrappers resolve to the actual standalone Node executable", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinata-node-wrapper-"));
  const previous = process.env.PATH;
  await fs.writeFile(
    path.join(dir, "node"),
    `#!/bin/sh\ncase "$0" in */node) exec ${shellQuote(process.execPath)} "$@";; *) exit 1;; esac\n`,
    { mode: 0o700 },
  );
  process.env.PATH = dir;
  t.after(async () => {
    process.env.PATH = previous;
    await fs.rm(dir, { recursive: true, force: true });
  });
  assert.equal((await resolveNode()).node, await fs.realpath(process.execPath));
  await fs.rename(path.join(dir, "node"), path.join(dir, "runtime-shim"));
  await fs.symlink("runtime-shim", path.join(dir, "node"));
  assert.equal((await resolveNode()).node, await fs.realpath(process.execPath));
});

test("legacy runs resolve Node before both direct and background worker launches", async (t) => {
  for (const background of [false, true]) {
    const f = await fixture(t, [task("one")]);
    const legacy = await f.manifest();
    delete legacy.runtime;
    legacy.versions.node = "1.0.3";
    await atomic(path.join(f.run, "manifest.json"), legacy);
    if (background) {
      await start(f.run);
      const deadline = Date.now() + 20_000;
      while (true) {
        const run = await f.manifest();
        if (
          run.background.notification?.status === "delivered" &&
          !(await living([run.background.runner])).length
        )
          break;
        assert(Date.now() < deadline, "Legacy background run did not complete");
        await sleep(50);
      }
    } else await settled(f);
    const run = await f.manifest();
    assert.equal(run.runtime.node, await fs.realpath(process.execPath));
    assert.equal(run.versions.node, process.version);
    assert.equal(run.tasks[0].status, "succeeded");
    assert(await readJson(path.join(f.run, "tasks/one/1/claim.json")));
  }
});
