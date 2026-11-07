import { isDelivered } from "./delivery-state.ts";
// Result delivery. Foreground runs return through the tool call (pi/tools.ts). Background
// runs send one follow-up message when they settle, which resumes an idle parent; a
// delivered marker in the run directory prevents a second delivery.
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RunHandle } from "../core/engine.ts";
import { atomicJson, readJson, readEvents } from "../core/store.ts";
import { join } from "node:path";
import type { AgentEvent } from "../core/types.ts";
import { statusText, progressLine } from "../ui/text.ts";
import { compactRun, type CompactRun, type PinataHost } from "./host.ts";
import { resultLines } from "./render.ts";

export const RESULT_TYPE = "pinata-result";

export function resultMessage(result: CompactRun, text: string) {
  return {
    customType: RESULT_TYPE,
    content: `pinata run ${result.run} settled: ${result.status}.\n${text}\n\nResults: ${JSON.stringify(result)}`,
    display: true,
    details: result,
  };
}

const deliveries = new Map<string, Promise<boolean>>();

export function deliver(
  pi: ExtensionAPI,
  handle: RunHandle,
  notices: string[] = [],
): Promise<boolean> {
  const existing = deliveries.get(handle.dir);
  if (existing) return existing.catch(() => false).then(() => deliver(pi, handle, notices));
  const pending = deliverResult(pi, handle, notices).finally(() => deliveries.delete(handle.dir));
  deliveries.set(handle.dir, pending);
  return pending;
}

async function deliverResult(
  pi: ExtensionAPI,
  handle: RunHandle,
  notices: string[] = [],
): Promise<boolean> {
  const done = handle.done;
  const view = await done;
  const file = join(handle.dir, "delivered.json");
  if (await isDelivered(handle.dir, view)) return false;
  if (handle.done !== done || handle.view?.().status === "running") return false;
  const result = compactRun(view, handle.dir, handle.results(), notices);
  pi.sendMessage(
    resultMessage(result, view.order.length > 64 ? progressLine(view) : statusText(view)),
    {
      triggerTurn: true,
      deliverAs: "followUp",
    },
  );
  await atomicJson(file, { at: Date.now(), seq: view.seq });
  return true;
}

export function deliverWhenDone(
  pi: ExtensionAPI,
  host: PinataHost,
  handle: RunHandle,
  notices: string[] = [],
): void {
  host.deliveryCleanups.get(handle.id)?.();
  let disposed = false;
  let pending: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const events = new Map<string, AgentEvent>();
  const flush = async () => {
    const batch = [...events.values()];
    events.clear();
    if (disposed || handle.view().status !== "running") return;
    const file = join(handle.dir, "notices.json");
    const sent: string[] = await readJson<string[]>(file).catch((): string[] => []);
    const view = handle.view();
    if (disposed || view.status !== "running") return;
    const actionable = batch.filter(
      (event) =>
        event.agent &&
        view.agents[event.agent]?.settledSeq === event.seq &&
        !sent.includes(`${handle.id}:${event.seq}`),
    );
    // Blocked descendants are represented by their failed ancestor's notice.
    const roots = actionable.filter((event) => {
      const task = view.tasks.find((task) => task.id === event.agent);
      return !task?.after?.some((id) =>
        ["failed", "rejected", "blocked"].includes(view.agents[id]?.status),
      );
    });
    if (!roots.length || disposed) return;
    // Bound each message, not the queue: independent failures still need intervention.
    roots.slice(8).forEach(observe);
    const details = roots.slice(0, 8).map((event) => {
      const task = view.tasks.find((task) => task.id === event.agent)!;
      const target = task.reviewOf ?? task.id;
      const affected = new Set<string>([target]);
      for (let changed = true; changed;) {
        changed = false;
        for (const candidate of view.tasks)
          if (!affected.has(candidate.id) && candidate.after?.some((id) => affected.has(id))) {
            affected.add(candidate.id);
            changed = true;
          }
      }
      affected.delete(target);
      const unsafe = [...affected].filter((id) => {
        const status = view.agents[id]?.status;
        return (
          status === "running" ||
          (!view.tasks.find((t) => t.id === id)?.reviewOf &&
            !["queued", "blocked", "cancelled"].includes(status))
        );
      });
      return {
        noticeId: `${handle.id}:${event.seq}`,
        run: handle.id,
        task: task.id,
        attempt: view.agents[task.id].attemptSeq ?? event.seq,
        status: view.agents[task.id].status,
        reason: (view.agents[task.id].reason ?? view.agents[task.id].summary ?? "").slice(0, 1600),
        evidence: join(handle.dir, "results", `${task.id}.json`),
        reviewTarget: task.reviewOf,
        affectedDependents: [...affected].slice(0, 64),
        repair: {
          target,
          eligible: !unsafe.length,
          unsafeDependents: unsafe.slice(0, 64),
          note: "Current-state hint; repair revalidates dependencies, time and budgets.",
        },
        remainingMs:
          view.deadlineAt === undefined ? null : Math.max(0, view.deadlineAt - Date.now()),
      };
    });
    pi.sendMessage(
      {
        customType: "pinata-actionable",
        display: true,
        details,
        content: `Pinata intervention may be useful. Other branches may still be running. Choose repair, cancellation or a new run; no action has been taken automatically.\n${JSON.stringify(details)}`,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    // Send before persistence: a crash can redeliver the stable notice ID, never silently lose it.
    await atomicJson(file, [...sent, ...details.map((notice) => notice.noticeId)]);
  };
  const observe = (event: AgentEvent) => {
    if (disposed) return;
    if (
      event.t !== "agent_settled" ||
      !event.agent ||
      !["failed", "rejected", "blocked"].includes(event.status)
    )
      return;
    if ((events.get(event.agent)?.seq ?? -1) < event.seq) events.set(event.agent, event);
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      pending = pending.then(flush).catch(() => {});
    }, 25);
  };
  const unsubscribe = host.subscribe(handle.id, observe);
  // Recover failures that settled before subscription or while this host was absent.
  pending = readEvents(handle.dir)
    .then((saved) => {
      saved.forEach(observe);
    })
    .catch(() => {});
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
  host.deliveryCleanups.set(handle.id, cleanup);
  const done = handle.done;
  void done
    .then(async () => {
      await pending;
      if (!disposed && handle.done === done) await deliver(pi, handle, notices);
    })
    .catch(() => {})
    .finally(() => {
      cleanup();
      if (host.deliveryCleanups.get(handle.id) === cleanup) {
        host.deliveryCleanups.delete(handle.id);
        host.background.delete(handle.id);
      }
    });
}

export function registerDelivery(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<CompactRun>(RESULT_TYPE, (message, options) => {
    const r = message.details;
    if (!r)
      return new Text(
        typeof message.content === "string" ? message.content : "pinata result",
        1,
        0,
      );
    return new Text(resultLines(r, options.expanded).join("\n"), 1, 0);
  });
}
