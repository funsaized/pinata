import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Paint } from "./palette.ts";
import { fit } from "./text.ts";
import { activityMouth, activityStepMs } from "./tree.ts";

type VisibleRow = { line: string; track: string; start: number; position: number; frame: number };
type DepartingRow = VisibleRow & {
  tick: number;
  mouth: number;
  cells: number;
  textEnd: number;
  visibleEnd: number;
};
// Pellets can enter the text half a beat before the mouth advances.
export const pelletStepMs = activityStepMs / 2;

// Keep only rows the user could see. A settlement can finish a row's animation
// without keeping the assignment active or selectable.
export class CompletionRows {
  private scope?: string;
  private readonly visible = new Map<string, VisibleRow>();
  private readonly departing = new Map<string, DepartingRow>();

  get size(): number {
    return this.departing.size;
  }
  has(key: string): boolean {
    return this.departing.has(key);
  }
  clear(): void {
    this.visible.clear();
    this.departing.clear();
  }
  begin(scope: string): void {
    this.visible.clear();
    if (this.scope !== scope) this.departing.clear();
    this.scope = scope;
    this.expire();
  }
  remember(key: string, row: VisibleRow): void {
    this.visible.set(key, row);
  }
  // A released worker or the new selection's dependency group can appear above
  // the old row during settlement. Hold visible departures in their last slots.
  positionRows<T>(rows: T[], keyOf: (row: T) => string | undefined): T[] {
    if (!this.departing.size) return rows;
    const retained: { position: number; row: T }[] = [];
    const rest = rows.filter((row) => {
      const key = keyOf(row);
      const departing = key === undefined ? undefined : this.departing.get(key);
      if (!departing) return true;
      retained.push({ position: departing.position, row });
      return false;
    });
    for (const { position, row } of retained.sort((a, b) => a.position - b.position))
      rest.splice(position, 0, row);
    return rest;
  }
  finish(key: string): void {
    const row = this.visible.get(key);
    if (!row) return;
    const text = stripTerminalSequences(row.line);
    const textEnd = visibleWidth(text.trimEnd());
    const head = Math.max(row.track.lastIndexOf("c"), row.track.lastIndexOf("C"));
    // A staggered wave can settle between passes, with only pellets or dashes on screen.
    const mouth = head >= 0 ? head : row.track.includes("o") ? -1 : row.track.length - 1;
    this.departing.set(key, {
      ...row,
      mouth,
      cells: visibleWidth(text),
      textEnd,
      visibleEnd: textEnd,
      tick: Math.floor(performance.now() / pelletStepMs),
    });
    this.visible.delete(key);
  }
  expire(): void {
    const frame = Math.floor(performance.now() / activityStepMs);
    for (const [key, row] of this.departing)
      if (row.start + row.mouth + frame - Math.floor(row.tick / 2) >= row.visibleEnd + 2)
        this.departing.delete(key);
  }
  render(key: string, width: number, paint: Paint): string | undefined {
    const row = this.departing.get(key);
    if (!row) return;
    row.visibleEnd = Math.min(width, row.textEnd);
    const length = Math.max(0, row.visibleEnd - row.start);
    const gutter = " ".repeat(Math.min(row.start, width));
    const tick = Math.floor(performance.now() / pelletStepMs);
    const steps = Math.floor(tick / 2) - Math.floor(row.tick / 2);
    const mouth = row.mouth + steps;
    if (mouth >= length) return gutter + paint("muted", "-".repeat(length));

    // Extend the original lane into the text, a cell at a time, up to four cells ahead.
    const front = Math.min(
      length,
      Math.max(row.track.length, Math.min(row.track.length + tick - row.tick, mouth + 5)),
    );
    let lane = row.track.slice(0, front);
    if (steps > 0) {
      const keep = Math.max(0, row.mouth - steps + 1);
      lane = row.track.slice(0, keep) + "-".repeat(mouth - keep) + activityMouth(row.frame + steps);
    }
    while (lane.length < front) {
      const column = lane.length;
      lane += row.track[column] ?? (column % 2 === 0 ? "o" : " ");
    }
    const cut = row.start + front;
    // Keep the original colors and columns ahead of the pellets. A wide glyph
    // straddling the front leaves its remaining cell blank.
    const tail = sliceByColumn(row.line, cut, Infinity, true);
    const gap = Math.max(0, row.cells - cut - visibleWidth(tail));
    return fit(gutter + paint("accent.cyan", lane) + " ".repeat(gap) + tail, width);
  }
}
