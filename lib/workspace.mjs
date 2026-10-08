import os from "node:os";
import path from "node:path";
import * as fs from "node:fs/promises";
import {
  MAX_FILE,
  need,
  equal,
  git,
  line,
  command,
  environment,
  safePath,
  fileState,
  applyFile,
  exists,
  readJson,
  digest,
  plannedChecks,
} from "./core.mjs";
import { executable } from "./config.mjs";
import { at, getTask, ancestors, orderedTasks, save } from "./run.mjs";
import { outcome } from "./evidence.mjs";

// Only tool-restricted inspections without executable checks share a revision.
// Builders, their dependents and check-bearing inspections keep their own trees.
export function worktreePath(run, task) {
  if (task.spec.reviewOf) return worktreePath(run, getTask(run, task.spec.reviewOf));
  const shared =
    run.config.workspaceReuse !== false &&
    task.spec.role !== "builder" &&
    !plannedChecks(task.spec).length &&
    ![...ancestors(run, task)].some((id) => getTask(run, id).spec.role === "builder");
  const name = shared ? `inspection-${digest(task.subject?.head ?? run.baseCommit)}` : task.spec.id;
  return path.join(run.dir, "worktrees", name);
}

const preparingTrees = new WeakMap();
export async function ensureWorktree(run, task) {
  if (task.spec.reviewOf) return ensureWorktree(run, getTask(run, task.spec.reviewOf));
  if (task.worktree && (await exists(task.worktree))) return task.worktree;
  const cwd = worktreePath(run, task);
  task.worktree = cwd;
  await save(run);
  let trees = preparingTrees.get(run);
  if (!trees) preparingTrees.set(run, (trees = new Map()));
  if (!trees.has(cwd))
    trees.set(
      cwd,
      (async () => {
        if (!(await exists(cwd))) {
          const materialization = await materialize(run, cwd, task.subject?.head ?? run.baseCommit);
          const included = await copyIncluded(run.cwd, cwd);
          return { materialization, included };
        }
        const sibling = run.tasks.find((t) => t !== task && t.worktree === cwd);
        return {
          materialization: sibling?.materialization ?? { method: "existing" },
          included: sibling?.included ?? [],
        };
      })(),
    );
  const tree = await trees.get(cwd);
  task.materialization = tree.materialization;
  task.included = tree.included;
  for (const predecessor of orderedTasks(run).filter(
    (t) => ancestors(run, task).has(t.spec.id) && t.spec.role === "builder",
  )) {
    const prior = await outcome(run, predecessor);
    need(prior.status === "succeeded", "Dependency did not succeed");
    for (const change of prior.changes) {
      need(equal(await fileState(cwd, change.path), change.before), "Dependency changes conflict");
      await applyFile(cwd, change, path.join(at(run, predecessor), "files"));
    }
  }
  const archived = task.attempts.findLast((a) => a.archivedOutcome);
  if (archived && task.spec.role === "builder") {
    const o = await readJson(path.join(at(run, task, archived), "outcome.json"));
    need(digest(o) === archived.archivedOutcome, "Archived builder outcome changed");
    for (const change of o.changes)
      await applyFile(cwd, change, path.join(at(run, task, archived), "files"));
  }
  delete task.worktreeRemoved;
  delete task.cleanupError;
  await fs.rm(path.join(run.dir, "setup", `${task.spec.id}.json`), { force: true });
  return cwd;
}

