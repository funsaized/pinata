#!/usr/bin/env node
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ROOT,
  ROLES,
  TERMINAL,
  LIMITS,
  need,
  text,
  strings,
  equal,
  digest,
  owns,
  checkedKeys,
  exists,
  readJson,
  atomic,
  privateDir,
  withLock,
  command,
  environment,
  git,
  line,
  snapshot,
  delta,
  fileState,
  applyFile,
  validateChecks,
  validateTask,
  validateModel,
  validateResult,
  shellQuote,
  sleep,
  rpcProbe,
  living,
  terminate,
} from "./core.mjs";
import { runChecks } from "./worker.mjs";

async function executable(name) {
  text(name, "executable");
  for (const file of path.isAbsolute(name)
    ? [name]
    : (process.env.PATH ?? "").split(path.delimiter).map((p) => path.join(p, name))) {
    try {
      await fs.access(file, fs.constants.X_OK);
      return await fs.realpath(file);
    } catch {
      /* Try the next PATH entry. */
    }
  }
  throw new Error(`Missing executable: ${name}; propose installation before proceeding`);
}
export function config(input = {}) {
  checkedKeys(
    input,
    ["pi", "herdr", "models", "fallbacks", "passEnv", "webExtension", "session", "limits"],
    "config",
  );
  const limits = { ...LIMITS, ...input.limits };
  checkedKeys(limits, Object.keys(LIMITS), "limits");
  for (const [key, value] of Object.entries(limits))
    need(
      Number.isSafeInteger(value) &&
        value > 0 &&
        value <=
          (key === "concurrency"
            ? 16
            : key === "repairs"
              ? 10
              : key === "maxTurns"
                ? 1000
                : 86_400_000),
      `Invalid limit ${key}`,
    );
  strings(input.passEnv ?? [], "passEnv").forEach((key) =>
    need(
      /^[A-Z][A-Z0-9_]*$/.test(key) &&
        !key.startsWith("PINATA_") &&
        !key.startsWith("HERDR_") &&
        !key.startsWith("PI_") &&
        !["NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"].includes(key),
      "Unsafe passEnv entry",
    ),
  );
  checkedKeys(input.models ?? {}, ["default", ...ROLES], "models");
  Object.values(input.models ?? {}).forEach(validateModel);
  checkedKeys(input.fallbacks ?? {}, ROLES, "fallbacks");
  for (const choices of Object.values(input.fallbacks ?? {})) {
    need(Array.isArray(choices) && choices.length <= 5, "Invalid fallback list");
    choices.forEach(validateModel);
  }
  if (input.session !== undefined)
    need(/^[a-zA-Z0-9_-]+$/.test(input.session), "Invalid Herdr session name");
  return {
    ...input,
    limits,
    passEnv: input.passEnv ?? [],
    models: input.models ?? {},
    fallbacks: input.fallbacks ?? {},
  };
}
function at(run, task, attempt = task.attempts.at(-1)) {
  return path.join(run.dir, "tasks", task.spec.id, String(attempt.number));
}
function current(task) {
  return task.attempts.at(-1);
}
function getTask(run, name) {
  const task = run.tasks.find((t) => t.spec.id === name);
  need(task, `Unknown task: ${name}`);
  return task;
}
function ancestors(run, task, seen = new Set()) {
  for (const name of task.spec.after) {
    if (!seen.has(name)) {
      seen.add(name);
      ancestors(run, getTask(run, name), seen);
    }
  }
  return seen;
}
function orderedTasks(run) {
  const ordered = [],
    seen = new Set();
  const visit = (task) => {
    if (seen.has(task.spec.id)) return;
    seen.add(task.spec.id);
    task.spec.after.forEach((name) => visit(getTask(run, name)));
    ordered.push(task);
  };
  run.tasks.forEach(visit);
  return ordered;
}
function validateGraph(run) {
  const ids = run.tasks.map((t) => t.spec.id);
  need(new Set(ids).size === ids.length, "Duplicate task ID");
  const visiting = new Set(),
    done = new Set();
  const visit = (task) => {
    need(!visiting.has(task.spec.id), "Cyclic task dependencies");
    if (done.has(task.spec.id)) return;
    visiting.add(task.spec.id);
    for (const dep of task.spec.after) visit(getTask(run, dep));
    visiting.delete(task.spec.id);
    done.add(task.spec.id);
  };
  run.tasks.forEach(visit);
  for (const task of run.tasks) {
    if (task.spec.role === "builder")
      need(run.allowWrites, "Job has no authorization for local writes");
    if (task.spec.role === "reviewer") {
      const target = getTask(run, task.spec.reviewOf);
      need(
        target.spec.role !== "reviewer" && task.spec.after.includes(target.spec.id),
        "Reviewer must directly depend on its review target",
      );
    }
    for (const other of run.tasks)
      if (task !== other && task.spec.role === "builder" && other.spec.role === "builder") {
        const overlaps = task.spec.ownership.some(
          (p) => owns(other.spec.ownership, p) || other.spec.ownership.some((q) => owns([p], q)),
        );
        need(
          !overlaps ||
            ancestors(run, task).has(other.spec.id) ||
            ancestors(run, other).has(task.spec.id),
          "Independent builders have overlapping ownership",
        );
      }
  }
}
async function loadRun(dir) {
  const actual = await fs.realpath(dir);
  const run = await readJson(path.join(actual, "manifest.json"));
  need(
    run.schemaVersion === 1 && run.dir === actual && /^[a-f0-9-]{36}$/.test(run.id),
    "Invalid pinata manifest",
  );
  need(
    run.baseCommit && Array.isArray(run.tasks) && Number.isSafeInteger(run.deadline),
    "Incomplete manifest",
  );
  config(run.config);
  for (const task of run.tasks) {
    validateTask(task.spec);
    need(Array.isArray(task.attempts) && task.attempts.length <= 32, "Invalid attempts");
  }
  validateGraph(run);
  const common = await fs.realpath(
    line(await git(run.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])),
  );
  need(run.dir === path.join(common, "pinata", run.id), "Run no longer belongs to this repository");
  for (const task of run.tasks)
    if (task.worktree) {
      const owner = task.spec.role === "reviewer" ? getTask(run, task.spec.reviewOf) : task;
      need(
        task.worktree === path.join(run.dir, "worktrees", owner.spec.id),
        "Unowned worktree path in manifest",
      );
      if (await exists(task.worktree))
        need(!(await fs.lstat(task.worktree)).isSymbolicLink(), "Worktree replaced by a symlink");
    }
  return run;
}
async function save(run) {
  await atomic(path.join(run.dir, "manifest.json"), run);
}
function herdrEnv(run) {
  const env = environment(run.config);
  delete env.HERDR_SOCKET_PATH;
  delete env.HERDR_SESSION;
  return { ...env, ...run.target };
}
async function herdr(run, args) {
  const r = await command(
    [run.config.herdr, ...(run.config.session ? ["--session", run.config.session] : []), ...args],
    { env: herdrEnv(run) },
  );
  if (r.code !== 0) {
    let code = "transport_error";
    try {
      code = JSON.parse(r.stderr).error.code;
    } catch {
      /* Stderr is not always protocol data. */
    }
    throw new Error(`Herdr ${args[0]} ${args[1]} failed: ${code}`);
  }
  const response = JSON.parse(r.stdout);
  need(
    typeof response.id === "string" && response.result && !response.error,
    "Invalid Herdr response envelope",
  );
  return response.result;
}
async function selectModel(cfg, role, cwd, override) {
  const inherited =
    process.env.PI_PROVIDER && process.env.PI_MODEL
      ? {
          provider: process.env.PI_PROVIDER,
          id: process.env.PI_MODEL,
          thinking: process.env.PI_REASONING_LEVEL ?? "medium",
        }
      : null;
  const preferred = override ?? cfg.models[role] ?? cfg.models.default ?? inherited;
  need(
    preferred,
    "No model configured; specify config.models.default or invoke through the coordinating Pi bash tool",
  );
  const env = environment(cfg);
  const data = await rpcProbe(cfg.pi, cwd, env, [{ id: "models", type: "get_available_models" }]);
  const available = data.get("models")?.models;
  need(Array.isArray(available), "Invalid Pi model metadata");
  const skipped = [];
  for (const model of [preferred, ...(cfg.fallbacks[role] ?? [])]) {
    validateModel(model);
    if (!available.some((m) => m.provider === model.provider && m.id === model.id)) {
      skipped.push(`${model.provider}/${model.id}: unavailable`);
      continue;
    }
    const auth = await command(
      [
        cfg.pi,
        "auth",
        "check",
        "--provider",
        model.provider,
        "--model",
        model.id,
        "--json",
        "--no-refresh",
      ],
      { cwd, env },
    );
    if (auth.code !== 0) {
      skipped.push(`${model.provider}/${model.id}: authentication not ready`);
      continue;
    }
    const state = await rpcProbe(
      cfg.pi,
      cwd,
      env,
      [{ id: "state", type: "get_state" }],
      ["--provider", model.provider, "--model", model.id, "--thinking", model.thinking],
    );
    const selected = state.get("state");
    if (
      selected?.model?.provider !== model.provider ||
      selected?.model?.id !== model.id ||
      selected?.thinkingLevel !== model.thinking
    ) {
      skipped.push(`${model.provider}/${model.id}: model/thinking selection changed`);
      continue;
    }
    return { model, skipped };
  }
  throw new Error(`No approved model ready: ${skipped.join("; ")}`);
}
export async function doctor(input = {}) {
  const cfg = config(input);
  cfg.pi = await executable(cfg.pi ?? "pi");
  cfg.herdr = await executable(cfg.herdr ?? "herdr");
  const versions = {};
  for (const [name, argv] of Object.entries({
    pi: [cfg.pi, "--version"],
    herdr: [cfg.herdr, "--version"],
    git: ["git", "--version"],
    node: [process.execPath, "--version"],
    npm: ["npm", "--version"],
    gh: ["gh", "--version"],
  })) {
    try {
      const r = await command(argv);
      versions[name] = r.code === 0 ? line(r.stdout).split("\n")[0] : "unavailable";
    } catch {
      versions[name] = "unavailable";
    }
  }
  need(versions.git !== "unavailable", "git is required");
  const minimum = (s, wanted) => {
    const m = s.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!m) return false;
    for (let i = 0; i < 3; i++) {
      if (+m[i + 1] > wanted[i]) return true;
      if (+m[i + 1] < wanted[i]) return false;
    }
    return true;
  };
  need(
    minimum(versions.pi, [1, 0, 2]) && minimum(versions.herdr, [0, 9, 1]),
    "pinata requires Pi >=1.0.2 and Herdr >=0.9.1; propose upgrades explicitly",
  );
  const target = cfg.session
    ? {}
    : Object.fromEntries(
        ["HERDR_SOCKET_PATH", "HERDR_SESSION"]
          .filter((k) => process.env[k])
          .map((k) => [k, process.env[k]]),
      );
  need(
    cfg.session || target.HERDR_SOCKET_PATH || target.HERDR_SESSION,
    "Choose config.session outside a Herdr pane; never implicitly use the focused server",
  );
  const run = { config: cfg, target };
  const status = await command(
    [cfg.herdr, ...(cfg.session ? ["--session", cfg.session] : []), "status"],
    { env: herdrEnv(run) },
  );
  need(
    status.code === 0 &&
      /status:\s+running/.test(status.stdout) &&
      /endpoint_compatible:\s+yes/.test(status.stdout),
    "Herdr server unavailable/incompatible; do not start, stop, or upgrade a shared server automatically",
  );
  const schema = await command([cfg.herdr, "api", "schema", "--json"]);
  need(
    schema.code === 0 && JSON.parse(schema.stdout).schemas?.success_response,
    "Unsupported Herdr schema",
  );
  await executable("ps");
  if (cfg.webExtension) {
    cfg.webExtension = await fs.realpath(cfg.webExtension);
    need(
      (await fs.stat(cfg.webExtension)).isFile(),
      "webExtension must be the installed pi-web-access entry file",
    );
  }
  return {
    config: cfg,
    target,
    versions,
    platform: process.platform,
    arch: process.arch,
    research: cfg.webExtension
      ? "entry configured; provider readiness is checked when used"
      : "requires an explicitly configured pi-web-access entry",
    optional: { vercel: "only needed for authorized Vercel deployments" },
  };
}
export async function resources(cwd = process.cwd(), input = {}) {
  const cfg = config(input),
    pi = await executable(cfg.pi ?? "pi");
  const data = await rpcProbe(
    pi,
    cwd,
    environment(cfg),
    [{ id: "commands", type: "get_commands" }],
    [],
    true,
  );
  const commands = data.get("commands")?.commands;
  need(Array.isArray(commands), "Invalid Pi resource metadata");
  const expected = Object.fromEntries([
    ...ROLES.map((role) => [role, path.join(ROOT, "prompts", `${role}.md`)]),
    ...["subagents", "engmgmt"].map((skill) => [
      `skill:${skill}`,
      path.join(ROOT, "skills", skill, "SKILL.md"),
    ]),
  ]);
  const mappings = Object.entries(expected).map(([name, file]) => ({
    name,
    expected: file,
    resolved: commands.filter((c) => c.name === name).map((c) => c.sourceInfo?.path),
  }));
  return {
    ok:
      !data.get("resourceWarnings") &&
      mappings.every((m) => m.resolved.length === 1 && m.resolved[0] === m.expected),
    mappings,
    resourceWarnings: data.get("resourceWarnings"),
    scope: "user resources; project resources are intentionally not trusted by this probe",
  };
}
export async function init(job) {
  checkedKeys(
    job,
    [
      "cwd",
      "approval",
      "allowWrites",
      "instructions",
      "config",
      "tasks",
      "integratedChecks",
      "noIntegratedChecksReason",
    ],
    "job",
  );
  text(job.approval, "user scope approval");
  need(typeof (job.allowWrites ?? false) === "boolean", "Invalid allowWrites");
  const cwd = await fs.realpath(text(job.cwd, "cwd"));
  const root = await fs.realpath(line(await git(cwd, ["rev-parse", "--show-toplevel"])));
  need(
    cwd === root,
    "Initialize from the Git root so ownership paths and evidence are unambiguous",
  );
  const baseCommit = line(await git(root, ["rev-parse", "--verify", "HEAD"]));
  const preflight = await doctor(job.config);
  strings(job.instructions ?? [], "instructions");
  if (!preflight.config.models.default && process.env.PI_PROVIDER && process.env.PI_MODEL)
    preflight.config.models.default = validateModel({
      provider: process.env.PI_PROVIDER,
      id: process.env.PI_MODEL,
      thinking: process.env.PI_REASONING_LEVEL ?? "medium",
    });
  validateChecks(job.integratedChecks ?? []);
  if (job.allowWrites && !job.integratedChecks?.length)
    text(job.noIntegratedChecksReason, "noIntegratedChecksReason");
  const common = await fs.realpath(
    line(await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])),
  );
  const runId = randomUUID();
  const dir = path.join(common, "pinata", runId);
  await privateDir(dir);
  const run = {
    schemaVersion: 1,
    id: runId,
    dir,
    cwd: root,
    baseCommit,
    createdAt: Date.now(),
    deadline: Date.now() + preflight.config.limits.jobMs,
    approval: job.approval,
    allowWrites: job.allowWrites ?? false,
    instructions: job.instructions ?? [],
    config: preflight.config,
    target: preflight.target,
    versions: preflight.versions,
    initial: await snapshot(root),
    integratedChecks: job.integratedChecks ?? [],
    noIntegratedChecksReason: job.noIntegratedChecksReason ?? null,
    cancelled: false,
    notes: [],
    tasks: (job.tasks ?? []).map((t) => ({
      spec: validateTask(t),
      status: "queued",
      attempts: [],
      repairs: 0,
    })),
  };
  validateGraph(run);
  await save(run);
  return { run: dir, id: runId, versions: run.versions };
}
async function outcome(run, task) {
  const attempt = current(task);
  need(attempt, `No attempt for ${task.spec.id}`);
  const spec = await readJson(path.join(at(run, task), "task.json"));
  const { taskDigest, ...payload } = spec;
  need(
    taskDigest === digest(payload) &&
      spec.runId === run.id &&
      spec.task.id === task.spec.id &&
      spec.cwd === task.worktree,
    "Task specification changed or escaped its run",
  );
  const o = await readJson(path.join(at(run, task), "outcome.json"));
  need(
    o.schemaVersion === 1 && o.taskDigest === spec.taskDigest && TERMINAL.includes(o.status),
    "Invalid task outcome",
  );
  if (o.status === "succeeded" || o.status === "rejected") {
    validateResult(o.result, spec);
    need(
      o.result.status === "succeeded" &&
        o.process?.code === 0 &&
        !o.process.reason &&
        o.process.terminated &&
        o.settled &&
        o.finalStopReason === "stop",
      "Invalid successful process evidence",
    );
    need(
      Array.isArray(o.checks) &&
        o.checks.length === spec.task.checks.length &&
        o.checks.every(
          (c, i) =>
            c.id === spec.task.checks[i].id &&
            equal(c.argv, spec.task.checks[i].argv) &&
            c.passed &&
            c.code === 0 &&
            !c.reason &&
            c.terminated &&
            c.cwd === spec.cwd,
        ),
      "Required verification evidence missing",
    );
    need(
      Array.isArray(o.changes) && o.changes.every((c) => owns(task.spec.ownership, c.path)),
      "Outcome ownership mismatch",
    );
    need(
      o.fingerprint === digest({ snapshot: o.snapshot, result: o.result, checks: o.checks }) &&
        equal(o.snapshot, await snapshot(spec.cwd)),
      "Evidence is stale: working tree changed",
    );
    need(
      equal(o.changes, await delta(spec.cwd, spec.inputSnapshot, o.snapshot)),
      "Change artifact does not match the working tree",
    );
    for (const c of o.checks) {
      const log = path.join(at(run, task), `check-${c.id}.stdout.log`);
      need((await exists(log)) && (await fs.lstat(log)).isFile(), "Missing check log");
    }
    if (task.spec.role === "reviewer")
      need(
        (o.status === "succeeded") === (o.result.review.verdict === "approve"),
        "Review verdict/status mismatch",
      );
  }
  return o;
}
async function pane(run, attempt) {
  need(attempt.resource, "No captured pane; inspect creation ambiguity first");
  const result = await herdr(run, ["pane", "get", attempt.resource.pane_id]);
  need(
    result.pane?.terminal_id === attempt.resource.terminal_id &&
      result.pane?.workspace_id === attempt.resource.workspace_id,
    "Pane ownership changed; refusing to control it",
  );
  return result.pane;
}
async function availableShell(run, attempt) {
  await pane(run, attempt);
  const r = (await herdr(run, ["pane", "process-info", "--pane", attempt.resource.pane_id]))
    .process_info;
  need(
    r && r.shell_pid && Array.isArray(r.foreground_processes),
    "Herdr cannot verify shell availability",
  );
  if (attempt.shellPid) need(r.shell_pid === attempt.shellPid, "Shell identity changed");
  const shell = r.foreground_processes.find((p) => p.pid === r.shell_pid);
  return r.foreground_process_group_id === r.shell_pid &&
    r.foreground_processes.every((p) => p.pid === r.shell_pid) &&
    shell &&
    ["bash", "zsh", "sh", "dash"].includes(path.basename(shell.name).replace(/^-/, ""))
    ? r.shell_pid
    : null;
}
function launchCommand(dir) {
  return [process.execPath, path.join(ROOT, "lib", "worker.mjs"), dir].map(shellQuote).join(" ");
}
async function prepare(run, task) {
  for (const name of task.spec.after)
    need(
      (await outcome(run, getTask(run, name))).status === "succeeded",
      `Dependency evidence is not valid: ${name}`,
    );
  delete task.error;
  const selected = await selectModel(run.config, task.spec.role, run.cwd, task.spec.model);
  if (task.spec.role === "research")
    need(
      run.config.webExtension,
      "research requires config.webExtension pointing to the installed pi-web-access entry",
    );
  const attempt = {
    number: task.attempts.length + 1,
    startedAt: Date.now(),
    submissionRetries: 0,
    label: `pinata-${run.id}-${task.spec.id}-${task.attempts.length + 1}`,
  };
  task.attempts.push(attempt);
  task.status = "preparing";
  await save(run);
  const dir = at(run, task);
  await privateDir(dir);
  let cwd = task.worktree;
  if (task.spec.role === "reviewer") cwd = getTask(run, task.spec.reviewOf).worktree;
  if (!cwd) {
    cwd = path.join(run.dir, "worktrees", task.spec.id);
    task.worktree = cwd;
    await save(run);
    await git(run.cwd, ["worktree", "add", "--detach", cwd, run.baseCommit], { timeoutMs: 30_000 });
    for (const predecessor of orderedTasks(run).filter(
      (t) => ancestors(run, task).has(t.spec.id) && t.spec.role === "builder",
    )) {
      const prior = await outcome(run, predecessor);
      need(prior.status === "succeeded", "Dependency did not succeed");
      for (const change of prior.changes) {
        need(
          equal(await fileState(cwd, change.path), change.before),
          "Dependency changes conflict",
        );
        await applyFile(cwd, change, path.join(at(run, predecessor), "files"));
      }
    }
  }
  task.worktree = cwd;
  let reviewTarget = null;
  if (task.spec.role === "reviewer") {
    const target = getTask(run, task.spec.reviewOf);
    const evidence = await outcome(run, target);
    need(evidence.status === "succeeded", "Review target not verified");
    reviewTarget = {
      taskId: target.spec.id,
      fingerprint: evidence.fingerprint,
      taskSpec: path.join(at(run, target), "task.json"),
      result: path.join(at(run, target), "outcome.json"),
      diff: path.join(dir, "review.diff"),
    };
    await fs.writeFile(
      reviewTarget.diff,
      await git(cwd, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--binary",
        "HEAD",
        "--",
      ]),
      { mode: 0o600 },
    );
  }
  const baseline = await snapshot(cwd);
  if (task.spec.role !== "builder" || !task.inputSnapshot) task.inputSnapshot = baseline;
  const payload = {
    schemaVersion: 1,
    runId: run.id,
    sessionId: randomUUID(),
    attemptId: `${task.spec.id}-${attempt.number}`,
    attemptDir: dir,
    task: { ...task.spec, instructions: [...run.instructions, ...task.spec.instructions] },
    cwd,
    model: selected.model,
    modelFallbacksUsed: selected.skipped,
    pi: run.config.pi,
    webExtension: task.spec.role === "research" ? run.config.webExtension : null,
    config: { passEnv: run.config.passEnv },
    baseline,
    inputSnapshot: task.inputSnapshot,
    reviewTarget,
    feedback: task.feedback ?? null,
    resultRepair: task.resultRepair ?? false,
    dependencies: task.spec.after.map((name) => ({
      taskId: name,
      outcome: path.join(at(run, getTask(run, name)), "outcome.json"),
    })),
    deadline: Math.min(run.deadline, attempt.startedAt + run.config.limits.taskMs),
    maxTurns: run.config.limits.maxTurns,
  };
  await atomic(path.join(dir, "task.json"), { ...payload, taskDigest: digest(payload) });
  // Herdr's long-lived server does not inherit the coordinating Pi's environment.
  // A private, single-use capsule avoids putting approved credential values in pane commands/argv.
  await atomic(path.join(dir, "environment.json"), environment(run.config));
  task.status = "launching";
  await save(run);
  try {
    const created = await herdr(run, [
      "workspace",
      "create",
      "--cwd",
      cwd,
      "--label",
      attempt.label,
      "--no-focus",
    ]);
    need(
      created.type === "workspace_created" &&
        created.workspace?.workspace_id &&
        created.tab?.tab_id &&
        created.root_pane?.pane_id &&
        created.root_pane?.terminal_id,
      "Invalid workspace creation response",
    );
    attempt.resource = created.root_pane;
    await save(run);
    const until = Date.now() + run.config.limits.startupMs;
    while (!(attempt.shellPid = await availableShell(run, attempt))) {
      need(Date.now() < until, "Shell readiness deadline exceeded");
      await sleep(250);
    }
    await save(run);
    await herdr(run, ["pane", "run", attempt.resource.pane_id, launchCommand(dir)]);
    attempt.accepted = true;
  } catch (e) {
    attempt.submissionError = e.message;
  }
  await save(run);
}
async function reconcileCreation(run, task) {
  const attempt = current(task);
  if (attempt.resource) return;
  const listing = await herdr(run, ["workspace", "list"]);
  need(Array.isArray(listing.workspaces), "Unexpected workspace list schema");
  const matches = listing.workspaces.filter((w) => w.label === attempt.label);
  need(matches.length === 1, "Creation cannot be uniquely reconciled; no resource will be guessed");
  const listingPanes = await herdr(run, ["pane", "list", "--workspace", matches[0].workspace_id]);
  need(
    listingPanes.panes?.length === 1 && listingPanes.panes[0].cwd === task.worktree,
    "Ambiguous created workspace topology/cwd",
  );
  attempt.resource = listingPanes.panes[0];
  attempt.shellPid = await availableShell(run, attempt);
}
async function collect(run) {
  for (const task of run.tasks.filter((t) =>
    ["launching", "running", "preparing", "uncertain"].includes(t.status),
  )) {
    const dir = at(run, task),
      attempt = current(task);
    if (await exists(path.join(dir, "claim.json"))) {
      task.status = "running";
      if (await exists(path.join(dir, "process.json"))) {
        const p = await readJson(path.join(dir, "process.json"));
        if (p.runner && !(await living([p.runner])).length) {
          task.status = "uncertain";
          attempt.error =
            "Supervisor disappeared without a valid outcome; inspect/cancel before repair";
        }
      }
    } else if (
      Date.now() - (attempt.lastSubmissionAt ?? attempt.startedAt) >=
      run.config.limits.startupMs
    ) {
      task.status = "uncertain";
      attempt.error = "No worker launch claim; reconcile before retrying";
    }
    // Read the outcome after liveness: a supervisor can publish and exit between
    // an earlier artifact check and ps, which is completion rather than disappearance.
    if (await exists(path.join(dir, "outcome.json"))) {
      try {
        const o = await outcome(run, task);
        task.status = o.status;
        attempt.error = o.error;
        attempt.fingerprint = o.fingerprint;
      } catch (e) {
        task.status = "failed";
        attempt.error = e.message;
      }
    }
    if (
      ["running", "launching"].includes(task.status) &&
      Date.now() >= Math.min(run.deadline, attempt.startedAt + run.config.limits.taskMs)
    )
      await cancelTask(run, task);
  }
}
async function cancelTask(run, task) {
  if (!task.attempts.length) {
    task.status = "cancelled";
    return;
  }
  const dir = at(run, task);
  await atomic(path.join(dir, "cancel.json"), { requestedAt: Date.now() });
  let verified = false;
  for (let i = 0; i < 25; i++) {
    if (await exists(path.join(dir, "process.json"))) {
      const p = await readJson(path.join(dir, "process.json"));
      const identities = [...(p.children ?? []), ...(p.runner ? [p.runner] : [])];
      if (!(await living(identities)).length) {
        verified = true;
        break;
      }
    } else if (!(await exists(path.join(dir, "claim.json")))) {
      try {
        verified = Boolean(await availableShell(run, current(task)));
      } catch {
        /* Ownership may be uncertain. */
      }
      if (verified) break;
    }
    await sleep(200);
  }
  if (!verified && (await exists(path.join(dir, "process.json")))) {
    const p = await readJson(path.join(dir, "process.json"));
    verified = await terminate([...(p.children ?? []), ...(p.runner ? [p.runner] : [])]);
  }
  if (verified) await fs.rm(path.join(dir, "environment.json"), { force: true });
  task.status = verified ? "cancelled" : "uncertain";
  current(task).error = verified
    ? "Cancellation termination verified; outputs retained"
    : "Cannot verify cancellation; resources retained";
}
export function summary(run) {
  return {
    run: run.dir,
    cancelled: run.cancelled,
    deadline: run.deadline,
    tasks: run.tasks.map((t) => ({
      id: t.spec.id,
      role: t.spec.role,
      status: t.status,
      attempt: current(t)?.number ?? 0,
      error: current(t)?.error ?? t.error,
      submissionError: current(t)?.submissionError,
      result: t.attempts.length ? path.join(at(run, t), "outcome.json") : null,
    })),
    integration: run.integration ?? null,
  };
}
async function mutate(dir, fn) {
  return withLock(await fs.realpath(dir), async () => {
    const run = await loadRun(dir);
    const result = await fn(run);
    await save(run);
    return result ?? summary(run);
  });
}
export async function tick(dir) {
  return mutate(dir, async (run) => {
    await collect(run);
    if (run.cancelled || Date.now() >= run.deadline) {
      for (const t of run.tasks.filter((t) => !TERMINAL.includes(t.status)))
        await cancelTask(run, t);
      return;
    }
    let capacity =
      run.config.limits.concurrency -
      run.tasks.filter((t) => ["running", "launching", "preparing", "uncertain"].includes(t.status))
        .length;
    for (const task of run.tasks.filter((t) => t.status === "queued")) {
      const deps = task.spec.after.map((name) => getTask(run, name));
      if (deps.some((t) => TERMINAL.includes(t.status) && t.status !== "succeeded")) {
        task.status = "blocked";
        continue;
      }
      if (capacity <= 0 || deps.some((t) => t.status !== "succeeded")) continue;
      // A reviewer may read a target tree, but no task writes that tree during review.
      try {
        await prepare(run, task);
        capacity--;
      } catch (e) {
        task.status = "blocked";
        task.error = e.message;
        if (current(task)) current(task).error = e.message;
      }
    }
  });
}
export async function wait(dir, waitMs = 30_000) {
  need(Number.isInteger(waitMs) && waitMs > 0 && waitMs <= 300_000, "waitMs must be 1..300000");
  const until = Date.now() + waitMs;
  let status;
  do {
    status = await tick(dir);
    if (status.tasks.every((t) => TERMINAL.includes(t.status))) return status;
    await sleep(250);
  } while (Date.now() < until);
  return { ...status, waiting: true };
}
export async function add(dir, spec) {
  return mutate(dir, (run) => {
    need(!run.cancelled && Date.now() < run.deadline, "Run no longer accepts tasks");
    for (const item of Array.isArray(spec) ? spec : [spec])
      run.tasks.push({ spec: validateTask(item), status: "queued", attempts: [], repairs: 0 });
    validateGraph(run);
  });
}
export async function barrier(dir, names) {
  const run = await loadRun(dir);
  need(names.length > 0, "Explicit barrier task IDs required");
  for (const name of names) {
    const task = getTask(run, name);
    need(
      task.status === "succeeded" && (await outcome(run, task)).status === "succeeded",
      `Barrier blocked by ${name} (${task.status})`,
    );
  }
  return { ready: true, tasks: names };
}
export async function repair(dir, name, feedback) {
  return mutate(dir, async (run) => {
    need(!run.cancelled && Date.now() < run.deadline, "Run stopped");
    const task = getTask(run, name);
    need(
      ["failed", "blocked", "succeeded", "rejected"].includes(task.status),
      "Inspect/cancel uncertain or active work before repairing",
    );
    need(task.repairs < run.config.limits.repairs, "Repair budget exhausted");
    text(feedback, "repair feedback");
    const dependents = run.tasks.filter((t) => ancestors(run, t).has(name));
    need(
      dependents.every((t) =>
        ["queued", "blocked", "rejected", "succeeded", "failed"].includes(t.status),
      ),
      "Dependent work is active; cancel it first",
    );
    need(
      dependents.every((t) => t.spec.role === "reviewer" || t.attempts.length === 0),
      "Completed downstream work requires a new plan/run; do not silently replay it",
    );
    for (const t of [task, ...dependents]) {
      if (t.attempts.length && (await exists(path.join(at(run, t), "process.json")))) {
        const p = await readJson(path.join(at(run, t), "process.json"));
        need(
          !(await living([...(p.children ?? []), ...(p.runner ? [p.runner] : [])])).length,
          "Previous processes are still alive",
        );
      }
    }
    const lastOutcome =
      task.attempts.length && (await exists(path.join(at(run, task), "outcome.json")))
        ? await readJson(path.join(at(run, task), "outcome.json"))
        : null;
    task.resultRepair = lastOutcome?.failureStage === "result";
    if (task.resultRepair) {
      need((task.resultRepairs ?? 0) < 1, "Result-format repair budget exhausted");
      task.resultRepairs = (task.resultRepairs ?? 0) + 1;
    }
    task.repairs++;
    task.feedback = task.resultRepair
      ? `Result-only repair: do not repeat edits or other work; reconstruct the envelope from retained evidence. ${feedback}`
      : feedback;
    task.status = "queued";
    for (const t of dependents) {
      t.status = "queued";
      t.feedback = "Re-review the repaired target independently; prior approval is invalid.";
    }
    run.integration = run.integration ? { ...run.integration, status: "stale" } : null;
  });
}
export async function retryLaunch(dir, name) {
  return mutate(dir, async (run) => {
    const task = getTask(run, name),
      attempt = current(task);
    need(
      !run.cancelled && Date.now() < run.deadline && task.status === "uncertain",
      "Only an uncertain live run can retry a submission",
    );
    need(
      attempt.submissionRetries < 1 && !(await exists(path.join(at(run, task), "claim.json"))),
      "Submission retry disallowed: budget or existing claim",
    );
    await reconcileCreation(run, task);
    need(await availableShell(run, attempt), "Target is busy; do not submit");
    // The same attempt claim makes a delayed original submission harmless; never create another attempt here.
    attempt.submissionRetries++;
    attempt.lastSubmissionAt = Date.now();
    task.status = "launching";
    await save(run);
    try {
      await herdr(run, ["pane", "run", attempt.resource.pane_id, launchCommand(at(run, task))]);
      attempt.accepted = true;
    } catch (e) {
      attempt.submissionError = e.message;
    }
  });
}
export async function cancel(dir) {
  return mutate(dir, async (run) => {
    run.cancelled = true;
    await save(run);
    for (const task of run.tasks)
      if (!["succeeded", "rejected", "failed", "cancelled"].includes(task.status))
        await cancelTask(run, task);
  });
}

