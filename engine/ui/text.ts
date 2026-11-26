import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import type { Paint } from "./palette.ts";
import type { DetailGroup } from "./projection.ts";

export function runArgument(run: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(run)) return run;
  // Keep even control characters and direction marks copyable on one terminal line.
  return JSON.stringify(run).replace(
    /[^ -~]/g,
    (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

// Runtime and worker strings are data. Remove control sequences before adding
// palette-owned styling; preserve graphemes and newlines in the readable text.
export function displayText(value: string): string {
  let text = "";
  for (const character of stripTerminalSequences(value)) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\n") text += "\n";
    else if (character === "\t") text += "    ";
    else if (
      code >= 32 &&
      !(code >= 127 && code <= 159) &&
      !(code >= 0x202a && code <= 0x202e) &&
      !(code >= 0x2066 && code <= 0x2069)
    )
      text += character;
  }
  return text;
}
export function fit(text: string, width: number): string {
  return truncateToWidth(text, Math.max(1, width), "");
}
export function lines(text: string, width: number): string[] {
  return wrapTextWithAnsi(displayText(text), Math.max(1, width)).map((line) => fit(line, width));
}
export function padded(text: string, width: number): string {
  const clipped = fit(text, width);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function detailRows(groups: DetailGroup[], width: number, paint: Paint): string[] {
  return groups.flatMap(({ title, fields }) => {
    const labelWidth = Math.max(...fields.map(([label]) => label.length)) + 2;
    const align = width >= labelWidth + 16;
    return [
      paint("strong", fit(title, width)),
      ...fields.flatMap(([label, value]) => {
        if (!label) return lines(value, width).map((line) => paint("error", line));
        if (!align) return [paint("muted", fit(label, width)), ...lines(value, width)];
        return lines(value, width - labelWidth).map(
          (line, index) =>
            (index === 0 ? paint("muted", label.padEnd(labelWidth)) : " ".repeat(labelWidth)) +
            paint("text", line),
        );
      }),
      "",
    ];
  });
}
