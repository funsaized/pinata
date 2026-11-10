import {
  backgroundAnsi,
  foregroundAnsi,
  parseColor,
  type TerminalColorMode,
} from "@earendil-works/pi-tui";
import { paletteSchema } from "../contracts/config.ts";
import type { z } from "zod";

export type PaletteName = z.infer<typeof paletteSchema>;
export type SemanticToken =
  | "background"
  | "text"
  | "muted"
  | "border"
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "accent.blue"
  | "accent.cyan"
  | "accent.green"
  | "accent.yellow"
  | "accent.orange"
  | "accent.red"
  | "accent.pink"
  | "accent.purple";
export type Palette = {
  name: PaletteName;
  appearance: "dark" | "light";
  colors: Record<SemanticToken, string>;
};
type Colors = [
  background: string,
  text: string,
  muted: string,
  blue: string,
  cyan: string,
  green: string,
  yellow: string,
  orange: string,
  red: string,
  pink: string,
  purple: string,
];
function palette(name: PaletteName, appearance: Palette["appearance"], values: Colors): Palette {
  const [background, text, muted, blue, cyan, green, yellow, orange, red, pink, purple] = values;
  return {
    name,
    appearance,
    colors: {
      background,
      text,
      muted,
      border: muted,
      accent: blue,
      success: green,
      warning: orange,
      error: red,
      "accent.blue": blue,
      "accent.cyan": cyan,
      "accent.green": green,
      "accent.yellow": yellow,
      "accent.orange": orange,
      "accent.red": red,
      "accent.pink": pink,
      "accent.purple": purple,
    },
  };
}
export const palettes: Readonly<Record<PaletteName, Palette>> = {
  pinata: palette("pinata", "dark", [
    "#151321",
    "#f3edf9",
    "#aaa0ba",
    "#8fb8ff",
    "#72d9d0",
    "#a6d98b",
    "#f4d77e",
    "#efa37a",
    "#f38898",
    "#f69ec7",
    "#c2a1f4",
  ]),
  "catppuccin-mocha": palette("catppuccin-mocha", "dark", [
    "#1e1e2e",
    "#cdd6f4",
    "#a6adc8",
    "#89b4fa",
    "#94e2d5",
    "#a6e3a1",
    "#f9e2af",
    "#fab387",
    "#f38ba8",
    "#f5c2e7",
    "#cba6f7",
  ]),
  "catppuccin-latte": palette("catppuccin-latte", "light", [
    "#eff1f5",
    "#4c4f69",
    "#66697f",
    "#1e66f5",
    "#179299",
    "#327f22",
    "#8f6000",
    "#bf5900",
    "#d20f39",
    "#b72db1",
    "#8839ef",
  ]),
  "gruvbox-dark": palette("gruvbox-dark", "dark", [
    "#282828",
    "#ebdbb2",
    "#a89984",
    "#83a598",
    "#8ec07c",
    "#b8bb26",
    "#fabd2f",
    "#fe8019",
    "#fb4934",
    "#d3869b",
    "#d3869b",
  ]),
  "gruvbox-light": palette("gruvbox-light", "light", [
    "#fbf1c7",
    "#3c3836",
    "#665c54",
    "#076678",
    "#427b58",
    "#79740e",
    "#946600",
    "#af3a03",
    "#9d0006",
    "#8f3f71",
    "#8f3f71",
  ]),
  "tokyo-night-night": palette("tokyo-night-night", "dark", [
    "#1a1b26",
    "#c0caf5",
    "#9aa5ce",
    "#7aa2f7",
    "#7dcfff",
    "#9ece6a",
    "#e0af68",
    "#ff9e64",
    "#f7768e",
    "#ff75a0",
    "#bb9af7",
  ]),
  "rose-pine-main": palette("rose-pine-main", "dark", [
    "#191724",
    "#e0def4",
    "#9d99b8",
    "#9ccfd8",
    "#9ccfd8",
    "#a3be8c",
    "#f6c177",
    "#ebbcba",
    "#eb6f92",
    "#ebbcba",
    "#c4a7e7",
  ]),
  "rose-pine-dawn": palette("rose-pine-dawn", "light", [
    "#faf4ed",
    "#575279",
    "#706b89",
    "#286983",
    "#286983",
    "#52735f",
    "#986b00",
    "#a45b50",
    "#b4637a",
    "#a45b50",
    "#907aa9",
  ]),
  dracula: palette("dracula", "dark", [
    "#282a36",
    "#f8f8f2",
    "#a4acc4",
    "#8be9fd",
    "#8be9fd",
    "#50fa7b",
    "#f1fa8c",
    "#ffb86c",
    "#ff5555",
    "#ff79c6",
    "#bd93f9",
  ]),
  nord: palette("nord", "dark", [
    "#2e3440",
    "#eceff4",
    "#a5b0c4",
    "#81a1c1",
    "#88c0d0",
    "#a3be8c",
    "#ebcb8b",
    "#d08770",
    "#e28c92",
    "#cba0ba",
    "#b48ead",
  ]),
  "one-dark": palette("one-dark", "dark", [
    "#282c34",
    "#abb2bf",
    "#929aa8",
    "#61afef",
    "#56b6c2",
    "#98c379",
    "#e5c07b",
    "#d19a66",
    "#e06c75",
    "#e78ac3",
    "#c678dd",
  ]),
  "one-light": palette("one-light", "light", [
    "#fafafa",
    "#383a42",
    "#696c77",
    "#4078f2",
    "#0184bc",
    "#507b20",
    "#936900",
    "#986801",
    "#c6313d",
    "#a626a4",
    "#a626a4",
  ]),
  "solarized-dark": palette("solarized-dark", "dark", [
    "#002b36",
    "#93a1a1",
    "#839496",
    "#268bd2",
    "#2aa198",
    "#9aa900",
    "#d1a400",
    "#ef8747",
    "#ef7878",
    "#d9719e",
    "#a69ce8",
  ]),
  "solarized-light": palette("solarized-light", "light", [
    "#fdf6e3",
    "#586e75",
    "#5c7179",
    "#176fa7",
    "#147d75",
    "#707800",
    "#886700",
    "#b24e14",
    "#c52e2e",
    "#b5266b",
    "#5d60b8",
  ]),
  inherit: palette("inherit", "dark", [
    "#171717",
    "#eeeeee",
    "#aaaaaa",
    "#8ab4f8",
    "#8bd5ca",
    "#a6d189",
    "#e5c890",
    "#ef9f76",
    "#e78284",
    "#f4b8e4",
    "#ca9ee6",
  ]),
  "terminal-default": palette("terminal-default", "dark", [
    "#000000",
    "#ffffff",
    "#b0b0b0",
    "#ffffff",
    "#ffffff",
    "#ffffff",
    "#ffffff",
    "#ffffff",
    "#ffffff",
    "#ffffff",
    "#ffffff",
  ]),
};

