// /pinata commands. None of them sends a model turn.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { duration, money, progressLine, short, statusText } from "../ui/text.ts";
import type { PinataHost } from "./host.ts";
import { integrationStatus, type RunSource } from "./ui.ts";
import { commandLine, insideHerdr } from "../herdr/client.ts";
import { gcPanes } from "../herdr/panes.ts";
import { legacyRoot, retireLegacy } from "../migrate/legacy.ts";
import { runsRoot } from "../core/store.ts";
import { repositoryRoot } from "./host.ts";
import type { RunWorkspace } from "../ui/workspace.ts";
import {
  connectViewer,
  clientDetail,
  reconnectViewer,
  type ViewerClient,
} from "../viewer/client.ts";
import {
  RunCatalog,
  commandWords,
  orderRuns,
  parseViewArgs,
  requireTask,
  VIEW_ARGS,
  type ViewArgs,
} from "../viewer/selection.ts";

export const USAGE = [
  "/pinata              status of the latest run",
  "/pinata runs         runs in this repository",
  "/pinata mode lean|observe   footprint mode for this session",
  `/pinata view ${VIEW_ARGS}   inspect runs and conversations`,
  `/pinata view ${VIEW_ARGS} --external   view from another terminal or Herdr pane`,
  "/pinata rerun <run>          start again the tasks lost when Pi exited",
  "/pinata gc [--confirm]         retire 0.7.0 runs (preview; confirm acts) and close settled panes",
].join("\n");

// The run picker includes repository history and prefers active work from this session.
export function runSource(host: PinataHost): RunSource {
  let scene: RunWorkspace | undefined;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const directories = new Map<string, string>();
  const integrations = new Map<string, string | null>();
  const clients = new Map<string, Promise<{ client: ViewerClient; stop: () => void }>>();
  const release = (id: string) => {
    const pending = clients.get(id);
    clients.delete(id);
    void pending
      ?.then(({ client, stop }) => {
        stop();
        client.close();
      })
      .catch(() => {});
  };
  return {
    async runs(ctx) {
      return (await viewRuns(host, ctx.cwd)).map((v) => v.run);
    },
    async resolve(run, ctx) {
      const found = await host.find(run, ctx.cwd);
      directories.set(found.id, found.dir);
      return found.id;
    },
    async read(run, ctx) {
      const found = await host.find(directories.get(run) ?? run, ctx.cwd);
      return { view: found.view, integration: await integrationStatus(found.dir) };
    },
    async detail(run, ctx) {
      for (const id of clients.keys()) if (id !== run) release(id);
      const found = await host.find(directories.get(run) ?? run, ctx.cwd);
      if (found.handle) {
        if (scene) scene.connection = null;
        return host.ui!.detailSource(found.id, found.dir, found.view, ctx.cwd);
      }
      let pending = clients.get(run);
      if (!pending) {
        pending = (async () => {
          const client = await connectViewer(found.dir);
          if (closed || scene?.selected() !== run) {
            client.close();
            throw new Error("View selection changed");
          }
          const integration = await integrationStatus(found.dir);
          integrations.set(run, integration);
          if (closed || scene?.selected() !== run) {
            client.close();
            throw new Error("View selection changed");
          }
          const update = () => {
            if (closed || scene?.selected() !== run) return;
            scene.offer({ view: client.view!, integration: integrations.get(run) ?? null });
            scene.connection =
              client.source === "socket"
                ? client.closed
                  ? "disconnected · recorded output"
                  : "live"
                : "from the run's log · read-only";
          };
          const stop = client.on(update);
          update();
          return { client, stop };
        })();
        clients.set(run, pending);
        const attempt = pending;
        void attempt.catch(() => {
          if (clients.get(run) === attempt) clients.delete(run);
        });
      }
      const { client } = await pending;
      return clientDetail(client, found.dir, ctx.cwd);
    },
    watch(workspace, ctx) {
      scene = workspace;
      const catalog = new RunCatalog();
      const root = runsRoot(ctx.cwd);
      const poll = async () => {
        try {
          if (closed) return;
          if (workspace.followNewRuns) {
            const records = await catalog.list(await root);
            if (closed) return;
            for (const record of [...records].reverse())
              if (!workspace.runs.includes(record.view.run))
                workspace.offer({ view: record.view, integration: null });
          }
          const id = workspace.selected();
          const entry = id && clients.get(id);
          if (entry) {
            const { client } = await entry;
            if (closed || workspace.selected() !== id) return;
            const found = await host.find(directories.get(id) ?? id, ctx.cwd);
            const integration = await integrationStatus(found.dir);
            if (closed || workspace.selected() !== id) return;
            integrations.set(id, integration);
            workspace.offer({ view: client.view!, integration });
            if (!workspace.detail?.input) {
              if (await reconnectViewer(client, found.dir)) {
                if (closed || workspace.selected() !== id) return;
                release(id);
                await workspace.reloadSource();
              }
            }
          }
        } catch {
          /* A partially written new run can be discovered on the next pass. */
        } finally {
          if (!closed) {
            timer = setTimeout(() => void poll(), 1000);
            timer.unref?.();
          }
        }
      };
      void root.catch(() => {});
      timer = setTimeout(() => void poll(), 1000);
      timer.unref?.();
    },
    dispose() {
      closed = true;
      clearTimeout(timer);
      for (const id of clients.keys()) release(id);
    },
  };
}

