import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  launchSupervised,
  observeProcess,
  reconcileSupervisor,
  type SupervisorEvent,
} from "../../engine/backends/supervision/index.ts";
import { windowsHelperExecutable } from "../../engine/backends/supervision/windows-helper.ts";
import { WindowsJob, windowsPacketSchema } from "../../engine/backends/supervision/windows-job.ts";

const windows = process.platform === "win32";
const fixture = fileURLToPath(new URL("./fixtures/rewrite-supervision-child.ts", import.meta.url));
test("Windows native protocol distinguishes successful responses, failed responses and output events", () => {
  for (const packet of [
    { kind: "response", id: 1, ok: true, value: { empty: true } },
    { kind: "response", id: 2, ok: false, error: "CreateProcessW failed" },
    { kind: "output", stream: "stdout", data: "eA==" },
  ])
    assert.deepEqual(windowsPacketSchema.parse(packet), packet);
  assert.throws(() => windowsPacketSchema.parse({ kind: "response", id: 1, ok: false, value: {} }));
});
async function directory(t: TestContext): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "pinata Windows 雪 ")));
  t.after(() => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return path;
}
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!(await predicate())) {
    if (performance.now() >= deadline)
      throw new Error("Windows fixture did not reach its expected state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function text(events: SupervisorEvent[]): string {
  return events
    .flatMap((event) =>
      event.kind === "output" && event.stream === "stdout"
        ? [Buffer.from(event.data, "base64").toString("utf8")]
        : [],
    )
    .join("");
}
async function launch(
  t: TestContext,
  mode: string,
  options: { args?: string[]; command?: string; env?: Record<string, string> } = {},
) {
  const cwd = await directory(t);
  const events: SupervisorEvent[] = [];
  const handle = await launchSupervised({
    directory: cwd,
    command: options.command ?? process.execPath,
    args: options.args ?? [fixture, mode],
    env: options.env,
    cwd,
    ownerEpoch: "windows-test",
    lifetime: "attached",
    async onEnrolled(identity) {
      assert.equal(identity.scope.kind, "windows-job");
    },
    onEvent: (event) => events.push(event),
  });
  t.after(async () => {
    await handle.stop();
  });
  return { cwd, events, handle };
}

test(
  "Windows Job Objects preserve executable arguments, Unicode and empty values as data",
  { skip: !windows, timeout: 30_000 },
  async (t) => {
    const values = [
      "",
      "a b",
      'a"b',
      "trailing\\",
      'two\\\\"quotes',
      "%PATH%",
      "a&b|c",
      "雪😺",
      "line\nnext",
    ];
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const world = await launch(t, "arguments", {
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({args:process.argv.slice(1),unicode:process.env.PINATA_JOB_UNICODE,empty:process.env.PINATA_JOB_EMPTY,cwd:process.cwd()}))",
        "--",
        ...values,
      ],
      env: { ...env, PINATA_JOB_UNICODE: "雪😺", PINATA_JOB_EMPTY: "" },
    });
    await world.handle.exit;
    await world.handle.outputDrained;
    assert.deepEqual(JSON.parse(text(world.events)), {
      args: values,
      unicode: "雪😺",
      empty: "",
      cwd: world.cwd,
    });
    assert.equal((await world.handle.stop()).status, "stopped");
    const stop = JSON.parse(await readFile(join(world.cwd, "stop.json"), "utf8"));
    assert.equal(stop.record.windows.activeProcesses, 0);
    assert.equal(stop.record.windows.closed, true);
    assert.equal(world.handle.identity.scope.kind, "windows-job");
    if (world.handle.identity.scope.kind === "windows-job")
      assert.equal(stop.record.windows.launcherId, world.handle.identity.scope.launcherId);
  },
);

test(
  "Windows job closure drains descendant-held pipes after the payload exits",
  { skip: !windows, timeout: 30_000 },
  async (t) => {
    const world = await launch(t, "inherited-pipes");
    await world.handle.exit;
    await until(() => text(world.events).endsWith("\n"));
    const tree = JSON.parse(text(world.events));
    assert(await observeProcess(tree.leaf));
    assert.equal((await world.handle.inspect()).outputDrained, false);
    assert.equal((await world.handle.stop()).status, "stopped");
    await world.handle.outputDrained;
    assert.equal(await observeProcess(tree.leaf), undefined);
  },
);

test(
  "Windows launcher death kills its job without fabricating a cleanup acknowledgment",
  { skip: !windows, timeout: 30_000 },
  async (t) => {
    const world = await launch(t, "hold");
    await until(() => text(world.events).includes("payload"));
    const { payload } = JSON.parse(text(world.events));
    assert.equal(world.handle.identity.scope.kind, "windows-job");
    if (world.handle.identity.scope.kind !== "windows-job") return;
    process.kill(world.handle.identity.scope.launcher.pid, "SIGKILL");
    await until(async () => !(await observeProcess(payload)));
    assert.equal((await world.handle.stop()).status, "unconfirmed");
    assert.equal(
      (
        await reconcileSupervisor(world.handle.identity, {
          reason: "Inspect unexpected launcher death",
        })
      ).status,
      "unconfirmed",
    );
  },
);

