// Benchmark-only RSS reader. Windows keeps one warmed PowerShell/.NET process so
// a fresh PowerShell startup cannot consume a short agent's entire loaded lifetime.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { processRss } from "../engine/core/telemetry.ts";

export const RSS_PROTOCOL = 1;
export const rssMethod = (platform: string = process.platform) =>
  platform === "win32"
    ? "windows-persistent-dotnet-working-set-v1"
    : platform === "linux"
      ? "linux-proc-status-v1"
      : "ps-rss-v1";

const WINDOWS_READER = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::Out.WriteLine('{"type":"ready","protocol":1}')
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $query = $line | ConvertFrom-Json
  $samples = [ordered]@{}
  foreach ($processId in $query.pids) {
    $entry = $null
    try {
      $entry = [System.Diagnostics.Process]::GetProcessById([int]$processId)
      $entry.Refresh()
      $samples[[string]$processId] = [long]$entry.WorkingSet64
    } catch [System.ArgumentException] {
      $samples[[string]$processId] = $null
    } catch [System.InvalidOperationException] {
      $samples[[string]$processId] = $null
    } catch [System.ComponentModel.Win32Exception] {
      $samples[[string]$processId] = $null
    } finally {
      if ($null -ne $entry) { $entry.Dispose() }
    }
  }
  $response = @{ id = $query.id; samples = $samples } | ConvertTo-Json -Compress -Depth 4
  [Console]::Out.WriteLine($response)
  [Console]::Out.Flush()
}
`;

export interface RssReader {
  method: string;
  read: typeof processRss;
  close(): Promise<void>;
}

interface ReaderOptions {
  // Tests use a Node protocol fixture; production always uses the encoded script.
  command?: string[];
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
}

class PersistentRssReader implements RssReader {
  readonly method = rssMethod("win32");
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly options: Required<Omit<ReaderOptions, "command">>;
  private readonly exited: Promise<void>;
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private isReady = false;
  private terminated = false;
  private closing?: Promise<void>;
  private failure?: Error;
  private buffer = "";
  private stderr = "";
  private nextId = 0;
  private queue: Promise<void> = Promise.resolve();
  private pending?: {
    id: number;
    pids: number[];
    resolve: (samples: Map<number, number | null>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };

  constructor(options: ReaderOptions) {
    this.options = {
      startupTimeoutMs: options.startupTimeoutMs ?? 10_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 2_000,
      closeTimeoutMs: options.closeTimeoutMs ?? 1_000,
    };
    const command = options.command ?? [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(WINDOWS_READER, "utf16le").toString("base64"),
    ];
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.child = spawn(command[0], command.slice(1), {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise<void>((resolve) =>
      this.child.once("close", (code) => {
        if (!this.closing || (code !== 0 && !this.terminated))
          this.fail(
            new Error(`RSS reader exited unexpectedly${this.stderr ? `: ${this.stderr}` : ""}`),
          );
        resolve();
      }),
    );
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stdout.setEncoding("utf8").on("data", (chunk: string) => this.receive(chunk));
    this.child.stdout.on("error", (error) => this.fail(error));
    this.child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4096);
    });
  }

  async warm(): Promise<void> {
    const timer = setTimeout(
      () => this.fail(new Error("RSS reader startup timed out")),
      this.options.startupTimeoutMs,
    );
    try {
      await this.ready;
    } finally {
      clearTimeout(timer);
    }
    // Exercise JSON parsing, .NET process lookup and WorkingSet64 before t0. A
    // ready marker alone would leave first-use costs inside the measured run.
    const sample = (await this.read([process.pid])).get(process.pid);
    if (sample === null || sample === undefined || sample <= 0)
      throw new Error("RSS reader warm-up did not return a positive host working set");
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.rejectReady(error);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
    this.child.kill();
  }

  private receive(chunk: string): void {
    if (this.failure) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 65536) {
      this.fail(new Error("RSS reader response exceeds 64 KiB"));
      return;
    }
    let end: number;
    while ((end = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      try {
        const response = JSON.parse(line);
        if (!this.isReady) {
          if (response?.type !== "ready" || response.protocol !== RSS_PROTOCOL)
            throw new Error("RSS reader sent an invalid ready envelope");
          this.isReady = true;
          this.resolveReady();
          continue;
        }
        const pending = this.pending;
        if (!pending || response?.id !== pending.id)
          throw new Error("RSS reader response has an unexpected request id");
        const values = response.samples;
        if (
          !values ||
          typeof values !== "object" ||
          Array.isArray(values) ||
          Object.keys(values).length !== pending.pids.length
        )
          throw new Error("RSS reader response has invalid sample coverage");
        const samples = new Map<number, number | null>();
        for (const pid of pending.pids) {
          const bytes = values[pid];
          if (
            bytes !== null &&
            !(typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0)
          )
            throw new Error(`RSS reader response has an invalid working set for ${pid}`);
          samples.set(pid, bytes === null ? null : Math.round((bytes / 1048576) * 10) / 10);
        }
        clearTimeout(pending.timer);
        this.pending = undefined;
        pending.resolve(samples);
      } catch (error) {
        this.fail(new Error(`RSS reader protocol failure: ${String(error)}`));
        return;
      }
    }
  }

  read(pids: readonly number[]): Promise<Map<number, number | null>> {
    const unique = [...new Set(pids)];
    if (unique.some((pid) => !Number.isSafeInteger(pid) || pid <= 0))
      return Promise.reject(new Error("RSS reader requires positive integer PIDs"));
    const query = this.queue.then(() => {
      if (this.failure) throw this.failure;
      if (this.closing) throw new Error("RSS reader is closed");
      if (!unique.length) return new Map<number, number | null>();
      return new Promise<Map<number, number | null>>((resolve, reject) => {
        const id = ++this.nextId;
        const timer = setTimeout(
          () => this.fail(new Error(`RSS reader request ${id} timed out`)),
          this.options.requestTimeoutMs,
        );
        this.pending = { id, pids: unique, resolve, reject, timer };
        this.child.stdin.write(JSON.stringify({ id, pids: unique }) + "\n", (error) => {
          if (error) this.fail(error);
        });
      });
    });
    this.queue = query.then(
      () => {},
      () => {},
    );
    return query;
  }

  private waitForExit(): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), this.options.closeTimeoutMs);
      void this.exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  close(): Promise<void> {
    return (this.closing ??= (async () => {
      // Close rejects outstanding reads rather than silently returning partial data.
      if (this.pending) this.fail(new Error("RSS reader closed during a request"));
      this.child.stdin.end();
      if (!(await this.waitForExit())) {
        this.terminated = true;
        this.child.kill("SIGKILL");
        if (!(await this.waitForExit()))
          throw new Error("RSS reader did not exit after termination");
      }
      // Idle failure after the final read must not become passing evidence.
      if (this.failure) throw this.failure;
    })());
  }
}

export async function persistentWindowsRssReader(options: ReaderOptions = {}): Promise<RssReader> {
  const reader = new PersistentRssReader(options);
  try {
    await reader.warm();
    return reader;
  } catch (error) {
    try {
      await reader.close();
    } catch (cleanupError) {
      if (cleanupError !== error)
        throw new AggregateError([error, cleanupError], "RSS reader warm-up and cleanup failed", {
          cause: error,
        });
    }
    throw error;
  }
}

export async function createRssReader(): Promise<RssReader> {
  return process.platform === "win32"
    ? persistentWindowsRssReader()
    : { method: rssMethod(), read: processRss, close: async () => {} };
}
