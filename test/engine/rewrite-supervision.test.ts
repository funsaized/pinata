import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cleanupReceiptSchema } from "../../engine/contracts/backend.ts";
import {
  attachSupervisor,
  launchSupervised,
  observeProcess,
  reconcileSupervisor,
  stopSupervisor,
  SupervisorLaunchError,
  type LaunchOptions,
  type SupervisorEvent,
  type SupervisorIdentity,
} from "../../engine/backends/supervision/index.ts";
import { supervisorIdentitySchema } from "../../engine/backends/supervision/contracts.ts";
import { ControlClient } from "../../engine/backends/supervision/client.ts";

const fixtureFile = fileURLToPath(
  new URL("./fixtures/rewrite-supervision-child.ts", import.meta.url),
);
const posix = process.platform === "linux" || process.platform === "darwin";
const supported = posix || process.platform === "win32";
const executeFile = promisify(execFile);

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-rewrite-supervision-")));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return directory;
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await predicate())) {
    if (performance.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function stopped(pid: number): Promise<boolean> {
  const observed = await observeProcess(pid);
  return !observed || observed.state.startsWith("Z");
}

async function retainFixtureCleanup(t: TestContext, pid: number): Promise<void> {
  const original = await observeProcess(pid);
  if (!original) return;
  t.after(async () => {
    const current = await observeProcess(pid);
    if (
      !current ||
      current.startIdentity !== original.startIdentity ||
      current.state.startsWith("Z")
    )
      return;
    // This is explicit cleanup of the test's deliberately escaped fixture, never
    // the production supervisor's recovery algorithm or a historical group kill.
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  });
}

async function launch(t: TestContext, mode: string, options: Partial<LaunchOptions> = {}) {
  const directory = await temporaryDirectory(t);
  const events: SupervisorEvent[] = [];
  let enrolled = false;
  const handle = await launchSupervised({
    directory,
    command: process.execPath,
    args: [fixtureFile, mode],
    cwd: directory,
    ownerEpoch: "test-owner",
    lifetime: "attached",
    async onEnrolled() {
      enrolled = true;
    },
    onEvent(event) {
      assert(enrolled, "payload output preceded durable host enrollment");
      events.push(event);
    },
    ...options,
  });
  t.after(async () => {
    await handle.stop({ reason: "Fixture cleanup", graceMs: 10, confirmationMs: 1000 });
  });
  return { directory, handle, events };
}

function output(events: SupervisorEvent[], stream: "stdout" | "stderr" = "stdout"): string {
  return events
    .flatMap((event) =>
      event.kind === "output" && event.stream === stream
        ? [Buffer.from(event.data, "base64").toString("utf8")]
        : [],
    )
    .join("");
}

for (const disconnectedStops of [1, 2])
  test(
    `supervisor cleanup retries once after ${disconnectedStops} dropped control connections`,
    {
      skip: !supported,
      timeout: 15_000,
    },
    async (t) => {
      const { handle } = await launch(t, "hold");
      const request = ControlClient.prototype.request;
      let stops = 0;
      let pings = 0;
      const mocked = t.mock.method(
        ControlClient.prototype,
        "request",
        function (this: ControlClient, command: Parameters<ControlClient["request"]>[0]) {
          if (command.action === "ping") pings++;
          if (command.action === "stop" && ++stops <= disconnectedStops) this.close();
          return request.call(this, command);
        },
      );
      try {
        const receipt = await handle.stop({ reason: "Dropped connection regression", graceMs: 10 });
        assert.equal(
          receipt.status,
          disconnectedStops === 1 ? "stopped" : "unconfirmed",
          JSON.stringify(receipt),
        );
        assert.equal(stops, 2);
        assert.equal(pings, 1, "the replacement connection must authenticate the guardian");
        assert.equal(await stopped(handle.identity.process.pid), disconnectedStops === 1);
      } finally {
        mocked.mock.restore();
        await stopSupervisor(handle.identity, { reason: "Regression cleanup", graceMs: 10 });
      }
    },
  );

test(
  "rewrite supervisor: Linux PID stat disappearance is absent while other observation errors propagate",
  { skip: process.platform !== "linux", timeout: 15_000 },
  async () => {
    const module = new URL("../../engine/backends/supervision/processes.ts", import.meta.url);
    const script = `
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { observeProcess } from ${JSON.stringify(module.href)};
const original = fs.promises.readFile;
const cases = [
  { stat: "ENOENT" },
  { stat: "ESRCH" },
  { stat: "EACCES", fails: "stat" },
  { stat: "EIO", fails: "stat" },
  { boot: "ENOENT", fails: "boot" },
  { boot: "ESRCH", fails: "boot" },
  { boot: "EACCES", fails: "boot" },
  { boot: "EIO", fails: "boot" },
  { stat: "ENOENT", boot: "EIO", fails: "boot" },
  { stat: "ESRCH", boot: "ENOENT", fails: "boot" },
];
try {
  for (const scenario of cases) {
    const errors = Object.fromEntries(
      ["stat", "boot"].map((kind) => [kind, Object.assign(new Error(kind), { code: scenario[kind] })]),
    );
    const reads = { stat: 0, boot: 0 };
    fs.promises.readFile = async (...args) => {
      const kind = args[0] === "/proc/" + process.pid + "/stat" ? "stat"
        : args[0] === "/proc/sys/kernel/random/boot_id" ? "boot" : undefined;
      if (kind) {
        reads[kind]++;
        if (scenario[kind]) throw errors[kind];
      }
      return original(...args);
    };
    syncBuiltinESMExports();
    // The real ps lookup must find this live child before either injected read.
    if (scenario.fails) {
      await assert.rejects(observeProcess(process.pid), (error) => error === errors[scenario.fails]);
    } else {
      assert.equal(await observeProcess(process.pid), undefined);
    }
    assert.deepEqual(reads, { stat: 1, boot: 1 });
  }
} finally {
  fs.promises.readFile = original;
  syncBuiltinESMExports();
}
`;
    await executeFile(process.execPath, ["--input-type=module", "--eval", script], {
      timeout: 10_000,
    });
  },
);

test(
  "rewrite supervisor: explicit input EOF completes a supervised command",
  { skip: !supported, timeout: 15_000 },
  async (t) => {
    const { handle, events } = await launch(t, "stdin-eof");
    await handle.writeInput("one\0two\n");
    await handle.closeInput();
    assert.deepEqual(await handle.exit, { code: 0, signal: null });
    await handle.outputDrained;
    assert.equal(output(events), "one\0two\n");
    assert.equal((await handle.stop({ graceMs: 10 })).status, "stopped");
  },
);

test(
  "rewrite supervisor: stopping interrupts a blocked payload input write",
  { skip: !supported, timeout: 30_000 },
  async (t) => {
    const { handle, events } = await launch(t, "hold");
    await until(() => output(events).includes("payload"), "payload is running");
    let settled = false;
    const write = handle.writeInput("x".repeat(1024 * 1024)).then(
      () => {
        settled = true;
        return "accepted";
      },
      () => {
        settled = true;
        return "interrupted";
      },
    );
    await delay(100);
    assert.equal(settled, false, "the unread pipe must fill before stopping");
    const cleanup = await handle.stop({ graceMs: 10 });
    assert.equal(cleanup.status, "stopped", JSON.stringify(cleanup));
    assert.equal(await write, "interrupted");
  },
);

test(
  "rewrite supervisor: enrollment precedes effects and byte-indexed output survives leader completion",
  { skip: !supported, timeout: 15_000 },
  async (t) => {
    const { handle, events } = await launch(t, "stdio");
    await until(() => output(events, "stderr").includes("stderr-ready"), "stderr stream");
    await handle.writeInput("hello\n");
    await until(() => output(events).includes("hello"), "stdin reaches payload");
    await handle.writeInput("finish\n");
    assert.deepEqual(await handle.exit, { code: 0, signal: null });
    await handle.outputDrained;
    const bytes = await handle.readOutput({ stream: "stdout", offset: 0 });
    assert.equal(bytes.bytes.toString("utf8"), "hello\nfinish\n");
    const streams = new Map<string, number>();
    let ordinal = 0;
    for (const event of events) {
      assert(event.ordinal > ordinal);
      ordinal = event.ordinal;
      if (event.kind !== "output") continue;
      assert.equal(event.offset, streams.get(event.stream) ?? 0);
      assert.equal(Buffer.from(event.data, "base64").length, event.length);
      streams.set(event.stream, event.offset + event.length);
    }
    const receipt = await handle.stop({ graceMs: 20 });
    assert.equal(receipt.status, "stopped");
    cleanupReceiptSchema.parse(receipt);
    assert(receipt.evidence.length);
    for (const reference of receipt.evidence) assert((await handle.readEvidence(reference)).length);
    assert.deepEqual(await handle.stop(), receipt);
    assert.deepEqual(await stopSupervisor(handle.identity), receipt);
    assert(await stopped(handle.identity.process.pid));
  },
);

test(
  "rewrite supervisor: a supervisor stops resistant descendants after payload-first exit",
  { skip: !supported, timeout: 15_000 },
  async (t) => {
    const { handle, events } = await launch(t, "payload-first");
    await until(() => output(events).includes("leaf"), "descendant readiness");
    const tree = JSON.parse(output(events)) as { payload: number; leaf: number };
    await retainFixtureCleanup(t, tree.leaf);
    assert.deepEqual(await handle.exit, { code: 0, signal: null });
    assert(await observeProcess(tree.leaf));
    const receipt = await handle.stop({ graceMs: 20 });
    assert.equal(receipt.status, "stopped", JSON.stringify(receipt));
    assert(await stopped(tree.leaf));
    assert(await stopped(handle.identity.process.pid));
  },
);

test(
  "rewrite supervisor: wrong nonce, host and process generation cannot signal a live scope",
  { skip: !supported, timeout: 15_000 },
  async (t) => {
    const { handle, events } = await launch(t, "hold");
    await until(() => output(events).includes("payload"), "payload readiness");
    const { payload } = JSON.parse(output(events)) as { payload: number };
    for (const identity of [
      { ...handle.identity, nonce: "00000000-0000-4000-8000-000000000000" },
      { ...handle.identity, host: "different-host" },
      {
        ...handle.identity,
        process: { ...handle.identity.process, startIdentity: "another-generation" },
      },
    ]) {
      const receipt = await stopSupervisor(identity, { graceMs: 1 });
      assert.equal(receipt.status, "unconfirmed");
      assert(!(await stopped(payload)));
      assert(!(await stopped(handle.identity.process.pid)));
    }
    const wrongNonce = await ControlClient.open(
      { ...handle.identity, nonce: "00000000-0000-4000-8000-000000000000" },
      () => {},
    );
    await assert.rejects(
      wrongNonce.request({ action: "stop", reason: "unauthenticated test request", graceMs: 0 }),
      /nonce/,
    );
    wrongNonce.close();
    assert(!(await stopped(payload)));
    assert.equal((await handle.stop({ graceMs: 20 })).status, "stopped");
  },
);

test(
  "rewrite supervisor: guardian death yields unconfirmed cleanup and never signals its historical group",
  { skip: !posix, timeout: 15_000 },
  async (t) => {
    const { handle, events } = await launch(t, "hold");
    await until(() => output(events).includes("payload"), "payload readiness");
    const { payload } = JSON.parse(output(events)) as { payload: number };
    await retainFixtureCleanup(t, payload);
    process.kill(handle.identity.process.pid, "SIGKILL");
    await until(() => stopped(handle.identity.process.pid), "guardian death");
    const receipt = await handle.stop({ graceMs: 20, confirmationMs: 200 });
    assert.equal(receipt.status, "unconfirmed");
    assert.equal(
      (await reconcileSupervisor(handle.identity, { reason: "Inspect unexpected guardian death" }))
        .status,
      "unconfirmed",
    );
    assert(
      !(await stopped(payload)),
      "production stop must not kill after the live guardian identity is lost",
    );
  },
);

test(
  "rewrite supervisor: escaped enrolled activity remains unconfirmed and unsignalled",
  { skip: !posix, timeout: 15_000 },
  async (t) => {
    const { handle, events } = await launch(t, "escaped");
    await until(() => output(events).includes("leaf"), "escaped fixture readiness");
    const { leaf } = JSON.parse(output(events)) as { leaf: number };
    await retainFixtureCleanup(t, leaf);
    const status = await handle.enroll(leaf);
    assert(status.escaped.some((identity) => identity.pid === leaf));
    const receipt = await handle.stop({ graceMs: 20, confirmationMs: 150 });
    assert.equal(receipt.status, "unconfirmed");
    assert(!(await stopped(leaf)));
    assert(await stopped(handle.identity.process.pid));
  },
);

test(
  "rewrite supervisor: rejected enrollment, aborted authorization and failed spawn clean their owned setup",
  { skip: !supported, timeout: 15_000 },
  async (t) => {
    for (const failure of ["enrollment", "abort", "spawn"]) {
      const directory = await temporaryDirectory(t);
      const controller = new AbortController();
      let identity: SupervisorIdentity | undefined;
      let output = false;
      await assert.rejects(
        launchSupervised({
          directory,
          command: failure === "spawn" ? join(directory, "missing-program") : process.execPath,
          args: [fixtureFile, "hold"],
          cwd: directory,
          ownerEpoch: "setup-owner",
          lifetime: "attached",
          signal: controller.signal,
          async onEnrolled(value) {
            identity = value;
            if (failure === "enrollment") throw new Error("Host enrollment failed");
            if (failure === "abort") controller.abort();
          },
          onEvent(event) {
            if (event.kind === "output") output = true;
          },
        }),
        (error: unknown) => {
          assert(error instanceof SupervisorLaunchError);
          assert.equal(error.cleanup.status, "stopped", JSON.stringify(error.cleanup));
          return true;
        },
      );
      assert(identity);
      assert(!output);
      assert(await stopped(identity.process.pid));
    }
  },
);

test(
  "rewrite supervisor: pre-aborted launch starts no guardian or payload",
  { skip: !supported },
  async (t) => {
    const directory = await temporaryDirectory(t);
    const controller = new AbortController();
    controller.abort();
    let enrolled = false;
    await assert.rejects(
      launchSupervised({
        directory,
        command: process.execPath,
        args: [fixtureFile, "hold"],
        cwd: directory,
        ownerEpoch: "test",
        lifetime: "attached",
        signal: controller.signal,
        async onEnrolled() {
          enrolled = true;
        },
      }),
      (error: unknown) => {
        assert(error instanceof SupervisorLaunchError);
        assert.equal(error.cleanup.status, "stopped");
        assert.deepEqual(error.cleanup.identities, []);
        return true;
      },
    );
    assert(!enrolled);
  },
);

test(
  "rewrite supervisor: surviving lifetime reconnects to the same guardian and retained output",
  { skip: !supported, timeout: 15_000 },
  async (t) => {
    const { handle, events } = await launch(t, "hold", { lifetime: "surviving" });
    await until(() => output(events).includes("payload"), "surviving readiness");
    const identity = handle.identity;
    handle.detach();
    const attached = await attachSupervisor(identity);
    assert.equal((await attached.inspect()).phase, "running");
    assert.match(
      (await attached.readOutput({ stream: "stdout", offset: 0 })).bytes.toString("utf8"),
      /payload/,
    );
    const receipt = await attached.stop({ graceMs: 20 });
    assert.equal(receipt.status, "stopped");
  },
);

test(
  "rewrite supervisor: attached host loss stops its scope while surviving host loss preserves reconnectable activity",
  { skip: !supported, timeout: 25_000 },
  async (t) => {
    for (const lifetime of ["attached", "surviving"] as const) {
      const directory = await temporaryDirectory(t);
      const host = spawn(process.execPath, [fixtureFile, "host", directory, lifetime], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      const messages: unknown[] = [];
      host.on("message", (message) => messages.push(message));
      let stderr = "";
      host.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      const exited = once(host, "exit");
      t.after(() => {
        if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
      });
      await until(
        () =>
          messages.some(
            (value) =>
              value && typeof value === "object" && "phase" in value && value.phase === "started",
          ),
        `host startup: ${stderr}`,
      );
      const persisted = supervisorIdentitySchema.parse(
        JSON.parse(await readFile(join(directory, "identity.json"), "utf8")),
      );
      t.after(async () => {
        await stopSupervisor(persisted, { graceMs: 10, confirmationMs: 1000 });
      });
      host.send("exit");
      await exited;
      if (lifetime === "attached") {
        await until(
          () => stopped(persisted.process.pid),
          "attached guardian stops after host loss",
        );
        const stop = JSON.parse(await readFile(join(directory, "stop.json"), "utf8"));
        for (const process of stop.record.enrolled as Array<{ pid: number }>)
          assert(await stopped(process.pid));
        assert.equal(
          (await stopSupervisor(persisted)).status,
          "unconfirmed",
          "a new host cannot invent the departed host's final cleanup receipt",
        );
        await writeFile(
          join(directory, "stop.json"),
          JSON.stringify({ ...stop, record: { ...stop.record, id: randomUUID() } }),
        );
        assert.equal(
          (await reconcileSupervisor(persisted, { reason: "Inspect interrupted host cleanup" }))
            .status,
          "unconfirmed",
        );
        await writeFile(join(directory, "stop.json"), JSON.stringify(stop));
        const reconciled = await reconcileSupervisor(persisted, {
          reason: "Confirm stopped activity after host loss",
        });
        assert.equal(reconciled.status, "stopped", JSON.stringify(reconciled));
        assert.deepEqual(
          await reconcileSupervisor(persisted, { reason: "Repeated explicit inspection" }),
          reconciled,
        );
      } else {
        assert(!(await stopped(persisted.process.pid)));
        const attached = await attachSupervisor(persisted);
        assert.equal((await attached.stop({ graceMs: 20 })).status, "stopped");
      }
    }
  },
);

test(
  "rewrite supervisor: large output remains bounded in events and complete in its durable file",
  { skip: !supported, timeout: 15_000 },
  async (t) => {
    const { handle, events } = await launch(t, "flood");
    await handle.exit;
    assert.deepEqual(await handle.outputDrained, { stdout: 256 * 1024, stderr: 0 });
    const receipt = await handle.stop({ graceMs: 20 });
    assert.equal(receipt.status, "stopped");
    const read = await handle.readOutput({ stream: "stdout", offset: 0, maxBytes: 512 * 1024 });
    assert.equal(read.bytes.length, 256 * 1024);
    assert.equal(read.bytes.toString("utf8"), "x".repeat(256 * 1024));
    for (const event of events) if (event.kind === "output") assert(event.length <= 64 * 1024);
  },
);

test(
  "rewrite supervisor: payload exit does not claim drained output while descendants retain pipes",
  { skip: !posix, timeout: 15_000 },
  async (t) => {
    const { handle } = await launch(t, "inherited-pipes");
    await handle.exit;
    assert.equal((await handle.inspect()).outputDrained, false);
    const drained = handle.outputDrained.then(
      () => "drained",
      () => "unconfirmed",
    );
    assert.equal(
      await Promise.race([
        drained,
        new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
      ]),
      "pending",
    );
    assert.equal((await handle.stop({ graceMs: 20 })).status, "stopped");
    assert.equal(await drained, "unconfirmed");
  },
);

test(
  "rewrite supervisor: changing a saved cleanup status cannot fabricate stopped evidence",
  { skip: !posix, timeout: 15_000 },
  async (t) => {
    const { handle, events, directory } = await launch(t, "hold");
    await until(() => output(events).includes("payload"), "payload readiness");
    const { payload } = JSON.parse(output(events)) as { payload: number };
    await retainFixtureCleanup(t, payload);
    process.kill(handle.identity.process.pid, "SIGKILL");
    await until(() => stopped(handle.identity.process.pid), "guardian death");
    assert.equal((await handle.stop({ confirmationMs: 100 })).status, "unconfirmed");
    const path = join(directory, "cleanup.json");
    const saved = JSON.parse(await readFile(path, "utf8"));
    saved.receipt.status = "stopped";
    delete saved.receipt.reasons;
    const corrupt = JSON.stringify(saved);
    await writeFile(path, corrupt);
    assert.equal((await stopSupervisor(handle.identity)).status, "unconfirmed");
    assert.equal(await readFile(path, "utf8"), corrupt);
    assert(!(await stopped(payload)));
  },
);

test(
  "rewrite supervisor: active cancellation is idempotent and prevents another payload start",
  { skip: !supported, timeout: 15_000 },
  async (t) => {
    const controller = new AbortController();
    const { handle } = await launch(t, "hold", { signal: controller.signal });
    controller.abort();
    await assert.rejects(
      handle.start({
        command: process.execPath,
        args: [fixtureFile, "hold"],
        cwd: handle.identity.directory,
      }),
      /cancelled|stopping/,
    );
    const [first, second] = await Promise.all([handle.stop(), handle.stop()]);
    assert.equal(first.status, "stopped");
    assert.deepEqual(second, first);
    assert(await stopped(handle.identity.process.pid));
  },
);

test(
  "rewrite supervisor: a missing Node launcher confirms that no payload was authorized",
  { skip: !supported, timeout: 15_000 },
  async (t) => {
    const directory = await temporaryDirectory(t);
    let enrolled = false;
    await assert.rejects(
      launchSupervised({
        directory,
        command: process.execPath,
        args: [fixtureFile, "hold"],
        cwd: directory,
        nodeCommand: join(directory, "missing-node"),
        ownerEpoch: "test-owner",
        lifetime: "attached",
        async onEnrolled() {
          enrolled = true;
        },
      }),
      (error: unknown) => {
        assert(error instanceof SupervisorLaunchError);
        assert.equal(error.cleanup.status, "stopped");
        return true;
      },
    );
    assert(!enrolled);
  },
);

test(
  "rewrite supervisor: attached host loss before enrollment still cleans the bootstrap guardian",
  { skip: !posix, timeout: 15_000 },
  async (t) => {
    const directory = await temporaryDirectory(t);
    await writeFile(
      join(directory, "bootstrap.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: randomUUID(),
        nonce: randomUUID(),
        ownerEpoch: "early-host-loss",
        directory,
        lifetime: "attached",
      }),
      { mode: 0o600 },
    );
    const guardianFile = fileURLToPath(
      new URL("../../engine/backends/supervision/guardian.ts", import.meta.url),
    );
    const guardian = spawn(process.execPath, [guardianFile, directory], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let errors = "";
    guardian.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      errors += chunk;
    });
    const exit = once(guardian, "exit");
    t.after(() => {
      if (guardian.exitCode === null && guardian.signalCode === null) guardian.kill("SIGKILL");
    });
    guardian.disconnect();
    const [code, signal] = await exit;
    assert.equal(code, null, errors);
    assert.equal(signal, "SIGKILL", errors);
    const stop = JSON.parse(await readFile(join(directory, "stop.json"), "utf8"));
    assert.equal(stop.record.phase, "armed");
    assert.match(stop.record.reason, /Attached host/);
  },
);
