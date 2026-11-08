// The run store: state stays in memory; the run directory holds an append-only events.jsonl
// (buffered, flushed every 250 ms and on terminal events, fsynced when the run settles),
// results/<task>.json and transcripts/<task>.jsonl. Directories are private (0700).
import { spawn } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { appendFile, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { retained, terminal, validateEvent } from "./events.ts";
import { reduce, emptyView, type RunView } from "./view.ts";
import type { AgentEvent, Mode } from "./types.ts";

export const FLUSH_MS = 250;

export async function privateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await lstat(dir)).isSymbolicLink())
    throw new Error(`Run directory must not be a symlink: ${dir}`);
}

// Writes JSON through a temporary file and a rename, so readers never see a partial file.
export async function atomicJson(file: string, value: unknown): Promise<void> {
  const encoded = JSON.stringify(value, null, 2) + "\n";
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(encoded);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, file);
    if (process.platform !== "win32") {
      const directory = await open(dirname(file), constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export async function readJson<T = unknown>(file: string): Promise<T> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new Error(`Invalid or oversized JSON file: ${file}`);
    return JSON.parse(await handle.readFile("utf8")) as T;
  } finally {
    await handle.close();
  }
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out.replace(/\r?\n$/, ""))
        : reject(new Error(`git ${args[0]} failed: ${err.trim()}`)),
    );
  });
}

// `<git common dir>/pinata`, shared by every worktree of the repository.
export async function runsRoot(cwd: string): Promise<string> {
  const canonical = await realpath(resolve(cwd));
  try {
    const common = await git(canonical, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    return join(await realpath(common), "pinata");
  } catch {
    // The same resolver is used by Pi, headless, viewers and recovery. No git init.
    return join(canonical, ".pinata", "runs");
  }
}

export class RunStore {
  readonly dir: string;
  readonly mode: Mode;
  private buffer: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private failed: Error | undefined;
  private readonly live = new Set<string>();

  private constructor(dir: string, mode: Mode) {
    this.dir = dir;
    this.mode = mode;
  }

  static async create(dir: string, mode: Mode): Promise<RunStore> {
    await privateDir(dir);
    await Promise.all([privateDir(join(dir, "results")), privateDir(join(dir, "transcripts"))]);
    return new RunStore(dir, mode);
  }

  // Reopens an existing run directory to keep appending (resume after a reload).
  static async open(dir: string, mode: Mode): Promise<RunStore> {
    return RunStore.create(dir, mode);
  }

  get error(): Error | undefined {
    return this.failed;
  }

  append(event: AgentEvent): void {
    if (!retained(event, this.mode)) return;
    this.buffer.push(JSON.stringify(event) + "\n");
    if (terminal(event)) void this.flush(event.t === "run_settled");
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), FLUSH_MS);
      this.timer.unref?.();
    }
  }

  // Writes buffered lines; `sync` also fsyncs the log.
  flush(sync = false): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const lines = this.buffer.join("");
    this.buffer = [];
    const file = join(this.dir, "events.jsonl");
    this.writing = this.writing.then(async () => {
      try {
        if (lines) await appendFile(file, lines, { mode: 0o600 });
        if (sync) {
          const handle = await open(file, "a", 0o600);
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
        }
      } catch (error) {
        this.failed ??= error as Error;
      }
    });
    return this.writing;
  }

  async writeResult(task: string, value: unknown): Promise<string> {
    const file = join(this.dir, "results", `${task}.json`);
    await atomicJson(file, value);
    return file;
  }

  async readResult<T = unknown>(task: string): Promise<T | null> {
    return readJson<T>(join(this.dir, "results", `${task}.json`)).catch(() => null);
  }

  async writeAssignmentResult(worker: string, assignment: number, value: unknown): Promise<string> {
    const folder = join(this.dir, "results", worker);
    await privateDir(folder);
    const file = join(folder, `${assignment}.json`);
    await atomicJson(file, value);
    await this.writeResult(worker, value);
    return file;
  }
  readAssignmentResult<T = import("./engine.ts").Settled>(
    worker: string,
    assignment: number,
  ): Promise<T | null> {
    return readJson<T>(join(this.dir, "results", worker, `${assignment}.json`)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
  }
  async writeInbox(id: string, value: unknown): Promise<void> {
    const folder = join(this.dir, "inbox");
    await privateDir(folder);
    await atomicJson(join(folder, `${createHash("sha256").update(id).digest("hex")}.json`), value);
  }
  async readInbox<T>(): Promise<T[]> {
    const folder = join(this.dir, "inbox");
    const files = await readdir(folder).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    return Promise.all(
      files.filter((name) => name.endsWith(".json")).map((name) => readJson<T>(join(folder, name))),
    );
  }

  transcriptPath(task: string): string {
    return join(this.dir, "transcripts", `${task}.jsonl`);
  }

  // Lean mode: the whole transcript at settle. Observe mode: one message at a time.
  async writeTranscript(task: string, messages: readonly unknown[]): Promise<string> {
    const file = this.transcriptPath(task);
    if (this.live.has(task)) return file;
    const tmp = `${file}.${randomUUID()}.tmp`;
    await appendFile(tmp, messages.map((m) => JSON.stringify(m) + "\n").join(""), { mode: 0o600 });
    await rename(tmp, file);
    return file;
  }

  appendTranscript(task: string, message: unknown): Promise<void> {
    this.live.add(task);
    const line = JSON.stringify(message) + "\n";
    this.writing = this.writing.then(() =>
      appendFile(this.transcriptPath(task), line, { mode: 0o600 }).catch((error: Error) => {
        this.failed ??= error;
      }),
    );
    return this.writing;
  }

  markDelivered(): Promise<boolean> {
    return markDelivered(this.dir);
  }

  async close(): Promise<void> {
    await this.flush(true);
  }
}

