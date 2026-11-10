import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { open, readFile, realpath, type FileHandle } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  bootstrapSchema,
  controlRequestSchema,
  enrollmentSchema,
  processKey,
  supervisorIdentitySchema,
  supervisorLogEventSchema,
  type Payload,
  type StopEvidence,
  type SupervisorEvent,
  type SupervisorIdentity,
  type SupervisorStatus,
} from "./contracts.ts";
import { retainEvidence, writeProjection } from "./evidence.ts";
import { observeProcess, observeProcesses, observeScope } from "./processes.ts";
import { WindowsJob } from "./windows-job.ts";

const MAX_PACKET_BYTES = 2 * 1024 * 1024;
const MAX_CLIENT_BACKLOG = 1024 * 1024;
const directoryArgument = process.argv[2];
if (!directoryArgument) throw new Error("Supervisor requires its private directory");
if (!["linux", "darwin", "win32"].includes(process.platform))
  throw new Error("Guardian is unavailable on this platform");
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (process.versions.bun || nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 19))
  throw new Error("Guardian requires Node 22.19 or newer");

const directory = await realpath(directoryArgument);
const bootstrap = bootstrapSchema.parse(
  JSON.parse(await readFile(join(directory, "bootstrap.json"), "utf8")),
);
if (bootstrap.directory !== directory)
  throw new Error("Supervisor directory identity differs from its bootstrap");
let identity: SupervisorIdentity | undefined;
type PayloadProcess = {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  once(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
};
let payload: PayloadProcess | undefined;
const windowsJob = process.platform === "win32" ? await WindowsJob.open(bootstrap.id) : undefined;
let windowsProof: StopEvidence["windows"];
let status: SupervisorStatus = {
  supervisor: bootstrap.id,
  phase: "ready",
  ordinal: 0,
  stdout: 0,
  stderr: 0,
  outputDrained: false,
  enrolled: [],
  escaped: [],
};
let outputQueue: Promise<void> = Promise.resolve();
let outputDrain: Promise<void> = Promise.resolve();
let stopping: Promise<{ stopId: string; evidence: { digest: string; size: number } }> | undefined;
let terminationStarted = false;
let hostLost = !process.connected;
const observationErrors: string[] = [];
const observers = new Set<Socket>();
const outputFiles = new Map<"stdout" | "stderr", FileHandle>();
const eventFile = await open(join(directory, "events.jsonl"), "a", 0o600);
for (const stream of ["stdout", "stderr"] as const)
  outputFiles.set(stream, await open(join(directory, `${stream}.bin`), "a", 0o600));
windowsJob?.on("failure", (error: Error) => {
  observationErrors.push(error.message);
  status.phase = "failed";
  void recordFailure(error).finally(() => process.exit(1));
});

function broadcast(event: SupervisorEvent): void {
  const packet = JSON.stringify({ kind: "event", event }) + "\n";
  for (const socket of observers) {
    if (
      socket.destroyed ||
      socket.writableLength + Buffer.byteLength(packet) > MAX_CLIENT_BACKLOG
    ) {
      observers.delete(socket);
      socket.destroy();
      continue;
    }
    socket.write(packet);
  }
}

async function publish(event: SupervisorEvent): Promise<void> {
  const record = supervisorLogEventSchema.parse(
    event.kind === "output"
      ? {
          kind: event.kind,
          source: event.source,
          ordinal: event.ordinal,
          stream: event.stream,
          offset: event.offset,
          length: event.length,
        }
      : event,
  );
  await eventFile.writeFile(JSON.stringify(record) + "\n");
  broadcast(event);
}

function enqueueOutput(operation: () => Promise<void>): Promise<void> {
  const result = outputQueue.then(operation);
  outputQueue = result.catch((error: unknown) => {
    observationErrors.push(error instanceof Error ? error.message : String(error));
  });
  return result;
}

async function consumeOutput(stream: "stdout" | "stderr", source: Readable): Promise<void> {
  const file = outputFiles.get(stream);
  if (!file) throw new Error("Output file is unavailable");
  for await (const chunk of source) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      const part = bytes.subarray(offset, offset + 64 * 1024);
      await enqueueOutput(async () => {
        const outputOffset = status[stream];
        await file.writeFile(part);
        status[stream] += part.length;
        status.ordinal++;
        await publish({
          kind: "output",
          source: bootstrap.id,
          ordinal: status.ordinal,
          stream,
          offset: outputOffset,
          length: part.length,
          data: part.toString("base64"),
        });
      });
    }
  }
}

async function refreshEnrollment(): Promise<void> {
  if (windowsJob) {
    if (!windowsProof) {
      const snapshot = await windowsJob.inspect();
      const enrolled = new Map(status.enrolled.map((entry) => [processKey(entry), entry]));
      for (const entry of [windowsJob.process, ...snapshot.processes])
        enrolled.set(processKey(entry), entry);
      status.enrolled = [...enrolled.values()];
    }
  } else {
    const observed = observeScope(await observeProcesses(), process.pid, status.enrolled);
    status = { ...status, ...observed };
  }
  await writeProjection(directory, "enrollment.json", {
    ...enrollmentSchema.parse({
      schemaVersion: 1,
      supervisor: bootstrap.id,
      enrolled: status.enrolled,
      escaped: status.escaped,
    }),
  });
}

