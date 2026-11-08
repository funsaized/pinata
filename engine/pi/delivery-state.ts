import { join } from "node:path";
import { readJson } from "../core/store.ts";
import type { RunView } from "../core/view.ts";

// A marker belongs to one settlement, not every future repair of the run.
export async function isDelivered(dir: string, view: RunView): Promise<boolean> {
  if (view.order.some((worker) => view.agents[worker].assignments)) {
    const sent = new Set(await readJson<string[]>(join(dir, "notifications.json")).catch(() => []));
    const ids = view.order.flatMap((worker) =>
      Object.entries(view.agents[worker].assignments ?? {})
        .filter(([, assignment]) => !["running", "queued"].includes(assignment.status))
        .map(([assignment]) => `${view.run}:${worker}:${assignment}`),
    );
    return ids.length > 0 && ids.every((id) => sent.has(id));
  }
  const marker = await readJson<{ at: number; seq?: number }>(join(dir, "delivered.json")).catch(
    () => null,
  );
  if (!marker) return false;
  if (view.seq === undefined) return true;
  if (marker.seq !== undefined) return marker.seq >= view.seq;
  return marker.at >= (view.settledAt ?? 0);
}
