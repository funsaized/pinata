import { spawn } from "node:child_process";
import { mkdir, open, readFile, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { z } from "zod";
import { canonicalJson, digestValue } from "../contracts/digest.ts";
import { publishImmutable } from "../storage/io.ts";
import { setupEnvironment } from "./setup-environment.ts";
import { gitRequestSchema } from "./git-protocol.ts";

const directory = process.argv[2];
if (!directory) throw new Error("Git command worker requires its private request directory");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

async function capture(source: Readable, file: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of source) {
      const bytes = Buffer.from(chunk);
      hash.update(bytes);
      await file.writeFile(bytes);
    }
    await file.sync();
  } finally {
    await file.close();
  }
  return hash.digest("hex");
}

for await (const line of lines) {
  const id = z.uuid().parse(JSON.parse(line));
  const request = gitRequestSchema.parse(
    JSON.parse(await readFile(join(directory, "requests", `${id}.json`), "utf8")),
  );
  if (request.id !== id) throw new Error("Git request identity changed");
  const resultDirectory = join(directory, "results", id);
  await mkdir(resultDirectory, { mode: 0o700 });
  // Setup selects environment names at execution time. Secret values are never
  // written to command requests, result metadata or supervisor payload records.
  const env: Record<string, string> = request.program
    ? setupEnvironment(request.program.passEnv, request.program.sourceRoot)
    : {};
  if (request.program) {
    if (Object.keys(request.env).length)
      throw new Error("Setup request cannot serialize environment overrides");
  } else {
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(directory, "empty.config"),
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_LITERAL_PATHSPECS: "1",
      LC_ALL: "C",
      ...request.env,
    });
  }
  // Open sinks before spawning. Node resumes unread stdio when a child exits;
  // awaiting a file open before attaching the readers can discard fast output.
  const stdoutFile = await open(join(resultDirectory, "stdout.bin"), "wx", 0o600);
  let stderrFile: FileHandle;
  try {
    stderrFile = await open(join(resultDirectory, "stderr.bin"), "wx", 0o600);
  } catch (error) {
    await stdoutFile.close();
    throw error;
  }
  const child = spawn(request.program?.executable ?? "git", request.args, {
    cwd: request.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let error: string | undefined;
  let signal: string | null = null;
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", (cause) => {
      error = cause.message;
    });
    child.once("close", (code, exitSignal) => {
      signal = exitSignal;
      resolve(code);
    });
  });
  // Argument rejection can close stdin before consuming it; preserve Git's own
  // exit code and stderr instead of replacing them with a transport EPIPE.
  child.stdin.on("error", (cause: NodeJS.ErrnoException) => {
    if (cause.code !== "EPIPE") error = cause.message;
  });
  child.stdin.end(request.input);
  const [code, stdout, stderr] = await Promise.all([
    exited,
    capture(child.stdout, stdoutFile),
    capture(child.stderr, stderrFile),
  ]);
  const result = {
    id,
    requestDigest: digestValue(request),
    code,
    signal,
    stdout,
    stderr,
    ...(error ? { error } : {}),
  };
  await publishImmutable(
    join(resultDirectory, "result.json"),
    Buffer.from(canonicalJson(result)),
    "git-result",
  );
  process.stdout.write(JSON.stringify(id) + "\n");
}
