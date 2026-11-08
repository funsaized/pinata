import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

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