export type Paint = (token: string, text: string) => string;
export function createPaint(
  name: PaletteName,
  options: {
    enabled?: boolean;
    noColor?: boolean;
    terminal?: string;
    mode?: TerminalColorMode;
    inherit?: (token: SemanticToken, text: string) => string;
  } = {},
): Paint {
  if (
    options.enabled === false ||
    options.noColor ||
    options.terminal === "dumb" ||
    name === "terminal-default"
  )
    return (_token, text) => text;
  return (token, text) => {
    if (token === "focus") return `\u001b[1;7m${text}\u001b[27;22m`;
    if (token === "strong") return `\u001b[1m${text}\u001b[22m`;
    if (token === "background") {
      if (name === "inherit") return text;
      const colors = palettes[name].colors;
      const foreground = foregroundAnsi(parseColor(colors.text), options.mode ?? "truecolor");
      const background = backgroundAnsi(parseColor(colors.background), options.mode ?? "truecolor");
      return `${background}${foreground}${text.replaceAll("\u001b[39m", foreground).replaceAll("\u001b[49m", background)}\u001b[39m\u001b[49m`;
    }
    if (name === "inherit" && options.inherit && !token.startsWith("#"))
      return options.inherit(token as SemanticToken, text);
    const color = token.startsWith("#")
      ? token
      : (palettes[name].colors[token as SemanticToken] ?? palettes[name].colors.accent);
    return `${foregroundAnsi(parseColor(color), options.mode ?? "truecolor")}${text}\u001b[39m`;
  };
}

export function agentAccent(name: string): SemanticToken {
  const accents: SemanticToken[] = [
    "accent.blue",
    "accent.cyan",
    "accent.green",
    "accent.yellow",
    "accent.orange",
    "accent.red",
    "accent.pink",
    "accent.purple",
  ];
  let hash = 0;
  for (const character of name) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  return accents[hash % accents.length];
}
