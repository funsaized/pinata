import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { z } from "zod";
import { processIdentitySchema, type Payload, type ProcessIdentity } from "./contracts.ts";
import { windowsHelperExecutable } from "./windows-helper.ts";

export const windowsCloseProofSchema = z.strictObject({
  jobName: z.string().min(1),
  launcherId: z.uuid(),
  activeProcesses: z.literal(0),
  closed: z.literal(true),
});
const snapshotSchema = z.strictObject({
  activeProcesses: z.number().int().nonnegative(),
  processes: z.array(processIdentitySchema),
});
export const windowsPacketSchema = z.union([
  z.strictObject({
    kind: z.literal("ready"),
    jobName: z.string(),
    launcherId: z.uuid(),
    process: processIdentitySchema,
  }),
  z.strictObject({
    kind: z.literal("response"),
    id: z.number().int(),
    ok: z.literal(true),
    value: z.unknown(),
  }),
  z.strictObject({
    kind: z.literal("response"),
    id: z.number().int(),
    ok: z.literal(false),
    error: z.string(),
  }),
  z.strictObject({
    kind: z.literal("output"),
    stream: z.enum(["stdout", "stderr"]),
    data: z.string(),
  }),
  z.strictObject({ kind: z.literal("exit"), code: z.number().int() }),
  z.strictObject({ kind: z.literal("drained") }),
  z.strictObject({ kind: z.literal("failure"), error: z.string() }),
]);

export class WindowsJob extends EventEmitter {
  readonly name: string;
  readonly launcherId: string;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly child: ChildProcessWithoutNullStreams;
  private ordinal = 0;
  private closed = false;
  private drained = false;
  private failure: Error | undefined;
  private stopping: Promise<z.infer<typeof windowsCloseProofSchema>> | undefined;
  private launcher: ProcessIdentity | undefined;
  private readonly exited: Promise<number | null>;
  private resolveExit: (code: number | null) => void = () => {};
  private resolveReady: () => void = () => {};
  private rejectReady: (error: Error) => void = () => {};

  private constructor(name: string, launcherId: string, child: ChildProcessWithoutNullStreams) {
    super();
    this.name = name;
    this.launcherId = launcherId;
    this.child = child;
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        void this.request({ action: "input", data: Buffer.from(chunk).toString("base64") }).then(
          () => callback(),
          callback,
        );
      },
      final: (callback) => {
        void this.request({ action: "input_end" }).then(() => callback(), callback);
      },
    });
    // Errors remain available through requests and the guardian's failure event.
    for (const stream of [this.stdin, this.stdout, this.stderr]) stream.on("error", () => {});
  }

  static async open(id: string): Promise<WindowsJob> {
    const executable = await windowsHelperExecutable();
    const name = `Local\\Pinata-${id}`;
    const launcherId = randomUUID();
    const child = spawn(executable, [name, launcherId], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const job = new WindowsJob(name, launcherId, child);
    const ready = new Promise<void>((resolve, reject) => {
      job.resolveReady = resolve;
      job.rejectReady = reject;
    });
    let buffered = "",
      errors = "";
    job.child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      errors = (errors + chunk).slice(-16_384);
    });
    job.child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      buffered += chunk;
      if (Buffer.byteLength(buffered) > 2 * 1024 * 1024) {
        job.fail(new Error("Windows helper packet exceeds its bound"));
        return;
      }
      for (;;) {
        const end = buffered.indexOf("\n");
        if (end === -1) break;
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        try {
          job.receive(windowsPacketSchema.parse(JSON.parse(line)));
        } catch (error) {
          job.fail(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    job.child.once("error", (error) => job.fail(error));
    job.child.once("close", (code) => {
      job.resolveExit(code);
      if (!job.closed)
        job.fail(new Error(`Windows helper exited without confirmed closure: ${errors || code}`));
    });
    const timeout = setTimeout(
      () => job.fail(new Error("Windows helper enrollment timed out")),
      10_000,
    );
    try {
      await ready;
      return job;
    } finally {
      clearTimeout(timeout);
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.rejectReady(error);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.stdout.destroy(error);
    this.stderr.destroy(error);
    this.emit("failure", error);
    // The live ChildProcess owns the launcher. Closing its handles activates kill-on-close;
    // this path never claims a confirmed cleanup receipt.
    if (this.child?.exitCode === null && this.child.signalCode === null) this.child.kill();
  }

  private receive(packet: z.infer<typeof windowsPacketSchema>): void {
    switch (packet.kind) {
      case "ready":
        if (packet.jobName !== this.name || packet.launcherId !== this.launcherId)
          throw new Error("Windows job identity differs from its launch");
        if (packet.process.pid !== this.child.pid)
          throw new Error("Windows launcher PID differs from its live child");
        this.launcher = packet.process;
        this.resolveReady();
        return;
      case "response": {
        const request = this.pending.get(packet.id);
        if (!request) throw new Error("Unknown Windows helper response");
        this.pending.delete(packet.id);
        clearTimeout(request.timer);
        if (packet.ok) request.resolve(packet.value);
        else request.reject(new Error(packet.error));
        return;
      }
      case "output": {
        const stream = this[packet.stream];
        if (!stream.write(Buffer.from(packet.data, "base64"))) {
          this.child.stdout.pause();
          stream.once("drain", () => this.child.stdout.resume());
        }
        return;
      }
      case "exit":
        this.emit("exit", packet.code, null);
        return;
      case "drained":
        this.drained = true;
        this.stdout.end();
        this.stderr.end();
        return;
      case "failure":
        this.fail(new Error(packet.error));
        return;
    }
  }

  private request(command: Record<string, unknown>): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error("Windows job launcher is closed"));
    const id = ++this.ordinal;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("Windows job control timed out")), 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, ...command }) + "\n", (error) => {
        if (error) this.fail(error);
      });
    });
  }

  async start(payload: Payload): Promise<void> {
    const env =
      payload.env ??
      Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    z.strictObject({
      root: processIdentitySchema,
      membership: z.literal("creation-time-job-list"),
    }).parse(await this.request({ action: "start", payload: { ...payload, env } }));
  }

  async inspect(): Promise<z.infer<typeof snapshotSchema>> {
    return snapshotSchema.parse(await this.request({ action: "inspect" }));
  }
  get process(): ProcessIdentity {
    if (!this.launcher) throw new Error("Windows launcher is not enrolled");
    return structuredClone(this.launcher);
  }
  async enroll(pid: number): Promise<void> {
    snapshotSchema.parse(await this.request({ action: "enroll", pid }));
  }

  stop(): Promise<z.infer<typeof windowsCloseProofSchema>> {
    this.stopping ??= this.closeJob();
    return this.stopping;
  }

  private async closeJob(): Promise<z.infer<typeof windowsCloseProofSchema>> {
    z.strictObject({ empty: z.literal(true) }).parse(await this.request({ action: "stop" }));
    const proof = windowsCloseProofSchema.parse(await this.request({ action: "close" }));
    if (proof.jobName !== this.name || proof.launcherId !== this.launcherId)
      throw new Error("Windows closure belongs to another launcher");
    this.closed = true;
    this.child.stdin.end();
    const timeout = setTimeout(() => {
      this.child.kill();
      this.fail(new Error("Windows launcher did not exit after closing its job"));
    }, 5000);
    let code: number | null;
    try {
      code = await this.exited;
    } finally {
      clearTimeout(timeout);
    }
    if (code !== 0) throw new Error("Windows job launcher did not close successfully");
    if (!this.drained) {
      this.stdout.end();
      this.stderr.end();
    }
    return proof;
  }
}