// A real Git worktree/index is always created. Large regular-file trees can use
// native CoW copies of the user's checkout, then Git verifies every copied file
// against the requested commit. Unsupported filesystems or a changed source
// fall back to an ordinary checkout in this private destination.
export async function materialize(run, cwd, commit) {
  const startedAt = Date.now();
  let entries = [];
  if (run.config.workspaceReuse === "copy-on-write" && commit === run.baseCommit) {
    const tree = await git(run.cwd, ["ls-tree", "-r", "-l", "-z", commit]);
    entries = tree
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const tab = entry.indexOf("\t");
        const [mode, type, , size] = entry.slice(0, tab).trim().split(/\s+/);
        return { mode, type, size: Number(size), file: entry.slice(tab + 1) };
      });
  }
  const eligible =
    entries.length &&
    entries.every((e) => e.type === "blob" && ["100644", "100755"].includes(e.mode)) &&
    entries.reduce((n, e) => n + e.size, 0) >= 16 * 1024 * 1024;
  if (!eligible) {
    await git(run.cwd, ["worktree", "add", "--detach", cwd, commit], { timeoutMs: 120_000 });
    return { method: "checkout", elapsedMs: Date.now() - startedAt };
  }
  await git(run.cwd, ["worktree", "add", "--detach", "--no-checkout", cwd, commit], {
    timeoutMs: 120_000,
  });
  let method = "reflink";
  try {
    await git(cwd, ["read-tree", commit]);
    if (process.platform === "linux") {
      // Inputs come only from Git's regular-file tree. cp preserves symlinks if
      // the source changes underneath us; the Git check below rejects them.
      // Batch argument size as well as file count to stay below execve limits.
      let batch = [],
        bytes = 0;
      const flush = async () => {
        if (!batch.length) return;
        const copied = await command(
          [
            "cp",
            "--reflink=always",
            "--no-dereference",
            "--parents",
            "--preserve=mode",
            "--target-directory",
            cwd,
            "--",
            ...batch,
          ],
          { cwd: run.cwd, timeoutMs: 120_000 },
        );
        need(copied.code === 0, "Native CoW copy unavailable");
        batch = [];
        bytes = 0;
      };
      for (const { file } of entries) {
        if (bytes + Buffer.byteLength(file) > 64_000) await flush();
        batch.push(file);
        bytes += Buffer.byteLength(file) + 1;
      }
      await flush();
    } else {
      let next = 0;
      const results = await Promise.allSettled(
        Array.from({ length: Math.min(16, entries.length) }, async () => {
          while (next < entries.length) {
            const entry = entries[next++];
            const source = await safePath(run.cwd, entry.file),
              target = await safePath(cwd, entry.file);
            need((await fs.lstat(source)).isFile(), "CoW source is not a regular file");
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.copyFile(
              source,
              target,
              fs.constants.COPYFILE_FICLONE_FORCE | fs.constants.COPYFILE_EXCL,
            );
            await fs.chmod(target, entry.mode === "100755" ? 0o755 : 0o644);
          }
        }),
      );
      if (results.some((r) => r.status === "rejected")) throw new Error("CoW unavailable");
    }
    // Fresh read-tree entries have no trusted stat cache. Compare actual content.
    await git(
      cwd,
      [
        "-c",
        "core.fsmonitor=false",
        "diff",
        "--exit-code",
        "--no-ext-diff",
        "--no-textconv",
        "HEAD",
        "--",
      ],
      { timeoutMs: 120_000 },
    );
  } catch {
    method = "checkout";
    for (const file of await fs.readdir(cwd))
      if (file !== ".git") await fs.rm(path.join(cwd, file), { recursive: true, force: true });
    await git(cwd, ["reset", "--hard", commit], { timeoutMs: 120_000 });
  }
  return { method, elapsedMs: Date.now() - startedAt };
}

const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "pinata",
  GIT_AUTHOR_EMAIL: "pinata@localhost",
  GIT_COMMITTER_NAME: "pinata",
  GIT_COMMITTER_EMAIL: "pinata@localhost",
};