export async function* jsonlEntries(file: string): AsyncGenerator<unknown> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let endsWithNewline = false;
  stream.on("data", (chunk) => {
    endsWithNewline = chunk.toString().endsWith("\n");
  });
  let pendingError: Error | undefined;
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber++;
      if (!line.trim()) continue;
      if (pendingError) throw pendingError;
      try {
        yield JSON.parse(line);
      } catch (error) {
        pendingError = new Error(`${file} line ${lineNumber}: invalid JSONL record`, {
          cause: error,
        });
      }
    }
    // Only a partial final record may be dropped after interruption.
    if (pendingError && endsWithNewline) throw pendingError;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    lines.close();
    stream.destroy();
  }
}
export async function* iterateEvents(dir: string): AsyncGenerator<AgentEvent> {
  for await (const value of jsonlEntries(join(dir, "events.jsonl"))) yield validateEvent(value);
}
export async function readEvents(dir: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterateEvents(dir)) events.push(event);
  return events;
}

// Rebuilds a run's view from its log.
export async function replay(dir: string): Promise<RunView> {
  let view = emptyView("");
  for await (const event of iterateEvents(dir)) view = reduce(view, event);
  return view;
}

// Run directories under a runs root, newest first by directory mtime.
export async function listRuns(root: string): Promise<string[]> {
  const names = await readdir(root).catch(() => [] as string[]);
  const runs = await Promise.all(
    names
      .filter((n) => /^[a-f0-9-]{36}$/.test(n))
      .map(async (n) => ({
        dir: join(root, n),
        at: (await lstat(join(root, n)).catch(() => null))?.mtimeMs ?? 0,
      })),
  );
  return runs.sort((a, b) => b.at - a.at).map((r) => r.dir);
}

// Transcript helpers for backends, which write their own transcripts: the whole transcript
// once (lean) or one message at a time (observe).
export async function writeJsonl(file: string, items: readonly unknown[]): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await appendFile(tmp, items.map((m) => JSON.stringify(m) + "\n").join(""), { mode: 0o600 });
  await rename(tmp, file);
}

// Reads a JSONL file; a missing file is empty and a partial last line (a crash) is dropped.
export async function readJsonl(file: string): Promise<unknown[]> {
  const items: unknown[] = [];
  for await (const entry of jsonlEntries(file)) items.push(entry);
  return items;
}

export function appendJsonl(file: string, item: unknown): Promise<void> {
  return appendFile(file, JSON.stringify(item) + "\n", { mode: 0o600 });
}

// Records that a run's result was delivered. True only for the first caller.
export async function markDelivered(dir: string): Promise<boolean> {
  try {
    const handle = await open(join(dir, "delivered.json"), "wx", 0o600);
    await handle.writeFile(JSON.stringify({ at: Date.now() }));
    await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}
