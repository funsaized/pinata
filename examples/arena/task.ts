import { constants } from "node:fs";
import { open, readFile, readdir, mkdir, writeFile, lstat, chmod } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sandbox } from "./sandbox.ts";
export const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export type Grading = { cases: unknown[]; expected: unknown[]; driver: string; rubric: string };
export type TaskPackage = {
  root: string;
  id: string;
  entry: string;
  prompt: string;
  publicFiles: string[];
  digest: string;
  prepare: (seed: number) => Grading;
};
export async function boundedFile(path: string, maxBytes = 262144): Promise<Buffer> {
  const h = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = await h.stat();
    if (!st.isFile() || st.size > maxBytes) throw new Error("Invalid or oversized candidate file");
    return await h.readFile();
  } finally {
    await h.close();
  }
}
export async function loadTask(root: string): Promise<TaskPackage> {
  root = resolve(root);
  const info = JSON.parse(await readFile(join(root, "task.json"), "utf8"));
  const simple = (s: unknown): s is string =>
    typeof s === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(s);
  if (
    info.schema !== 1 ||
    !simple(info.id) ||
    !simple(info.entry) ||
    !simple(info.prompt) ||
    !Array.isArray(info.publicFiles) ||
    !info.publicFiles.every(simple) ||
    !info.publicFiles.includes(info.entry) ||
    !info.publicFiles.includes(info.prompt) ||
    new Set(info.publicFiles).size !== info.publicFiles.length
  )
    throw new Error("Invalid task package");
  const parts = [JSON.stringify(info)];
  for (const file of info.publicFiles)
    parts.push(file, (await boundedFile(join(root, "public", file))).toString("utf8"));
  const grader = await boundedFile(join(root, "grading.mjs"));
  parts.push(grader.toString("utf8"));
  // Grading packages are trusted operator code, loaded only by the host, never supplied by agents.
  const { prepare } = await import(pathToFileURL(join(root, "grading.mjs")).href);
  if (typeof prepare !== "function") throw new Error("Task grader must export prepare(seed)");
  return { root, ...info, digest: hash(parts.join("\0")), prepare };
}
export async function freshWorkspace(task: TaskPackage, dir: string) {
  await mkdir(dir, { recursive: false, mode: 0o755 });
  for (const file of task.publicFiles) {
    await writeFile(join(dir, file), await boundedFile(join(task.root, "public", file)), {
      mode: 0o666,
    });
    await chmod(join(dir, file), 0o666);
  }
  // Only this fresh directory is writable by the unprivileged contestant container.
  await chmod(dir, 0o777);
}
export async function freeze(task: TaskPackage, workspace: string, dest: string) {
  const actual = (await readdir(workspace)).sort();
  if (!isDeepStrictEqual(actual, [...task.publicFiles].sort()))
    throw new Error("Candidate added or removed a forbidden file");
  for (const file of actual) {
    if ((await lstat(join(workspace, file))).isSymbolicLink())
      throw new Error("Candidate symlinks are forbidden");
    if (
      file !== task.entry &&
      !Buffer.compare(
        await boundedFile(join(workspace, file)),
        await boundedFile(join(task.root, "public", file)),
      )
    )
      continue;
    if (file !== task.entry) throw new Error(`Candidate changed protected file ${file}`);
  }
  const bytes = await boundedFile(join(workspace, task.entry));
  const source = bytes.toString("utf8");
  if (source.includes("\0") || !Buffer.from(source).equals(bytes))
    throw new Error("Candidate must be UTF-8 source");
  await mkdir(dest, { mode: 0o755 });
  await chmod(dest, 0o755);
  await writeFile(join(dest, task.entry), bytes, { mode: 0o444 });
  await chmod(join(dest, task.entry), 0o444);
  const old = (await boundedFile(join(task.root, "public", task.entry))).toString("utf8");
  const lines = (s: string) =>
    s === "" ? [] : s.endsWith("\n") ? s.slice(0, -1).split("\n") : s.split("\n");
  const before = lines(old);
  const after = lines(source);
  const range = (n: number) => (n === 0 ? "0,0" : `1,${n}`);
  const body = (xs: string[], prefix: string, text: string) =>
    xs.map((line) => `${prefix}${line}\n`).join("") +
    (text && !text.endsWith("\n") ? "\\ No newline at end of file\n" : "");
  const patch = `--- a/${task.entry}\n+++ b/${task.entry}\n@@ -${range(before.length)} +${range(after.length)} @@\n${body(before, "-", old)}${body(after, "+", source)}`;
  return { sha256: hash(bytes), patch };
}
export async function verify(
  task: TaskPackage,
  candidate: string,
  privateDir: string,
  image: string,
  seed: number,
  timeoutMs: number,
  outputBytes: number,
) {
  const grading = task.prepare(seed);
  if (
    !grading ||
    !Array.isArray(grading.cases) ||
    !Array.isArray(grading.expected) ||
    grading.cases.length !== grading.expected.length ||
    !grading.cases.length ||
    typeof grading.driver !== "string"
  )
    throw new Error("Invalid private grader");
  await mkdir(privateDir, { mode: 0o755 });
  await chmod(privateDir, 0o755);
  // Only a driver and inputs enter this fresh container. Expected answers and oracle stay
  // on the host. The generation container is gone before this mount exists.
  await writeFile(join(privateDir, "driver.mjs"), grading.driver, { mode: 0o444 });
  await chmod(join(privateDir, "driver.mjs"), 0o444);
  const result = await sandbox({
    image,
    workspace: candidate,
    inputDir: privateDir,
    command: ["node", "/arena/driver.mjs"],
    stdin: JSON.stringify(grading.cases),
    timeoutMs,
    outputBytes,
  });
  if (result.code === 125 || result.code === 126 || result.code === 127)
    throw new Error("Verifier container could not execute; infrastructure failure");
  let outputs: unknown;
  try {
    outputs = JSON.parse(result.stdout);
  } catch {
    outputs = undefined;
  }
  const valid =
    result.code === 0 &&
    !result.reason &&
    Array.isArray(outputs) &&
    outputs.length === grading.expected.length;
  const passed = valid
    ? grading.expected.filter((expected, i) =>
        isDeepStrictEqual((outputs as unknown[])[i], expected),
      ).length
    : 0;
  return {
    passed,
    total: grading.expected.length,
    success: valid && passed === grading.expected.length,
    rubric: grading.rubric,
    reason:
      result.reason ??
      (result.code !== 0
        ? "candidate execution failed"
        : !valid
          ? "invalid verifier output"
          : passed !== grading.expected.length
            ? "private checks failed"
            : null),
  };
}