// Records tracked and untracked (not ignored) changes as a commit on top of HEAD,
// so workers see the checkout as it is. It works on a copy of the user's index,
// which keeps sparse-checkout flags and leaves the real index alone, and a
// private ref keeps the commit for later repairs. Returns null when the working
// tree matches HEAD.
export async function snapshotBase(root, head, runId) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pinata-index-"));
  try {
    const env = { ...environment(), GIT_INDEX_FILE: path.join(tmp, "index") };
    const index = path.resolve(root, line(await git(root, ["rev-parse", "--git-path", "index"])));
    if (await exists(index)) await fs.copyFile(index, env.GIT_INDEX_FILE);
    else await git(root, ["read-tree", head], { env });
    await git(root, ["add", "--all"], { env, timeoutMs: 120_000 });
    const tree = line(await git(root, ["write-tree"], { env }));
    if (tree === line(await git(root, ["rev-parse", `${head}^{tree}`]))) return null;
    const commit = line(
      await git(
        root,
        ["commit-tree", "--no-gpg-sign", "-p", head, "-m", "pinata: uncommitted changes", tree],
        { env: { ...env, ...SNAPSHOT_IDENTITY } },
      ),
    );
    await git(root, ["update-ref", `refs/pinata/${runId}/base`, commit]);
    const files = (await git(root, ["diff", "--name-only", "-z", "--no-renames", head, commit]))
      .split("\0")
      .filter(Boolean);
    return { commit, files };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

const INCLUDE_MAX_FILES = 1000;

// Copies the gitignored files that .worktreeinclude names (gitignore syntax, the
// convention Claude Code uses) from the user's checkout into a new worktree.
// Only files ignored in the worktree are copied, so they never become part of a
// snapshot, a deliverable, or an integration.
export async function copyIncluded(root, cwd) {
  const list = path.join(root, ".worktreeinclude");
  if (!(await exists(list))) return [];
  need((await fs.lstat(list)).isFile(), ".worktreeinclude must be a regular file");
  const matched = (
    await git(root, ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${list}`], {
      timeoutMs: 60_000,
    })
  )
    .split("\0")
    .filter(Boolean);
  if (!matched.length) return [];
  const check = await command(["git", "-C", cwd, "check-ignore", "-z", "--stdin"], {
    input: matched.join("\0") + "\0",
    timeoutMs: 60_000,
  });
  need(check.code === 0 || check.code === 1, "git check-ignore failed for .worktreeinclude");
  const ignored = check.stdout.split("\0").filter(Boolean);
  need(
    ignored.length <= INCLUDE_MAX_FILES,
    `.worktreeinclude matches more than ${INCLUDE_MAX_FILES} files; narrow its patterns`,
  );
  const copied = [];
  for (const file of ignored.sort()) {
    const source = await safePath(root, file);
    const st = await fs.lstat(source);
    if (!st.isFile() || st.size > MAX_FILE) continue;
    const target = await safePath(cwd, file);
    if (await exists(target)) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    await fs.chmod(target, st.mode & 0o777);
    copied.push(file);
  }
  return copied;
}

// Root lockfiles and the strict install each implies. Every command refuses to
// rewrite its lockfile, so setup cannot produce deliverable changes.
const ECOSYSTEMS = [
  [
    ["pnpm-lock.yaml", "pnpm", () => "pnpm install --frozen-lockfile --prefer-offline"],
    ["bun.lock", "bun", () => "bun install --frozen-lockfile"],
    ["bun.lockb", "bun", () => "bun install --frozen-lockfile"],
    [
      "yarn.lock",
      "yarn",
      (files) =>
        files.includes(".yarnrc.yml")
          ? "yarn install --immutable"
          : "yarn install --frozen-lockfile",
    ],
    ["package-lock.json", "npm", () => "npm ci --prefer-offline --no-audit --no-fund"],
    ["npm-shrinkwrap.json", "npm", () => "npm ci --prefer-offline --no-audit --no-fund"],
  ],
  [
    ["uv.lock", "uv", () => "uv sync --frozen"],
    ["poetry.lock", "poetry", () => "poetry install --no-interaction"],
    ["Pipfile.lock", "pipenv", () => "pipenv sync"],
  ],
];
export const LOCKFILES = ECOSYSTEMS.flat().map(([file]) => file);

// Resolves config.setup once per run: an explicit command, false, or lockfile detection.
export async function resolveSetup(setup, root, commit) {
  if (setup === false) return { command: null, source: "disabled" };
  if (typeof setup === "string") return { command: setup, source: "config" };
  const files = (await git(root, ["ls-tree", "--name-only", "-z", commit])).split("\0");
  const commands = [],
    lockfiles = [];
  for (const ecosystem of ECOSYSTEMS) {
    const found = ecosystem.filter(([file]) => files.includes(file));
    const managers = [...new Set(found.map(([, manager]) => manager))];
    if (managers.length > 1)
      return {
        command: null,
        source: "none",
        reason: `Conflicting lockfiles (${found.map(([f]) => f).join(", ")}); set config.setup`,
      };
    if (!found.length) continue;
    try {
      await executable(managers[0]);
    } catch {
      return {
        command: null,
        source: "none",
        reason: `${found[0][0]} needs ${managers[0]}, which is not on PATH; install it or set config.setup`,
      };
    }
    commands.push(found[0][2](files));
    lockfiles.push(...found.map(([file]) => file));
  }
  if (!commands.length)
    return { command: null, source: "none", reason: "No root lockfile detected" };
  return { command: commands.join(" && "), source: "detected", lockfiles };
}
