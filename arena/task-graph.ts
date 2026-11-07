import type { Unit } from "./types.ts";

/** Validate public planning metadata before exposing it to an external coordinator. */
export function validateUnitGraph(units: Unit[]): void {
  const ids = new Set(units.map((unit) => unit.id));
  if (ids.size !== units.length) throw new Error("Duplicate unit IDs");
  for (const unit of units) {
    if (
      unit.after !== undefined &&
      (!Array.isArray(unit.after) ||
        new Set(unit.after).size !== unit.after.length ||
        unit.after.some((id) => typeof id !== "string" || id === unit.id || !ids.has(id)))
    )
      throw new Error(`Invalid dependencies for unit ${unit.id}`);
  }
  const done = new Set<string>();
  while (done.size < units.length) {
    const ready = units.filter(
      (unit) => !done.has(unit.id) && (unit.after ?? []).every((id) => done.has(id)),
    );
    if (!ready.length) throw new Error("Cyclic unit dependency graph");
    for (const unit of ready) done.add(unit.id);
  }
}