export async function integrate(dir) {
  return mutate(dir, async (run) => {
    need(
      !run.cancelled && Date.now() < run.deadline && run.allowWrites,
      "Integration not authorized or run expired",
    );
    need(
      run.tasks.length > 0 && run.tasks.every((t) => t.status === "succeeded"),
      "Every required task must succeed before integration",
    );
    for (const task of run.tasks)
      need(
        (await outcome(run, task)).status === "succeeded",
        "A required result is no longer valid",
      );
    need(
      line(await git(run.cwd, ["rev-parse", "HEAD"])) === run.baseCommit,
      "Target HEAD moved; replan instead of merging blindly",
    );
    const builders = run.tasks.filter((t) => t.spec.role === "builder");
    need(builders.length > 0, "No builder changes to integrate");
    const changes = new Map();
    const fingerprints = [];
    const ordered = orderedTasks(run).filter((t) => t.spec.role === "builder");
    for (const task of ordered) {
      const o = await outcome(run, task);
      fingerprints.push([task.spec.id, o.fingerprint]);
      const reviews = run.tasks.filter(
        (t) => t.spec.role === "reviewer" && t.spec.reviewOf === task.spec.id,
      );
      need(reviews.length > 0, `Independent review required for ${task.spec.id}`);
      for (const review of reviews) {
        const r = await outcome(run, review);
        need(
          r.status === "succeeded" && r.result.review.fingerprint === o.fingerprint,
          "Review is rejected or stale",
        );
      }
      for (const change of o.changes) {
        const prev = changes.get(change.path);
        if (prev) need(equal(prev.after, change.before), "Conflicting integration changes");
        changes.set(change.path, {
          ...change,
          before: prev ? prev.before : change.before,
          blobs: path.join(at(run, task), "files"),
        });
      }
    }
    const evidenceDigest = digest(fingerprints);
    const folder = path.join(run.dir, "integration");
    await privateDir(folder);
    const journalPath = path.join(folder, "journal.json");
    let journal = (await exists(journalPath)) ? await readJson(journalPath) : null;
    if (!journal || journal.evidenceDigest !== evidenceDigest || journal.status === "rolled_back") {
      const entries = [];
      for (const change of changes.values()) {
        const prior = journal?.entries.find((c) => c.path === change.path);
        const before = prior && journal.status !== "rolled_back" ? prior.after : change.before;
        need(
          equal(await fileState(run.cwd, change.path, path.join(folder, "before")), before),
          `Integration conflicts with existing changes: ${JSON.stringify(change.path)}`,
        );
        entries.push({ ...change, before });
      }
      journal = { schemaVersion: 1, evidenceDigest, entries, status: "applying" };
      await atomic(journalPath, journal);
    }
    for (const entry of journal.entries) {
      const state = await fileState(run.cwd, entry.path);
      need(
        equal(state, entry.before) || equal(state, entry.after),
        `Interrupted integration conflicts with user changes: ${JSON.stringify(entry.path)}`,
      );
    }
    for (const entry of journal.entries)
      if (!equal(await fileState(run.cwd, entry.path), entry.after))
        await applyFile(run.cwd, entry, entry.blobs);
    journal.status = "verifying";
    await atomic(journalPath, journal);
    const integratedSnapshot = await snapshot(run.cwd);
    const checks = await runChecks(run.integratedChecks, {
      cwd: run.cwd,
      env: environment(run.config),
      dir: folder,
      deadline: Math.min(run.deadline, Date.now() + run.config.limits.taskMs),
    });
    need(
      equal(integratedSnapshot, await snapshot(run.cwd)),
      "Integrated checks modified source files; inspect and re-review",
    );
    journal.status =
      checks.length === run.integratedChecks.length && checks.every((c) => c.passed)
        ? "verified"
        : "verification_failed";
    journal.checks = checks;
    journal.snapshot = integratedSnapshot;
    journal.noChecksReason = run.noIntegratedChecksReason;
    await atomic(journalPath, journal);
    run.integration = {
      status: journal.status,
      journal: journalPath,
      evidenceDigest,
      checkedAt: Date.now(),
    };
  });
}
export async function rollback(dir) {
  return mutate(dir, async (run) => {
    const folder = path.join(run.dir, "integration"),
      file = path.join(folder, "journal.json");
    const journal = await readJson(file);
    need(journal.status !== "rolled_back", "Already rolled back");
    for (const c of journal.entries)
      need(
        equal(await fileState(run.cwd, c.path), c.after),
        "Rollback conflicts with later changes; nothing overwritten",
      );
    for (const c of [...journal.entries].reverse())
      await applyFile(run.cwd, { path: c.path, after: c.before }, path.join(folder, "before"));
    journal.status = "rolled_back";
    await atomic(file, journal);
    run.integration = { status: "rolled_back", journal: file };
  });
}
export async function cleanup(dir, confirm = false) {
  return mutate(dir, async (run) => {
    need(
      run.tasks.every((t) => TERMINAL.includes(t.status) && t.status !== "uncertain"),
      "Active/uncertain work cannot be cleaned up",
    );
    const report = [],
      retainedTrees = new Set();
    for (const task of run.tasks)
      for (const attempt of task.attempts) {
        if (attempt.resource && !attempt.closed) {
          try {
            need(await availableShell(run, attempt), "Pane is not at its original available shell");
            if (confirm) {
              await herdr(run, ["pane", "close", attempt.resource.pane_id]);
              attempt.closed = true;
            }
            report.push({
              pane: attempt.resource.pane_id,
              action: confirm ? "closed" : "would close",
            });
          } catch (e) {
            retainedTrees.add(task.worktree);
            report.push({ pane: attempt.resource.pane_id, action: "retained", reason: e.message });
          }
        }
      }
    for (const worktree of new Set(run.tasks.map((t) => t.worktree).filter(Boolean))) {
      if (!(await exists(worktree))) continue;
      if (retainedTrees.has(worktree)) {
        report.push({ worktree, action: "retained: pane ownership or liveness uncertain" });
        continue;
      }
      const dirty = await git(worktree, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignored=matching",
      ]);
      if (dirty) report.push({ worktree, action: "retained: dirty or ignored files" });
      else {
        if (confirm) await git(run.cwd, ["worktree", "remove", worktree]);
        report.push({
          worktree,
          action: confirm ? "removed clean owned worktree" : "would remove clean owned worktree",
        });
      }
    }
    return { run: run.dir, report, artifacts: "retained" };
  });
}
export async function unlock(dir) {
  const run = await loadRun(dir);
  const file = path.join(run.dir, "coordinator.lock"),
    lock = await readJson(file);
  need(Number.isInteger(lock.pid) && lock.pid > 1, "Cannot identify lock owner; inspect manually");
  try {
    process.kill(lock.pid, 0);
    throw new Error("Lock owner may still be alive; refusing to remove lock");
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
  await fs.unlink(file);
  return { unlocked: run.dir };
}
export const HELP = `pinata — Pi subagents through bash and Herdr (package: pi-pinata)\n\nnode <package>/lib/pinata.mjs <command> [arguments]\n  doctor [config.json]              Check local prerequisites; no installations\n  resources [cwd]                   Verify this installed package's exact global resources\n  init <job.json>                    Record approved scope; print private run path\n  add <run> <task.json>              Append a scoped task and dependencies\n  tick <run>                        Collect results and fill up to 3 worker slots\n  wait <run> [milliseconds]          Tick until settled or observation deadline\n  status <run>                      Inspect saved state (use resume to reconcile)\n  resume <run>                      Reconcile actual state, then schedule ready work\n  barrier <run> <task-id>...         Validate EVERY required predecessor\n  repair <run> <task-id> <text-file> Reuse work, invalidate reviews; bounded budget\n  retry-launch <run> <task-id>       Reconcile ambiguous submission; one same-attempt retry\n  cancel <run>                      Stop only owned work; verify termination\n  integrate <run>                   Require all results/reviews; apply and verify\n  rollback <run> --confirm          Restore latest integration only if unchanged\n  cleanup <run> [--confirm]          Preview/close owned idle panes; keep dirty worktrees\n  note <run> <note.json>            Record progress/authorization/release evidence\n  unlock <run>                      Recover a dead coordinator's lock; never steal\n\nNo global config changes, commits, pushes, publication, or deployment are performed\nby this helper. Scope/approval records are not an OS security boundary.\n`;
async function main(args) {
  const [cmd, first, ...rest] = args;
  if (!cmd || ["help", "--help", "-h"].includes(cmd)) {
    console.log(HELP);
    return;
  }
  need(!process.env.PINATA_WORKER, "Recursive delegation is disabled in pinata workers");
  let result;
  switch (cmd) {
    case "doctor":
      result = await doctor(first ? await readJson(first) : {});
      break;
    case "resources":
      result = await resources(first);
      if (!result.ok) process.exitCode = 1;
      break;
    case "init":
      result = await init(await readJson(first));
      break;
    case "add":
      result = await add(first, await readJson(rest[0]));
      break;
    case "tick":
    case "resume":
      result = await tick(first);
      break;
    case "wait":
      result = await wait(first, rest[0] ? Number(rest[0]) : 30_000);
      break;
    case "status":
      result = summary(await loadRun(first));
      break;
    case "barrier":
      result = await barrier(first, rest);
      break;
    case "repair":
      result = await repair(first, rest[0], await fs.readFile(rest[1], "utf8"));
      break;
    case "retry-launch":
      result = await retryLaunch(first, rest[0]);
      break;
    case "cancel":
      result = await cancel(first);
      break;
    case "integrate":
      result = await integrate(first);
      break;
    case "rollback":
      need(rest[0] === "--confirm", "Rollback requires explicit --confirm and user authorization");
      result = await rollback(first);
      break;
    case "cleanup":
      need(
        rest.length === 0 || (rest.length === 1 && rest[0] === "--confirm"),
        "Unknown cleanup flag",
      );
      result = await cleanup(first, rest[0] === "--confirm");
      break;
    case "unlock":
      result = await unlock(first);
      break;
    case "note":
      result = await mutate(first, async (run) => {
        const note = await readJson(rest[0]);
        run.notes.push({ at: Date.now(), note });
      });
      break;
    default:
      throw new Error(`Unknown pinata command: ${cmd}`);
  }
  console.log(JSON.stringify(result, null, 2));
  if (cmd === "integrate" && result.integration?.status !== "verified") process.exitCode = 1;
  if (cmd === "wait" && !result.waiting && result.tasks.some((t) => t.status !== "succeeded"))
    process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((e) => {
    console.error(JSON.stringify({ error: e.message }));
    process.exitCode = 1;
  });
