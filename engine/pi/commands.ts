// /pinata commands. None of them sends a model turn.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { duration, money, progressLine, short, statusText } from "../ui/text.ts";
import type { PinataHost } from "./host.ts";
import { integrationStatus, type RunSource } from "./ui.ts";

export const USAGE = [
  "/pinata              status of the latest run",
  "/pinata runs         runs in this repository",
  "/pinata mode lean|observe   footprint mode for this session",
  "/pinata live [run|demo]      the mascot overlay",
  "/pinata open [run] <task>    an agent's conversation, live (Enter steers)",
  "/pinata watch [run] [task]   start the run's socket for an external viewer",
  "/pinata rerun <run>          start again the tasks lost when Pi exited",
].join("\n");

// Runs for /pinata live: this session's newest first, else the repository's history.
export function runSource(host: PinataHost): RunSource {
  return {
    async runs(ctx) {
      const session = [...host.handles.keys()].reverse();
      return session.length ? session : (await host.history(ctx.cwd, 10)).map((v) => v.run);
    },
    async read(run, ctx) {
      const found = await host.find(run, ctx.cwd);
      return { view: found.view, integration: await integrationStatus(found.dir) };
    },
  };
}

export async function pinataCommand(
  host: PinataHost,
  args: string,
  ctx: Pick<ExtensionCommandContext, "cwd" | "ui" | "hasUI" | "mode" | "sessionManager">,
): Promise<string> {
  const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  if (!sub || sub === "status") {
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
    const views = await host.history(ctx.cwd);
    if (!views.length) return "No pinata runs in this repository.";
    return views
      .map(
        (v) =>
          `${short(v.run)}  ${v.status.padEnd(9)} ${v.order.length} agents · ${money(v.usage.cost)} · ${duration((v.settledAt ?? Date.now()) - v.startedAt)} · ${new Date(v.startedAt).toISOString().slice(0, 16).replace("T", " ")}`,
      )
      .join("\n");
  }
  if (sub === "live") {
    if (!host.ui) return "The live view needs interactive Pi.";
    return (await host.ui.openLive(rest.join(" "), ctx, runSource(host))) ?? "";
  }
  if (sub === "open") {
    if (!host.ui) return "The detail view needs interactive Pi.";
    const [first, second] = rest;
    if (!first) return "Usage: /pinata open [run] <task>";
    let found;
    if (second) found = await host.find(first, ctx.cwd);
    else {
      const latest = [...host.handles.values()].at(-1);
      if (latest) found = { id: latest.id, dir: latest.dir, view: latest.view() };
      else {
        const [view] = await host.history(ctx.cwd, 1);
        if (!view) return "No pinata runs in this repository.";
        found = await host.find(view.run, ctx.cwd);
      }
    }
    return (await host.ui.openDetail(found, second ?? first, ctx)) ?? "";
  }
  if (sub === "watch") {
    const [first, second] = rest;
    // `watch <task>` names a task of the latest run; `watch <run> [task]` a run.
    const latest = [...host.handles.values()].at(-1);
    const byTask = first && latest?.view().agents[first] ? first : undefined;
    const handle = first && !byTask ? (await host.find(first, ctx.cwd)).handle : latest;
    if (!handle)
      return "No run of this session to watch; viewers of finished runs read them from disk.";
    if (handle.view().status !== "running" && !host.servers.has(handle.id))
      return `Run ${short(handle.id)} has settled. Replay it with /pinata open ${short(handle.id)} <task>.`;
    await host.serve(handle);
    const task = second ?? byTask;
    return `Watching ${short(handle.id)}: run \`pinata view ${short(handle.id)}${task ? ` ${task}` : ""}\` in another terminal (socket and token in ${handle.dir}/link.json).`;
  }
  if (sub === "rerun") {
    if (!rest[0]) return "Usage: /pinata rerun <run>";
    const found = await host.find(rest[0], ctx.cwd);
    if (!found.handle)
      return `Run ${short(found.id)} is not loaded in this Pi; restart Pi to resume it.`;
    const reopened = host.rerun(found.id);
    return `pinata ${short(found.id)}: started again ${reopened.join(", ")}`;
  }
  if (sub === "mode") {
    const mode = rest[0];
    if (mode !== "lean" && mode !== "observe")
      return `Mode: ${host.modeOverride ?? "from config (default lean)"}. Use /pinata mode lean|observe.`;
    host.modeOverride = mode;
    return `pinata mode for this session: ${mode}`;
  }
  return USAGE;
}

export function registerCommands(pi: ExtensionAPI, host: PinataHost): void {
  pi.registerCommand("pinata", {
    description: "pinata status, runs and mode (no model turn)",
    getArgumentCompletions: (prefix) =>
      ["status", "runs", "live", "live demo", "open", "watch", "rerun", "mode lean", "mode observe"]
        .filter((c) => c.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
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

export { progressLine };
