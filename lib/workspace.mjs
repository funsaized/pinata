import path from "node:path";
import { need, equal, git, fileState, applyFile } from "./core.mjs";
import { executable } from "./config.mjs";
import { at, getTask, ancestors, orderedTasks, save } from "./run.mjs";
import { outcome } from "./evidence.mjs";

// A reviewer inspects its target's tree; every other task owns one worktree for all attempts.
export async function ensureWorktree(run, task) {
  if (task.spec.role === "reviewer") return getTask(run, task.spec.reviewOf).worktree;
  if (task.worktree) return task.worktree;
  const cwd = path.join(run.dir, "worktrees", task.spec.id);
  task.worktree = cwd;
  await save(run);
  await git(run.cwd, ["worktree", "add", "--detach", cwd, run.baseCommit], { timeoutMs: 30_000 });
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
  return cwd;
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
