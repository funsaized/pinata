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
} from "./core.mjs";
import { executable } from "./config.mjs";
import { at, getTask, ancestors, orderedTasks, save } from "./run.mjs";
import { outcome } from "./evidence.mjs";

// A reviewer of a task inspects its target's tree; every other task, including a
// review of existing changes, owns one worktree for all attempts.
export async function ensureWorktree(run, task) {
  if (task.spec.reviewOf) return ensureWorktree(run, getTask(run, task.spec.reviewOf));
  if (task.worktree && (await exists(task.worktree))) return task.worktree;
  const cwd = path.join(run.dir, "worktrees", task.spec.id);
  task.worktree = cwd;
  await save(run);
  await git(run.cwd, ["worktree", "add", "--detach", cwd, task.subject?.head ?? run.baseCommit], {
    timeoutMs: 30_000,
  });
  task.included = await copyIncluded(run.cwd, cwd);
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
    await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
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
