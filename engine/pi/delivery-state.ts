import { join } from "node:path";
import { readJson } from "../core/store.ts";
import type { RunView } from "../core/view.ts";

// A marker belongs to one settlement, not every future repair of the run.
export async function isDelivered(
  dir: string,
  view: Pick<RunView, "seq" | "settledAt">,
): Promise<boolean> {
  const marker = await readJson<{ at: number; seq?: number }>(join(dir, "delivered.json")).catch(
    () => null,
  );
  if (!marker) return false;
  if (view.seq === undefined) return true;
  if (marker.seq !== undefined) return marker.seq >= view.seq;
  return marker.at >= (view.settledAt ?? 0);
}