async function viewRuns(host: PinataHost, cwd: string) {
  const views = new Map((await host.history(cwd, Infinity)).map((v) => [v.run, v]));
  for (const handle of host.handles.values()) views.set(handle.id, handle.view());
  return orderRuns([...views.values()], new Set(host.handles.keys()));
}

function arity(args: string[], min: number, max: number, usage: string): void {
  if (args.length < min || args.length > max) throw new Error(`Usage: /pinata ${usage}`);
}

// Old names remain aliases, but canonical view arguments never guess task vs run.
function viewArguments(sub: string, rest: string[], host: PinataHost): ViewArgs {
  if (sub === "view") return parseViewArgs(rest, true);
  if (sub === "live") {
    arity(rest, 0, 1, `view ${VIEW_ARGS}`);
    return { run: rest[0] };
  }
  if (sub === "open") {
    arity(rest, 1, 2, `view ${VIEW_ARGS}`);
    return { run: rest.length === 2 ? rest[0] : undefined, task: rest.at(-1) };
  }
  arity(rest, 0, 2, `view ${VIEW_ARGS} --external`);
  const latest = [...host.handles.values()].at(-1);
  return rest.length === 1 && latest?.view().agents[rest[0]]
    ? { task: rest[0], external: true }
    : { run: rest[0], task: rest[1], external: true };
}

// Repository GC: 0.7.0 run directories (preview unless confirmed), and inside Herdr the
// workspaces of settled pinata work.
export async function gcText(cwd: string, confirm: boolean): Promise<string> {
  const root = await repositoryRoot(cwd);
  const lines: string[] = [];
  for (const item of await retireLegacy(await legacyRoot(root), { confirm }))
    lines.push(
      `0.7.0 ${item.run.slice(0, 8)} ${item.what === "run" ? "" : `${item.what}: `}${item.action}${item.reason ? ` (${item.reason})` : ""}`,
    );
  if (insideHerdr())
    for (const e of await gcPanes(await runsRoot(root)))
      lines.push(`${e.action.padEnd(6)} ${e.label}: ${e.reason}`);
  if (!lines.length) return "Nothing to clean up.";
  if (!confirm && lines.some((l) => /would /.test(l)))
    lines.push("Preview only: /pinata gc --confirm (or pinata gc --confirm) acts on it.");
  return lines.join("\n");
}

