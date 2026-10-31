// One opaque, visibly separate frame for the run workspace. The ribbon stays still while
// the mascot moves, and the double outline remains recognizable with NO_COLOR.
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { colorize, RIBBON_COLORS } from "./mascot.ts";
import type { Paint } from "./widget.ts";

export function pad(text: string, width: number): string {
  if (width <= 0) return "";
  const value = truncateToWidth(text, width);
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

export function ribbon(text: string): string {
  const chars = [...text];
  return RIBBON_COLORS.map((color, i) =>
    colorize(
      color,
      chars
        .slice(Math.floor((i * chars.length) / 6), Math.floor(((i + 1) * chars.length) / 6))
        .join(""),
    ),
  ).join("");
}

export function workspaceFrame(lines: string[], width: number, theme: Paint): string[] {
  const inside = Math.max(0, width - 2);
  const cap = (left: string, right: string) => ribbon(left + "═".repeat(inside) + right);
  // oxlint-disable-next-line no-control-regex
  const background = theme.bg?.("customMessageBg", "").replace(/\x1b\[49m$/, "") ?? "";
  return [
    cap("╔", "╗"),
    ...lines.map((line, i) => {
      const color = RIBBON_COLORS[Math.min(5, Math.floor((i * 6) / Math.max(1, lines.length)))];
      // Pi message components reset their own backgrounds. Restore the workspace
      // background after each reset so the remainder of the row stays opaque.
      // oxlint-disable-next-line no-control-regex
      const body = pad(line, inside).replace(/\x1b\[(?:0|49)m/g, (reset) => reset + background);
      return (
        colorize(color, "║") + (theme.bg?.("customMessageBg", body) ?? body) + colorize(color, "║")
      );
    }),
    cap("╚", "╝"),
  ].map((line) => truncateToWidth(line, Math.max(1, width)));
}