async function startPayload(spec: Payload): Promise<SupervisorStatus> {
  if (status.phase !== "ready" || stopping)
    throw new Error("Payload already started or supervision is stopping");
  status.phase = "running";
  // The caller has acknowledged the guardian's durable group enrollment before
  // sending this command. No project process exists during bootstrap/enrollment.
  await retainEvidence(directory, {
    schemaVersion: 1,
    supervisor: bootstrap.id,
    kind: "payload-authorized",
    command: spec.command,
    argumentCount: spec.args.length,
    cwd: spec.cwd,
  });
  const child =
    windowsJob ??
    spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });
  payload = child;
  const spawned = windowsJob
    ? windowsJob.start(spec)
    : new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
  const readers = (
    [
      ["stdout", child.stdout],
      ["stderr", child.stderr],
    ] as const
  ).map(([stream, source]) => consumeOutput(stream, source));
  outputDrain = Promise.all(readers)
    .then(async () => {
      await enqueueOutput(async () => {
        for (const file of outputFiles.values()) await file.sync();
        status.outputDrained = true;
        status.ordinal++;
        await publish({
          kind: "output_drained",
          source: bootstrap.id,
          ordinal: status.ordinal,
          stdout: status.stdout,
          stderr: status.stderr,
        });
        await eventFile.sync();
        await writeProjection(directory, "status.json", status);
      });
    })
    .catch((error: unknown) => recordFailure(error));
  child.once("exit", (code: number | null, signal: string | null) => {
    void enqueueOutput(async () => {
      status.exit = { code, signal };
      if (!stopping) status.phase = "exited";
      status.ordinal++;
      for (const file of outputFiles.values()) await file.sync();
      await publish({
        kind: "exit",
        source: bootstrap.id,
        ordinal: status.ordinal,
        code,
        signal,
        stdout: status.stdout,
        stderr: status.stderr,
      });
      await eventFile.sync();
      await writeProjection(directory, "status.json", status);
    }).catch((error: unknown) => recordFailure(error));
  });
  try {
    await spawned;
    await refreshEnrollment();
    await writeProjection(directory, "status.json", status);
    return status;
  } catch (error) {
    status.phase = "failed";
    await recordFailure(error);
    throw new Error(
      `Payload launch failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function recordFailure(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  status.ordinal++;
  try {
    await publish({ kind: "failure", source: bootstrap.id, ordinal: status.ordinal, message });
    await eventFile.sync();
    await writeProjection(directory, "status.json", status);
  } catch (cause) {
    process.stderr.write(
      `Guardian evidence failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
  }
}

async function stopRecord(
  phase: StopEvidence["phase"],
  stopId: string,
  reason: string,
): Promise<{ stopId: string; evidence: { digest: string; size: number } }> {
  try {
    await refreshEnrollment();
  } catch (error) {
    observationErrors.push(error instanceof Error ? error.message : String(error));
  }
  await outputQueue;
  for (const file of outputFiles.values()) await file.sync();
  await eventFile.sync();
  const record: StopEvidence = {
    schemaVersion: 1,
    id: stopId,
    supervisor: bootstrap.id,
    ownerEpoch: bootstrap.ownerEpoch,
    phase,
    reason,
    observedAt: new Date().toISOString(),
    enrolled: status.enrolled,
    escaped: status.escaped,
    observationErrors: [...observationErrors],
    ...(windowsProof ? { windows: windowsProof } : {}),
  };
  const evidence = await retainEvidence(directory, record);
  await writeProjection(directory, "stop.json", { record, artifact: evidence });
  return { stopId, evidence };
}

function beginStop(
  reason: string,
): Promise<{ stopId: string; evidence: { digest: string; size: number } }> {
  if (!stopping) {
    status.phase = "stopping";
    stopping = stopRecord("requested", randomUUID(), reason);
  }
  return stopping;
}