test(
  "Windows nested jobs remain owned when a worker creates another supervisor",
  { skip: !windows, timeout: 40_000 },
  async (t) => {
    const supervisor = new URL("../../engine/backends/supervision/index.ts", import.meta.url).href;
    const script = `
    import { mkdir } from 'node:fs/promises';
    import { join } from 'node:path';
    import { launchSupervised } from ${JSON.stringify(supervisor)};
    const directory = join(process.cwd(), 'inner'); await mkdir(directory);
    await launchSupervised({ directory, command: process.execPath, args: [${JSON.stringify(fixture)}, 'hold'], cwd: directory, ownerEpoch: 'nested', lifetime: 'attached',
      async onEnrolled(identity) { process.stdout.write(JSON.stringify({ guardian: identity.process.pid, launcher: identity.scope.launcher.pid }) + '\\n'); },
      onEvent(event) { if (event.kind === 'output' && event.stream === 'stdout') process.stdout.write(Buffer.from(event.data, 'base64')); }
    });
    setInterval(() => {}, 1000);
  `;
    const world = await launch(t, "nested", { args: ["--input-type=module", "-e", script] });
    await until(() => text(world.events).includes('"payload"'));
    const lines = text(world.events)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const { guardian, launcher } = lines.find((line) => line.guardian);
    const { payload } = lines.find((line) => line.payload);
    for (const pid of [guardian, launcher, payload]) assert(await observeProcess(pid));
    assert.equal((await world.handle.stop()).status, "stopped");
    for (const pid of [guardian, launcher, payload])
      assert.equal(await observeProcess(pid), undefined);
  },
);

test(
  "Windows creation boundaries never leave an unowned payload when the launcher dies",
  { skip: !windows, timeout: 60_000 },
  async (t) => {
    const executable = await windowsHelperExecutable();
    const cwd = await directory(t);
    for (const boundary of [
      "job-created",
      "limits-set",
      "pipes-created",
      "attributes-created",
      "job-attribute",
      "handle-attribute",
      "before-create",
      "after-create",
    ]) {
      const child = spawn(
        executable,
        [`Local\\Pinata-fault-${randomUUID()}`, randomUUID(), boundary],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
      let output = "";
      const records: Array<Record<string, unknown>> = [];
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
        for (;;) {
          const end = output.indexOf("\n");
          if (end < 0) break;
          records.push(JSON.parse(output.slice(0, end)));
          output = output.slice(end + 1);
        }
      });
      child.stdin.on("error", () => {});
      child.stderr.resume();
      const closed = once(child, "close");
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      });
      if (!["job-created", "limits-set"].includes(boundary)) {
        await until(() => records.some((record) => record.kind === "ready"));
        child.stdin.write(
          JSON.stringify({
            id: 1,
            action: "start",
            payload: { command: process.execPath, args: [fixture, "hold"], cwd, env: process.env },
          }) + "\n",
        );
      }
      await closed;
      const fault = records.find((record) => record.kind === "fault");
      assert.equal(fault?.phase, boundary);
      if (boundary === "after-create") {
        assert(Number(fault?.pid) > 0);
        await until(async () => !(await observeProcess(Number(fault?.pid))));
      } else assert.equal(fault?.pid, 0);
    }
  },
);

test(
  "Windows job-name collisions leave the original owned payload running",
  { skip: !windows, timeout: 30_000 },
  async (t) => {
    const executable = await windowsHelperExecutable();
    const job = await WindowsJob.open(randomUUID());
    t.after(async () => {
      await job.stop();
    });
    await job.start({
      command: process.execPath,
      args: [fixture, "hold"],
      cwd: await directory(t),
    });
    const before = await job.inspect();
    assert.equal(before.activeProcesses, 1);
    const collision = spawn(executable, [job.name, randomUUID()], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let errors = "";
    collision.stdout.resume();
    collision.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      errors += chunk;
    });
    const [code] = await once(collision, "close");
    assert.equal(code, 1);
    assert.match(errors, /already exists/);
    assert.equal((await job.inspect()).activeProcesses, 1);
    assert.equal((await job.stop()).closed, true);
  },
);

test(
  "Windows cmd invocation is explicit and rejects shell expansion syntax",
  { skip: !windows, timeout: 30_000 },
  async (t) => {
    const cwd = await directory(t);
    const script = join(cwd, "hello world.cmd");
    await writeFile(script, "@echo off\r\necho %~1\r\n");
    const events: SupervisorEvent[] = [];
    const handle = await launchSupervised({
      directory: cwd,
      command: script,
      args: ["hello world"],
      cwd,
      ownerEpoch: "cmd-test",
      lifetime: "attached",
      async onEnrolled() {},
      onEvent: (event) => events.push(event),
    });
    await handle.exit;
    await handle.outputDrained;
    assert.equal(text(events).trim(), "hello world");
    assert.equal((await handle.stop()).status, "stopped");
    const rejected = await directory(t);
    await assert.rejects(
      launchSupervised({
        directory: rejected,
        command: script,
        args: ["%PATH%&echo injected"],
        cwd,
        ownerEpoch: "cmd-test",
        lifetime: "attached",
        async onEnrolled() {},
      }),
      /metacharacters/,
    );
  },
);
