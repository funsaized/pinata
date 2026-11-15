import type { ProjectRun } from "../sources/project.ts";
import type { Paint } from "./palette.ts";
import { displayText, fit, padded } from "./text.ts";

export type RunPicker = {
  runs: ProjectRun[];
  selected: number;
  scroll: number;
  loading: boolean;
  skipped: number;
  error?: string;
  hitRows: Map<number, number>;
};

function singleLine(text: string): string {
  return displayText(text).replaceAll("\n", " ");
}

export function renderRuns(
  picker: RunPicker,
  options: {
    width: number;
    height: number;
    workspace: string;
    current?: string;
    paint: Paint;
  },
): string[] {
  const { width, height, paint } = options;
  const output = [
    paint("strong", "Project runs"),
    paint("muted", singleLine(options.workspace)),
    "",
  ];
  const available = Math.max(1, Math.floor((height - 6) / 2));
  picker.selected = Math.max(0, Math.min(picker.selected, picker.runs.length - 1));
  picker.scroll = Math.min(picker.scroll, picker.selected);
  if (picker.selected >= picker.scroll + available) picker.scroll = picker.selected - available + 1;
  picker.hitRows.clear();
  for (const [index, run] of picker.runs
    .slice(picker.scroll, picker.scroll + available)
    .entries()) {
    const selected = picker.scroll + index === picker.selected;
    const current = run.directory === options.current;
    const label = `${selected ? ">" : " "} ${run.run} · ${run.live ? (run.control ? "Live · control" : "Live · read-only") : "Saved · read-only"}${current ? " · current" : ""}`;
    picker.hitRows.set(output.length, picker.scroll + index);
    picker.hitRows.set(output.length + 1, picker.scroll + index);
    output.push(paint(selected ? "focus" : "text", displayText(padded(singleLine(label), width))));
    output.push(paint("muted", "  " + singleLine(run.workspace)));
  }
  if (picker.loading) output.push(paint("muted", "Loading project runs…"));
  else if (!picker.runs.length && !picker.error) output.push("No retained runs in this project.");
  if (picker.error) output.push(paint("error", singleLine(picker.error)));
  if (picker.skipped)
    output.push(paint("warning", `${picker.skipped} run folders could not be read.`));
  const body = output.slice(0, Math.max(0, height - 1));
  while (body.length < height - 1) body.push("");
  body.push(paint("muted", "↑↓ select · Enter open · r refresh · Esc back"));
  return body.slice(0, height).map((line) => fit(line, width));
}
