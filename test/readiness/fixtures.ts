// Disposable fixtures for pre-rewrite investigations. No provider calls are required.
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { RunStore } from "../../engine/core/store.ts";
import { ZERO_USAGE, type AgentEvent } from "../../engine/core/types.ts";
import { writeRunRecord } from "../../engine/verify/integrate.ts";
import { Worktree } from "../../engine/workspace/worktree.ts";
import { gitRepo } from "../engine/faux.ts";
import { spec, tempDir } from "../engine/helpers.ts";

export async function applicationFixture(t: TestContext) {
  const directory = await tempDir(t, "pinata-readiness-apply-");
  const root = join(directory, "repo");
  const repo = gitRepo(root, { "a.txt": "base\n", "other.txt": "unrelated\n" });
  await repo.init();
  const head = repo.git("rev-parse", "HEAD").trim();
  const index = repo.git("ls-files", "--stage");
  const tree = await Worktree.create(root, join(directory, "isolated"), head);
  const run = "12345678-1234-1234-1234-123456789abc";
  const store = await RunStore.create(join(directory, "run"), "lean");
  const task = spec("build", "builder", { workspace: "worktree" });
  await writeRunRecord(store.dir, {
    schemaVersion: 3,
    id: run,
    root,
    head,
    branch: repo.git("rev-parse", "--symbolic-full-name", "HEAD").trim(),
    tasks: [task],
    allowWrites: true,
    passEnv: [],
  });
  await writeFile(join(tree.path, "a.txt"), "first\n");
  const changes = await tree.capture();
  const saved = {
    status: "succeeded",
    summary: "Fixture output; no quality assertion",
    result: null,
    usage: ZERO_USAGE,
    turns: 1,
    toolCalls: 0,
    assignment: 1,
    data: { changes, baseCommit: head, worktree: tree.path, checks: [] },
  };
  await store.writeAssignmentResult("build", 1, saved);
  const events = [
    { t: "run_started", tasks: [task], mode: "lean", cwd: root },
    { t: "agent_queued", agent: "build", assignment: 1, task, dependencies: [] },
    {
      t: "agent_settled",
      agent: "build",
      assignment: 1,
      status: saved.status,
      summary: saved.summary,
      usage: ZERO_USAGE,
      turns: 1,
      toolCalls: 0,
    },
  ];
  events.forEach((body, seq) => store.append({ v: 2, seq, at: seq, run, ...body } as AgentEvent));
  await store.flush(true);
  await store.close();
  return { root, repo, head, index, dir: store.dir, directory };
}

export async function nodeChild(file: URL, args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [fileURLToPath(file), ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => (stdout += text));
  child.stderr.setEncoding("utf8").on("data", (text: string) => (stderr += text));
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
    return { ...exit, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export async function readObject(file: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Expected object: ${file}`);
  return value as Record<string, unknown>;
}
