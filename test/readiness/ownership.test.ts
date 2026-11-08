import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { appendFile, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { PinataHost } from "../../engine/pi/host.ts";
import { readRunRecord, writeRunRecord } from "../../engine/verify/integrate.ts";
import { fauxWorld } from "../engine/faux.ts";
import { spec, tempDir } from "../engine/helpers.ts";
import { claimLedger, readLedger } from "./journal-prototype.ts";

function launch(t: TestContext, filename: string, args: string[]) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL(filename, import.meta.url)), ...args],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  const phases: Array<Record<string, unknown>> = [];
  let errors = "";
  assert(child.stderr);
  child.stderr.setEncoding("utf8").on("data", (text: string) => {
    errors += text;
  });
  child.on("message", (message) => phases.push(message as Record<string, unknown>));
  const exited = once(child, "exit");
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  return { child, phases, exited, errors: () => errors };
}
async function phase(
  child: ChildProcess,
  phases: Array<Record<string, unknown>>,
  wanted: string[],
) {
  const timer = AbortSignal.timeout(15_000);
  for (;;) {
    const found = phases.find((message) => wanted.includes(String(message.phase)));
    if (found) return found;
    await once(child, "message", { signal: timer });
  }
}

test(
  "baseline A2: separate hosts both accept recovery after reading the same unowned run",
  { timeout: 30_000 },
  async (t) => {
    const world = await fauxWorld(t, () => fauxAssistantMessage([fauxText("done")]));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = world.agentDir;
    t.after(() => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    });
    const host = new PinataHost({
      getSettings: () => ({}),
      getThinkingLevel: () => "off",
      getAllTools: () => [],
      sendMessage: () => {},
    } as unknown as ExtensionAPI);
    t.after(() => host.shutdown("probe cleanup"));
    const { handle } = await host.start(
      { tasks: [spec("base")], config: { setup: false, codemode: false } },
      {
        cwd: world.repo,
        modelRegistry: world.registry,
        model: world.registry.find("faux", "faux-1"),
      } as ExtensionContext,
    );
    await handle.done;
    await host.shutdown("release seed host");
    const record = await readRunRecord(handle.dir);
    assert(record.resume);
    await writeRunRecord(handle.dir, { ...record, resume: { ...record.resume, owner: null } });
    const hosts = [
      launch(t, "./host-claim-child.ts", [handle.dir, world.repo]),
      launch(t, "./host-claim-child.ts", [handle.dir, world.repo]),
    ];
    await Promise.all(hosts.map((host) => phase(host.child, host.phases, ["read"])));
    for (const host of hosts) host.child.send("claim");
    const claims = await Promise.all(
      hosts.map((host) => phase(host.child, host.phases, ["claimed"])),
    );
    assert.notEqual(claims[0].pid, claims[1].pid);
    assert.equal(claims[0].run, claims[1].run);
    const owner = (await readRunRecord(handle.dir)).resume?.owner;
    assert(claims.some((claim) => claim.pid === owner?.pid));
    for (const host of hosts) host.child.send("close");
    for (const host of hosts) assert.equal((await host.exited)[0], 0, host.errors());
    t.diagnostic(
      JSON.stringify({
        probe: "A2",
        simultaneousHandles: claims.length,
        durableOwners: 1,
        source: "two processes paused after the actual resumeDir read",
        duplicateExecution: "not exercised",
      }),
    );
  },
);

