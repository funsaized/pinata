// The Herdr CLI, as pinata uses it (ported from 0.7.0's lib/herdr.mjs): workspaces created
// without focus, ownership checked before any control, readiness and shell kind from
// `pane process-info` only (no /proc or ps), and commands quoted for the pane's shell.
import { execFile } from "node:child_process";

export class HerdrError extends Error {
  override name = "HerdrError";
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

// Inside a Herdr-managed pane (Herdr injects these into its panes).
export function insideHerdr(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HERDR_ENV === "1" && !!env.HERDR_SOCKET_PATH;
}

export interface HerdrOptions {
  // The herdr executable (default `herdr` on PATH).
  bin?: string;
  session?: string;
}

// Runs one Herdr command and returns its JSON result.
export function herdr(args: readonly string[], options: HerdrOptions = {}): Promise<any> {
  const argv = [...(options.session ? ["--session", options.session] : []), ...args];
  return new Promise((resolve, reject) =>
    execFile(
      options.bin ?? "herdr",
      argv,
      { timeout: 30_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          let code = "transport_error";
          try {
            code = JSON.parse(String(stderr)).error.code ?? code;
          } catch {
            // Stderr is not always protocol data.
          }
          return reject(
            new HerdrError(`herdr ${args.slice(0, 2).join(" ")} failed: ${code}`, code),
          );
        }
        // Some commands (pane run) succeed silently.
        if (!String(stdout).trim()) return resolve({});
        try {
          const response = JSON.parse(String(stdout));
          if (!response || typeof response.id !== "string" || response.error || !response.result)
            throw new Error("envelope");
          resolve(response.result);
        } catch {
          reject(
            new HerdrError(`herdr ${args.slice(0, 2).join(" ")}: invalid response`, "invalid"),
          );
        }
      },
    ),
  );
}

// A pane pinata created, identified so it is never mistaken for another one.
export interface PaneResource {
  workspace_id: string;
  pane_id: string;
  terminal_id: string;
}

export async function createWorkspace(
  options: { cwd: string; label: string; env?: Record<string, string> } & HerdrOptions,
): Promise<PaneResource> {
  const args = [
    "workspace",
    "create",
    "--cwd",
    options.cwd,
    "--label",
    options.label,
    "--no-focus",
  ];
  for (const [key, value] of Object.entries(options.env ?? {}))
    args.push("--env", `${key}=${value}`);
  const created = await herdr(args, options);
  const pane = created?.root_pane;
  if (
    created?.type !== "workspace_created" ||
    !created.workspace?.workspace_id ||
    !pane?.pane_id ||
    !pane?.terminal_id
  )
    throw new HerdrError("Invalid workspace creation response", "invalid");
  return { workspace_id: pane.workspace_id, pane_id: pane.pane_id, terminal_id: pane.terminal_id };
}

// Whether the pane still is the one pinata created (same terminal in the same workspace).
export async function owned(resource: PaneResource, options: HerdrOptions = {}): Promise<boolean> {
  try {
    const result = await herdr(["pane", "get", resource.pane_id], options);
    return (
      result?.pane?.terminal_id === resource.terminal_id &&
      result?.pane?.workspace_id === resource.workspace_id
    );
  } catch (error) {
    if (error instanceof HerdrError) return false;
    throw error;
  }
}

export type ShellKind = "posix" | "fish" | "powershell" | "cmd";

export function shellKind(name: string): ShellKind | null {
  // Windows paths name the shell too, whatever OS reads them.
  const shell = (name.split(/[\\/]/).at(-1) ?? name)
    .replace(/^-/, "")
    .replace(/\.exe$/i, "")
    .toLowerCase();
  if (["bash", "zsh", "sh", "dash", "ksh", "ash"].includes(shell)) return "posix";
  if (shell === "fish") return "fish";
  if (shell === "pwsh" || shell === "powershell") return "powershell";
  if (shell === "cmd") return "cmd";
  return null;
}

