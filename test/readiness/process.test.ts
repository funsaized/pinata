import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  identify,
  processStart,
  stopChild,
  stopIdentity,
} from "../../engine/backends/supervise.ts";

const file = fileURLToPath(new URL("./process-tree-child.ts", import.meta.url));
function start(mode: string, nonce = ""): ChildProcess {
  return spawn(process.execPath, [file, mode, nonce], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
}
async function waitStopped(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await processStart(pid)) === null) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}
async function stopOwned(pid: number, started: string | null) {
  if (!started || (await processStart(pid)) !== started) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

test(
  "baseline F2: leader exit leaves its TERM-resistant descendant alive",
  { skip: process.platform === "win32", timeout: 15_000 },
  async (t) => {
    const worker = start("worker");
    const exit = once(worker, "exit");
    const message = once(worker, "message");
    await once(worker, "spawn");
    assert(worker.pid);
    const owner = await identify(worker.pid);
    assert(owner);
    const [{ leaf }] = (await message) as [{ leaf: number }];
    const started = await processStart(leaf);
    t.after(() => stopOwned(leaf, started));
    worker.send("exit");
    await exit;
    await stopChild(worker, 30);
    assert(await processStart(leaf));
    await stopIdentity(owner, 30);
    assert(await processStart(leaf));
    t.diagnostic(
      JSON.stringify({
        probe: "F2",
        platform: process.platform,
        descendantSurvivesBothStops: true,
      }),
    );
  },
);

test(
  "POSIX candidate: resident guardian covers payload exit and rejects the wrong control nonce",
  { skip: process.platform === "win32", timeout: 15_000 },
  async (t) => {
    const nonce = randomUUID();
    const guardian = start("guardian", nonce);
    const exit = once(guardian, "exit");
    const [{ leaf }] = (await once(guardian, "message")) as [{ leaf: number }];
    assert(guardian.pid);
    const owner = await identify(guardian.pid);
    assert(owner);
    const leafStart = await processStart(leaf);
    t.after(async () => {
      await stopOwned(leaf, leafStart);
      await stopOwned(owner.pid, owner.started);
    });
    // A mismatched PID generation is not an authority to kill the current process.
    await stopIdentity({ ...owner, started: `${owner.started}-different-generation` }, 1);
    assert(await processStart(owner.pid));
    const denied = once(guardian, "message");
    guardian.send?.({ action: "stop", nonce: "wrong" });
    assert.deepEqual((await denied)[0], { denied: true });
    assert(await processStart(leaf));
    guardian.send?.({ action: "stop", nonce });
    const [, signal] = await exit;
    assert.equal(signal, "SIGKILL");
    assert(await waitStopped(leaf));
    assert(await waitStopped(owner.pid));
    t.diagnostic(
      JSON.stringify({
        probe: "guardian",
        platform: process.platform,
        payloadExitedFirst: true,
        descendantStopped: true,
        forgedGenerationIgnored: true,
        scope: "owned group, no setsid escape or guardian crash",
      }),
    );
  },
);

test("unknown process owner is refused without signalling the current process", async () => {
  const owner = await identify(process.pid);
  assert(owner);
  await assert.rejects(
    stopIdentity({ ...owner, host: "readiness-unrelated-host" }),
    /remote or uncertain/,
  );
  assert(await processStart(process.pid));
});