export async function pinataCommand(
  host: PinataHost,
  args: string,
  ctx: Pick<ExtensionCommandContext, "cwd" | "ui" | "hasUI" | "mode" | "sessionManager">,
): Promise<string> {
  const [sub, ...rest] = commandWords(args);
  if (!sub || sub === "status") {
    arity(rest, 0, 0, "status");
    const latest = [...host.handles.values()].at(-1);
    const interrupted = await host.interrupted(ctx.cwd);
    const note = interrupted.length
      ? `\nInterrupted (Pi exited before they settled): ${interrupted.map((v) => short(v.run)).join(", ")}. Start them again to re-run.`
      : "";
    if (latest) return statusText(latest.view()) + note;
    const [view] = await host.history(ctx.cwd, 1);
    return (view ? statusText(view) : "No pinata runs in this repository.") + note;
  }
  if (sub === "runs") {
    arity(rest, 0, 0, "runs");
    const views = await host.history(ctx.cwd);
    if (!views.length) return "No pinata runs in this repository.";
    return views
      .map(
        (v) =>
          `${short(v.run)}  ${v.status.padEnd(9)} ${v.order.length} agents · ${money(v.usage.cost)} · ${duration((v.settledAt ?? Date.now()) - v.startedAt)} · ${new Date(v.startedAt).toISOString().slice(0, 16).replace("T", " ")}`,
      )
      .join("\n");
  }
  if (["view", "live", "open", "watch"].includes(sub)) {
    const target = viewArguments(sub, rest, host);
    if (!target.external) {
      if (!host.ui) return "The view needs interactive Pi.";
      return (await host.ui.openView(target, ctx, runSource(host))) ?? "";
    }
    const id = target.run ?? (await viewRuns(host, ctx.cwd))[0]?.run;
    if (!id)
      return "No pinata runs in this repository. Start a run, then use /pinata view --external.";
    const found = await host.find(id, ctx.cwd);
    requireTask(found.view, target.task);
    if (found.handle && (found.view.status === "running" || host.servers.has(found.id)))
      await host.serve(found.handle, target.task);
    const byId = await host.find(found.id, ctx.cwd).catch(() => null);
    const command = commandLine(
      [
        "pinata",
        "view",
        byId?.dir === found.dir ? found.id : found.dir,
        ...(target.task ? ["--task", target.task] : []),
      ],
      process.platform === "win32" && byId?.dir !== found.dir ? "powershell" : "posix",
    );
    return (
      `View ${short(found.id)} from another terminal in this repository: \`${command}\`.` +
      (found.handle && insideHerdr() && found.view.status === "running"
        ? " A Herdr viewer pane is opening."
        : "")
    );
  }
  if (sub === "rerun") {
    arity(rest, 1, 1, "rerun <run>");
    const found = await host.find(rest[0], ctx.cwd);
    if (!found.handle)
      return `Run ${short(found.id)} is not loaded in this Pi; restart Pi to resume it.`;
    const reopened = host.rerun(found.id);
    return `pinata ${short(found.id)}: started again ${reopened.join(", ")}`;
  }
  if (sub === "gc") {
    arity(rest, 0, 1, "gc [--confirm]");
    if (rest[0] && !["confirm", "--confirm"].includes(rest[0]))
      throw new Error("Usage: /pinata gc [--confirm]");
    return gcText(ctx.cwd, !!rest[0]);
  }
  if (sub === "mode") {
    arity(rest, 0, 1, "mode lean|observe");
    const mode = rest[0];
    if (!mode)
      return `Mode: ${host.modeOverride ?? "from config (default lean)"}. Use /pinata mode lean|observe.`;
    if (mode !== "lean" && mode !== "observe") throw new Error("Usage: /pinata mode lean|observe");
    host.modeOverride = mode;
    return `pinata mode for this session: ${mode}`;
  }
  if (sub === "help") {
    arity(rest, 0, 0, "help");
    return USAGE;
  }
  throw new Error(`Unknown command ${sub}. Use /pinata help.`);
}

export function registerCommands(pi: ExtensionAPI, host: PinataHost): void {
  let cwd = process.cwd();
  pi.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd;
  });
  pi.registerCommand("pinata", {
    description: "View runs and conversations, check status, or manage pinata (no model turn)",
    getArgumentCompletions: (prefix) => commandCompletions(host, cwd, prefix),
    handler: async (args, ctx) => {
      cwd = ctx.cwd;
      let text: string;
      try {
        text = await pinataCommand(host, args, ctx);
      } catch (error) {
        text = `pinata: ${(error as Error).message}`;
      }
      if (text) ctx.ui.notify(text, "info");
    },
  });
}

export async function commandCompletions(host: PinataHost, cwd: string, prefix: string) {
  const commands = ["status", "runs", "view", "rerun", "gc", "mode lean", "mode observe", "help"];
  if (!prefix.includes(" "))
    return commands
      .filter((value) => value.startsWith(prefix))
      .map((value) => ({ value, label: value }));
  let words: string[];
  try {
    words = commandWords(prefix);
  } catch {
    return [];
  }
  const tail = /\s$/.test(prefix) ? "" : (words.pop() ?? "");
  const base = prefix.slice(0, prefix.length - tail.length);
  const [sub, ...args] = words;
  if (sub === "mode")
    return ["lean", "observe"]
      .filter((v) => v.startsWith(tail))
      .map((v) => ({ value: base + v, label: v }));
  if (sub === "gc")
    return args.length
      ? []
      : ["--confirm"].filter((v) => v.startsWith(tail)).map((v) => ({ value: base + v, label: v }));
  if (sub !== "view" && sub !== "rerun") return [];
  try {
    const wantsTask = args.at(-1) === "--task";
    const target = parseViewArgs(wantsTask ? args.slice(0, -1) : args, true);
    const views = await viewRuns(host, cwd);
    if (wantsTask) {
      const view = target.run ? (await host.find(target.run, cwd)).view : views[0];
      return (view?.order ?? [])
        .filter((id) => id.startsWith(tail))
        .map((id) => ({
          value: base + id,
          label: id,
          description: `${view.agents[id].role} · ${view.agents[id].status}`,
        }));
    }
    const options =
      sub === "view"
        ? [!target.task && "--task", !target.external && "--external"].filter(
            (v): v is string => !!v,
          )
        : [];
    return [
      ...(!target.run
        ? views
            .filter((v) => v.run.startsWith(tail))
            .map((v) => ({
              value: base + v.run,
              label: short(v.run),
              description: `${v.status} · ${v.order.length} tasks`,
            }))
        : []),
      ...options.filter((v) => v.startsWith(tail)).map((v) => ({ value: base + v, label: v })),
    ];
  } catch {
    return [];
  }
}

export { progressLine };