async function terminateGroup(reason: string, graceMs: number): Promise<void> {
  if (terminationStarted) return;
  terminationStarted = true;
  const request = await beginStop(reason);
  if (windowsJob) {
    windowsProof = await windowsJob.stop();
    await outputDrain;
    await stopRecord("armed", request.stopId, reason);
    process.exit(0);
  }
  // Only this live group leader sends group signals. No stored PID or PGID is
  // ever used by a later host as authority to signal a potentially reused group.
  process.kill(-process.pid, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  // Payload exit and pipe completion are separate: descendants may retain a
  // pipe indefinitely. Flush closed streams when possible before forced cleanup.
  await Promise.race([outputDrain, new Promise((resolve) => setTimeout(resolve, 50))]);
  await stopRecord("armed", request.stopId, reason);
  process.kill(-process.pid, "SIGKILL");
}

function sameNonce(candidate: string): boolean {
  const expected = Buffer.from(bootstrap.nonce);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function handleRequest(socket: Socket, input: unknown): Promise<void> {
  const request = controlRequestSchema.parse(input);
  const reply = (packet: unknown, after?: () => void) => {
    if (socket.destroyed) {
      after?.();
      return;
    }
    socket.write(JSON.stringify(packet) + "\n", after);
  };
  if (request.supervisor !== bootstrap.id || !sameNonce(request.nonce)) {
    reply({
      kind: "response",
      id: request.id,
      ok: false,
      error: "Supervisor identity or nonce does not match",
    });
    return;
  }
  try {
    let value: unknown;
    switch (request.command.action) {
      case "ping":
        if (!identity) throw new Error("Guardian enrollment is not ready");
        value = {
          id: identity.id,
          ownerEpoch: identity.ownerEpoch,
          process: identity.process,
          scope: identity.scope,
          host: identity.host,
        };
        break;
      case "observe":
        observers.add(socket);
        value = status;
        break;
      case "inspect":
        await refreshEnrollment();
        value = status;
        break;
      case "start":
        value = await startPayload(request.command.payload);
        break;
      case "input":
        if (!payload || payload.stdin.destroyed || status.phase !== "running")
          throw new Error("Payload input is unavailable");
        await new Promise<void>((resolve, reject) =>
          payload?.stdin.write(
            request.command.action === "input" ? request.command.text : "",
            (error) => (error ? reject(error) : resolve()),
          ),
        );
        value = { accepted: true };
        break;
      case "input_end":
        if (!payload) throw new Error("Payload has not started");
        payload.stdin.end();
        value = { accepted: true };
        break;
      case "enroll": {
        if (windowsJob) {
          await windowsJob.enroll(request.command.pid);
          await refreshEnrollment();
          value = status;
          break;
        }
        const enrolled = await observeProcess(request.command.pid);
        if (!enrolled) throw new Error("Requested process is not live for enrollment");
        const existing = new Map(status.enrolled.map((process) => [processKey(process), process]));
        existing.set(processKey(enrolled), enrolled);
        status.enrolled = [...existing.values()];
        await refreshEnrollment();
        value = status;
        break;
      }
      case "stop": {
        const { reason, graceMs } = request.command;
        value = await beginStop(reason);
        reply({ kind: "response", id: request.id, ok: true, value }, () => {
          void terminateGroup(reason, graceMs).catch((error: unknown) => recordFailure(error));
        });
        return;
      }
    }
    reply({ kind: "response", id: request.id, ok: true, value });
  } catch (error) {
    reply({
      kind: "response",
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const server = createServer((socket) => {
  socket.setNoDelay(true);
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    if (Buffer.byteLength(buffered) > MAX_PACKET_BYTES) {
      socket.destroy();
      return;
    }
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline === -1) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      try {
        void handleRequest(socket, JSON.parse(line)).catch(() => {
          socket.destroy();
        });
      } catch {
        socket.destroy();
      }
    }
  });
  socket.on("error", () => {
    observers.delete(socket);
  });
  socket.on("close", () => {
    observers.delete(socket);
  });
});
process.on("SIGTERM", () => {});
process.on("disconnect", () => {
  hostLost = true;
  if (identity && bootstrap.lifetime === "attached")
    void terminateGroup("Attached host connection closed", 100).catch((error: unknown) =>
      recordFailure(error),
    );
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("Guardian has no TCP control endpoint");
const ownProcess = await observeProcess(process.pid);
if (!ownProcess || (!windowsJob && ownProcess.group !== process.pid))
  throw new Error("Guardian is not its resident process group leader");
identity = supervisorIdentitySchema.parse({
  schemaVersion: 1,
  id: bootstrap.id,
  ownerEpoch: bootstrap.ownerEpoch,
  host: hostname(),
  platform: process.platform,
  process: ownProcess,
  scope: windowsJob
    ? {
        kind: "windows-job",
        name: windowsJob.name,
        launcherId: windowsJob.launcherId,
        launcher: windowsJob.process,
      }
    : { kind: "posix-group", group: process.pid },
  endpoint: { host: "127.0.0.1", port: address.port },
  nonce: bootstrap.nonce,
  directory,
  lifetime: bootstrap.lifetime,
});
status.enrolled = [ownProcess];
await writeProjection(directory, "identity.json", identity);
await refreshEnrollment();
await writeProjection(directory, "status.json", status);
if (process.connected) process.send?.({ kind: "ready", identity });
else hostLost = true;
if (hostLost && bootstrap.lifetime === "attached")
  void terminateGroup("Attached host lost during bootstrap", 100).catch((error: unknown) =>
    recordFailure(error),
  );