test(
  "candidate exclusive creation permits one owner and does not steal a dead owner's record",
  { timeout: 20_000, skip: process.platform === "win32" },
  async (t) => {
    const directory = await tempDir(t, "pinata-readiness-owner-");
    const candidates = [
      launch(t, "./ledger-child.ts", ["claim", directory]),
      launch(t, "./ledger-child.ts", ["claim", directory]),
    ];
    await Promise.all(candidates.map((actor) => phase(actor.child, actor.phases, ["ready"])));
    for (const actor of candidates) actor.child.send("go");
    const results = await Promise.all(
      candidates.map((actor) => phase(actor.child, actor.phases, ["claimed", "rejected"])),
    );
    assert.equal(results.filter((result) => result.phase === "claimed").length, 1);
    const index = results.findIndex((result) => result.phase === "claimed");
    candidates[index].child.kill("SIGKILL");
    await candidates[index].exited;
    await assert.rejects(claimLedger(directory), { code: "EEXIST" });
    t.diagnostic(
      JSON.stringify({
        probe: "owner-candidate",
        accepted: 1,
        rejected: 1,
        staleOwnerRequiresReconciliation: true,
      }),
    );
  },
);

test(
  "candidate ledger commits follow-up and inbox together and replays lost receipts without duplication",
  { timeout: 20_000, skip: process.platform === "win32" },
  async (t) => {
    for (const boundary of ["written", "synced"]) {
      const directory = await tempDir(t, "pinata-readiness-commit-");
      const actor = launch(t, "./ledger-child.ts", ["follow", directory, boundary]);
      await phase(actor.child, actor.phases, ["ready"]);
      actor.child.send("go");
      assert.equal((await actor.exited)[1], "SIGKILL", actor.errors());
      assert(!actor.phases.some((message) => message.phase === "receipt"));
      const replay = await readLedger(directory);
      assert.equal(replay.frames.length, 1);
      assert.equal(replay.frames[0].batch.inbox.messageId, "message");
      assert.equal(replay.frames[0].batch.assignment, 1);
      // Test-only offline reconciliation: the fixture's sole owner has been reaped above.
      await rename(join(directory, "owner.json"), join(directory, "dead-owner-evidence.json"));
      const recovered = await claimLedger(directory);
      const receipt = await recovered.follow("request", {
        worker: "a",
        messageId: "message",
        text: "follow-up",
      });
      assert.deepEqual(receipt, replay.frames[0]);
      assert.equal((await readLedger(directory)).frames.length, 1);
      await assert.rejects(
        recovered.follow("request", { worker: "a", messageId: "message", text: "different" }),
        /content conflict/,
      );
      await recovered.close();
      t.diagnostic(
        JSON.stringify({
          probe: "ledger",
          boundary,
          receivedBeforeDeath: false,
          replayedRecords: 1,
          duplicatedAssignments: 0,
          machinePowerLossTested: false,
        }),
      );
    }
  },
);

test("candidate ledger preserves torn tails and refuses further writes instead of hiding evidence", async (t) => {
  const directory = await tempDir(t, "pinata-readiness-tail-");
  const owner = await claimLedger(directory);
  try {
    await owner.follow("one", { worker: "a", messageId: "one", text: "first" });
    await appendFile(join(directory, "ledger.jsonl"), '{"batch":');
    const before = await readFile(join(directory, "ledger.jsonl"));
    const replay = await readLedger(directory);
    assert.equal(replay.frames.length, 1);
    assert.equal(replay.incompleteTail, true);
    await assert.rejects(
      owner.follow("two", { worker: "a", messageId: "two", text: "second" }),
      /explicit reconciliation/,
    );
    assert.deepEqual(await readFile(join(directory, "ledger.jsonl")), before);
  } finally {
    await owner.close();
  }
});

test("candidate intake serializes concurrent follow-ups and identical retries", async (t) => {
  const directory = await tempDir(t, "pinata-readiness-fifo-");
  const owner = await claimLedger(directory);
  try {
    const requests = Array.from({ length: 12 }, (_, i) => ({
      id: `request-${i}`,
      worker: "worker",
      messageId: `message-${i}`,
      text: `message ${i}`,
    }));
    await Promise.all(
      requests.flatMap(({ id, ...input }) => [owner.follow(id, input), owner.follow(id, input)]),
    );
    const { frames } = await readLedger(directory);
    assert.equal(frames.length, 12);
    assert.deepEqual(
      frames.map((entry) => entry.batch.assignment),
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
  } finally {
    await owner.close();
  }
});