// The pane's shell, once it is idle at its prompt (the shell itself in the foreground).
export async function readyShell(
  resource: PaneResource,
  options: HerdrOptions & { timeoutMs?: number } = {},
): Promise<{ pid: number; kind: ShellKind }> {
  const until = Date.now() + (options.timeoutMs ?? 15_000);
  for (;;) {
    if (!(await owned(resource, options)))
      throw new HerdrError("The pane is no longer pinata's; refusing to control it", "ownership");
    const info = (await herdr(["pane", "process-info", "--pane", resource.pane_id], options))
      ?.process_info;
    const processes: Array<{ pid: number; name: string }> = info?.foreground_processes ?? [];
    const shell = processes.find((p) => p.pid === info?.shell_pid);
    const kind = shell ? shellKind(shell.name) : null;
    if (
      info?.shell_pid &&
      info.foreground_process_group_id === info.shell_pid &&
      processes.every((p) => p.pid === info.shell_pid) &&
      kind
    )
      return { pid: info.shell_pid, kind };
    if (Date.now() > until)
      throw new HerdrError(
        shell && !kind
          ? `Unsupported pane shell ${JSON.stringify(shell.name)}`
          : "The pane's shell did not become ready",
        "not_ready",
      );
    await new Promise((r) => setTimeout(r, 200));
  }
}

const posix = (arg: string) =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
const fish = (arg: string) =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const powershell = (arg: string) => `'${arg.replaceAll("'", "''")}'`;
// cmd.exe: quote, double embedded quotes, and escape what cmd expands.
const cmd = (arg: string) => `"${arg.replaceAll('"', '""').replace(/([%^&|<>!])/g, "^$1")}"`;

// One command line for the pane's shell.
export function commandLine(argv: readonly string[], kind: ShellKind): string {
  if (kind === "powershell") return `& ${argv.map(powershell).join(" ")}`;
  if (kind === "cmd") return argv.map(cmd).join(" ");
  return argv.map(kind === "fish" ? fish : posix).join(" ");
}

export async function runInPane(
  resource: PaneResource,
  command: string,
  options: HerdrOptions = {},
): Promise<void> {
  if (!(await owned(resource, options)))
    throw new HerdrError("The pane is no longer pinata's; refusing to control it", "ownership");
  await herdr(["pane", "run", resource.pane_id, command], options);
}

// Closes a workspace pinata created; never one whose pane changed owner.
export async function closeWorkspace(
  resource: PaneResource,
  options: HerdrOptions = {},
): Promise<boolean> {
  if (!(await owned(resource, options))) return false;
  await herdr(["workspace", "close", resource.workspace_id], options).catch(() => {});
  return true;
}

export async function focusWorkspace(resource: PaneResource, options: HerdrOptions = {}) {
  if (!(await owned(resource, options)))
    throw new HerdrError("The pane is no longer pinata's", "ownership");
  await herdr(["workspace", "focus", resource.workspace_id], options);
}

export async function notify(
  title: string,
  body: string,
  options: HerdrOptions & { sound?: "none" | "done" | "request" } = {},
): Promise<void> {
  await herdr(
    ["notification", "show", title, "--body", body, "--sound", options.sound ?? "done"],
    options,
  ).catch(() => {});
}

// Workspaces whose label pinata gave (`pinata-<run>-…`), for GC.
export async function pinataWorkspaces(
  options: HerdrOptions = {},
): Promise<Array<{ workspace_id: string; label: string }>> {
  const listing = await herdr(["workspace", "list"], options);
  const workspaces: Array<{ workspace_id: string; label?: string }> = listing?.workspaces ?? [];
  return workspaces
    .filter((w) => typeof w.label === "string" && /^pinata-[0-9a-f]{8}-/.test(w.label))
    .map((w) => ({ workspace_id: w.workspace_id, label: w.label! }));
}
