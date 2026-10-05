import path from "node:path";
import { ROOT, need, command, environment, shellQuote, sleep } from "./core.mjs";
import { current } from "./run.mjs";

export function herdrEnv(run) {
  const env = environment(run.config);
  delete env.HERDR_SOCKET_PATH;
  delete env.HERDR_SESSION;
  return { ...env, ...run.target };
}
export async function herdr(run, args) {
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
    throw Object.assign(new Error(`Herdr ${args[0]} ${args[1]} failed: ${code}`), { code });
  }
  need(r.stdout.trim(), `Herdr ${args[0]} ${args[1]} returned no response`);
  const response = JSON.parse(r.stdout);
  need(
    typeof response.id === "string" && response.result && !response.error,
    "Invalid Herdr response envelope",
  );
  return response.result;
}
export async function pane(run, attempt) {
  need(attempt.resource, "No captured pane; inspect creation ambiguity first");
  const result = await herdr(run, ["pane", "get", attempt.resource.pane_id]);
  need(
    result.pane?.terminal_id === attempt.resource.terminal_id &&
      result.pane?.workspace_id === attempt.resource.workspace_id,
    "Pane ownership changed; refusing to control it",
  );
  return result.pane;
}
export async function availableShell(run, attempt) {
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
export function launchCommand(dir) {
  return [process.execPath, path.join(ROOT, "lib", "worker.mjs"), dir].map(shellQuote).join(" ");
}
// Creates the attempt's unfocused workspace and waits for its shell to be idle.
export async function createWorkspace(run, attempt, cwd, persist) {
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
  await persist();
  const until = Date.now() + run.config.limits.startupMs;
  while (!(attempt.shellPid = await availableShell(run, attempt))) {
    need(Date.now() < until, "Shell readiness deadline exceeded");
    await sleep(250);
  }
  await persist();
}
export async function submit(run, attempt, dir) {
  await herdr(run, ["pane", "run", attempt.resource.pane_id, launchCommand(dir)]);
}
export async function closePane(run, attempt) {
  await herdr(run, ["pane", "close", attempt.resource.pane_id]);
}
export async function reconcileCreation(run, task) {
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
