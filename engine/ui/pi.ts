import { piConversationPresentation } from "../pi/conversation.ts";
import {
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, type AutocompleteItem, type Component } from "@earendil-works/pi-tui";
import { canonicalJson, type AssignmentRef, type Config } from "../contracts/index.ts";
import { paletteSchema } from "../contracts/config.ts";
import type { RuntimeSource } from "../sources/runtime.ts";
import { ScreenRouter, type ScreenName } from "./router.ts";
import { PinataScreen, resolveKeys } from "./screen.ts";
import {
  createPaint,
  rainbowText,
  readPalette,
  type Paint,
  type SemanticToken,
} from "./palette.ts";
import { namePicker } from "./name-picker.ts";
import { fleetWidget } from "./render.ts";
import { projectRuns, type ProjectRunCatalog } from "../sources/project.ts";

type UiBinding = {
  session: string;
  router: ScreenRouter;
  context: ExtensionContext;
  runs?: ProjectRunCatalog;
};
export type CoordinatorUi = {
  animateReveal(): boolean;
  bind(context: ExtensionContext, source?: RuntimeSource): Promise<ScreenRouter>;
  open(
    context: ExtensionContext,
    screen?: ScreenName,
    ref?: AssignmentRef,
    source?: RuntimeSource,
  ): Promise<void>;
  navigate(screen: ScreenName, ref?: AssignmentRef): void;
  definition(context: ExtensionContext, name: string, source?: RuntimeSource): Promise<void>;
  dispose(context?: ExtensionContext): void;
};
export type CoordinatorUiOptions = {
  settings?(context: ExtensionContext, source: RuntimeSource): Partial<Config["ui"]> | undefined;
  mode?(context: ExtensionContext, source: RuntimeSource): Config["mode"] | undefined;
  runs?(context: ExtensionContext, source: RuntimeSource): ProjectRunCatalog | undefined;
};

function inherit(theme: Theme, token: SemanticToken, text: string): string {
  switch (token) {
    case "selection":
      return theme.bg("selectedBg", text);
    case "accent.blue":
      return theme.fg("syntaxFunction", text);
    case "accent.cyan":
      return theme.fg("syntaxType", text);
    case "accent.green":
      return theme.fg("success", text);
    case "accent.yellow":
      return theme.fg("syntaxString", text);
    case "accent.orange":
      return theme.fg("warning", text);
    case "accent.red":
      return theme.fg("error", text);
    case "accent.pink":
      return theme.fg("syntaxKeyword", text);
    case "accent.purple":
      return theme.fg("syntaxNumber", text);
    case "text":
      return theme.fg("text", text);
    case "muted":
      return theme.fg("muted", text);
    case "border":
      return theme.fg("border", text);
    case "success":
      return theme.fg("success", text);
    case "warning":
      return theme.fg("warning", text);
    case "error":
      return theme.fg("error", text);
    default:
      return theme.fg("accent", text);
  }
}
function paint(binding: UiBinding): Paint {
  const theme = binding.context.ui.theme;
  return createPaint(binding.router.palette, {
    noColor: Object.hasOwn(process.env, "NO_COLOR"),
    terminal: process.env.TERM,
    mode: theme?.getColorMode(),
    inherit: theme ? (token, text) => inherit(theme, token, text) : undefined,
  });
}

function paletteNames(prefix: string, command = ""): AutocompleteItem[] | null {
  if (!prefix) return null;
  return paletteSchema.options
    .filter((name) => name.startsWith(prefix) && name !== prefix)
    .map((name) => ({ value: command + name, label: name }));
}

async function choosePalette(
  context: ExtensionContext,
  router: ScreenRouter,
  argument: string,
): Promise<void> {
  let name: string | undefined = argument;
  if (!name) {
    if (context.mode !== "tui") {
      context.ui.notify(
        `Current palette: ${router.palette}. Choose with /pinata palette <name>. Available: ${paletteSchema.options.join(", ")}`,
        "info",
      );
      return;
    }
    name = await context.ui.custom<string | undefined>(
      (tui, _theme, _keys, done) =>
        namePicker({
          title: "Piñata palette",
          names: paletteSchema.options,
          current: router.palette,
          height: () => tui.terminal.rows,
          done,
        }),
      { overlay: true, overlayOptions: { width: "70%", maxHeight: "100%" } },
    );
    if (!name) return;
  }
  router.setPalette(readPalette(name, "/pinata palette"));
  context.ui.notify(`Pinata palette: ${router.palette}`, "info");
}

export function installCoordinatorUi(
  pi: ExtensionAPI,
  sourceProvider: (context: ExtensionContext) => Promise<RuntimeSource>,
  options: CoordinatorUiOptions = {},
): CoordinatorUi {
  const bindings = new Map<string, UiBinding>();
  let animateReveal: (() => boolean) | undefined;
  let selected: UiBinding | undefined;
  let closeScreen: (() => void) | undefined;
  let opening: Promise<void> | undefined;
  let openedRouter: ScreenRouter | undefined;
  let terminalInput: (() => void) | undefined;
  const errors = (context: ExtensionContext, error: unknown) =>
    context.ui.notify(error instanceof Error ? error.message : String(error), "error");
  const hint = (
    context: ExtensionContext,
    visible: boolean,
    keys: Record<string, string> = {},
  ): void => {
    const shortcutPaint = createPaint("pinata", {
      noColor: Object.hasOwn(process.env, "NO_COLOR"),
      terminal: process.env.TERM,
      mode: context.ui.theme?.getColorMode(),
    });
    const shortcut = resolveKeys(keys)
      .openFleet.split("+")
      .map((key) => (key === "down" ? "↓" : key.charAt(0).toUpperCase() + key.slice(1)))
      .join(" + ");
    if (context.mode === "tui")
      context.ui.setStatus?.(
        "pinata.shortcut",
        visible ? `🤖 ${rainbowText(shortcut, shortcutPaint)}` : undefined,
      );
  };
  const widget = (binding: UiBinding): void => {
    if (binding.context.mode !== "tui") return;
    hint(binding.context, true, binding.router.keys);
    binding.context.ui.setWidget("pinata.fleet.v1", (tui): Component & { dispose(): void } => {
      // Pi gives message renderers no render handle. Share this widget's redraw
      // while it is mounted, and cancel the short reveal when the widget closes.
      let timers: NodeJS.Timeout[] = [];
      const reveal = () => {
        if (binding.router.motion !== "full") return false;
        for (const timer of timers) clearTimeout(timer);
        timers = [65, 130].map((delay) => setTimeout(() => tui.requestRender(), delay).unref());
        return true;
      };
      animateReveal = reveal;
      const unsubscribe = binding.router.onChange(() => tui.requestRender());
      return {
        render: (width) =>
          fleetWidget(binding.router.state, {
            width,
            paint: paint(binding),
            mode: binding.router.mode,
            motion: binding.router.motion,
            completions: binding.router.source.capabilities.live
              ? binding.router.completions
              : undefined,
            activity: binding.router.activity,
            elapsed: (ref) => binding.router.observedElapsed(ref),
            ascii: process.env.TERM === "dumb" || process.env.PINATA_ASCII === "1",
          }),
        invalidate() {},
        dispose() {
          unsubscribe();
          for (const timer of timers) clearTimeout(timer);
          if (animateReveal === reveal) animateReveal = undefined;
        },
      };
    });
  };
  const api: CoordinatorUi = {
    animateReveal: () => animateReveal?.() ?? false,
    async bind(context, source) {
      const resolved = source ?? (await sourceProvider(context));
      const session = context.sessionManager.getSessionId();
      const key = `${session}/${resolved.location?.directory ?? resolved.run}`;
      let binding = bindings.get(key);
      if (!binding) {
        const router = new ScreenRouter(resolved, {
          ui: options.settings?.(context, resolved),
          mode: options.mode?.(context, resolved),
          project: resolved.location?.workspace ?? context.cwd,
          accepted(receipt, messageId) {
            pi.sendMessage(
              {
                customType: "pinata.control.v1",
                content: canonicalJson({
                  assignments: receipt.assignments,
                  requestId: receipt.requestId,
                  ...(messageId ? { messageId } : {}),
                }),
                display: true,
                details: receipt,
              },
              { triggerTurn: false },
            );
          },
        });
        binding = {
          session,
          router,
          context,
          runs:
            options.runs?.(context, resolved) ??
            (resolved.location
              ? projectRuns(resolved.location.workspace, () =>
                  [...bindings.values()]
                    .filter((binding) => binding.session === session)
                    .map((binding) => binding.router.source),
                )
              : undefined),
        };
        bindings.set(key, binding);
        await router.start();
      }
      binding.context = context;
      if (selected !== binding) {
        selected = binding;
        widget(binding);
      }
      return binding.router;
    },
    async open(context, screen = "fleet", ref, source) {
      if (context.mode !== "tui") {
        context.ui.notify(
          "Pinata screens require a terminal. Use pinata_status or the JSON CLI in this mode.",
          "info",
        );
        return;
      }
      context.ui.setStatus?.("pinata.opening", "Opening fleet…");
      let router: ScreenRouter;
      try {
        router = await api.bind(context, source);
      } finally {
        context.ui.setStatus?.("pinata.opening", undefined);
      }
      if (!router.navigate(screen, ref)) {
        context.ui.notify(router.notice, "error");
        return;
      }
      if (screen === "main") {
        closeScreen?.();
        return;
      }
      if (opening && openedRouter !== router) {
        closeScreen?.();
        await opening;
      }
      if (opening) return opening;
      const parentDraft = context.ui.getEditorText();
      const binding = selected;
      if (!binding) return;
      binding.context.ui.setWidget("pinata.fleet.v1", undefined);
      hint(binding.context, false);
      openedRouter = router;
      opening = (async () => {
        try {
          await context.ui.custom<void>(
            (tui, _theme, keys, done) => {
              closeScreen = () => done();
              const settings = SettingsManager.create(context.cwd, undefined, {
                projectTrusted: context.isProjectTrusted?.() ?? false,
              });
              router.expandedTools = context.ui.getToolsExpanded?.() ?? false;
              router.showThinking = !settings.getHideThinkingBlock();
              return new PinataScreen({
                tui,
                router,
                keybindings: keys,
                main: () => done(),
                paint: () => paint(binding),
                presentation: () => {
                  if (
                    !binding.context.ui.theme ||
                    router.palette === "terminal-default" ||
                    process.env.TERM === "dumb" ||
                    Object.hasOwn(process.env, "NO_COLOR")
                  )
                    return undefined;
                  return piConversationPresentation(binding.context.ui.theme, {
                    outputPad: settings.getOutputPad(),
                    codeBlockIndent: settings.getCodeBlockIndent(),
                  });
                },
                ascii: process.env.TERM === "dumb" || process.env.PINATA_ASCII === "1",
                error: (error) => errors(context, error),
                runs: binding.runs,
                openRun: (source) => api.open(context, "fleet", undefined, source),
              });
            },
            {
              overlay: true,
              overlayOptions: {
                width: "100%",
                maxHeight: "100%",
                anchor: "top-left",
                row: 0,
                col: 0,
                margin: 0,
              },
            },
          );
        } finally {
          closeScreen = undefined;
          opening = undefined;
          openedRouter = undefined;
          router.navigate("main");
          if (selected === binding) widget(binding);
          context.ui.setEditorText(parentDraft);
        }
      })();
      return opening;
    },
    navigate(screen, ref) {
      selected?.router.navigate(screen, ref);
      if (screen === "main") closeScreen?.();
    },
    async definition(context, name, source) {
      const router = await api.bind(context, source);
      await router.showDefinition(name);
      await api.open(context, "conversation", undefined, source);
    },
    dispose(context) {
      closeScreen?.();
      if (context) hint(context, false);
      const session = context?.sessionManager.getSessionId();
      for (const [key, binding] of bindings) {
        if (session && binding.session !== session) continue;
        hint(binding.context, false);
        binding.router.dispose();
        binding.context.ui.setWidget("pinata.fleet.v1", undefined);
        bindings.delete(key);
        if (selected === binding) selected = undefined;
      }
      if (!context || !bindings.size) {
        terminalInput?.();
        terminalInput = undefined;
      }
    },
  };
  const command = async (args: string, context: ExtensionContext): Promise<void> => {
    try {
      const input = args.trim();
      const action = input.split(/\s+/, 1)[0] || "fleet";
      const argument = input.slice(action.length).trimStart();
      if (action === "help") {
        context.ui.notify(
          [
            "/pinata fleet · /pinata main — open the fleet or return to the coordinator",
            "/pinata conversation <worker> [assignment] [--run <id>] — open a conversation",
            "/pinata palette [name] — browse or select a palette",
            "/pinata-schema [name] — browse data formats",
            "/pinata-new — select a new run",
            "/pinata-grants <json> — set grants for the next run",
            "/pinata-memory inspect|edit|clear — manage worker memory",
            "/pinata-retry <run>:<input-token> — retry an uncertain addressed input",
          ].join("\n"),
          "info",
        );
        return;
      }
      if (action === "main") {
        api.navigate("main");
        return;
      }
      const router = await api.bind(context);
      if (action === "palette" || action === "pallete") {
        await choosePalette(context, router, argument);
        return;
      }
      if (!["fleet", "conversation"].includes(action))
        throw new Error("Unknown Piñata command. Use /pinata help to see the commands.");
      const match = /^(\S+)(?:\s+([1-9]\d*))?(?:\s+--run\s+([\s\S]+))?$/.exec(argument);
      if (argument && !match)
        throw new Error(
          "Use /pinata conversation <worker> [positive assignment number] [--run <id>]",
        );
      const [, worker, ordinal, runArgument] = match ?? [];
      let target = router;
      if (runArgument) {
        const run = runArgument.startsWith('"') ? JSON.parse(runArgument) : runArgument;
        if (typeof run !== "string") throw new Error("Expected a run ID after --run");
        if (run !== router.source.run) {
          const catalog = [...bindings.values()].find((binding) => binding.router === router)?.runs;
          const matches = (await catalog?.list())?.runs.filter((entry) => entry.run === run) ?? [];
          if (!catalog || matches.length !== 1)
            throw new Error(
              matches.length
                ? "Multiple project runs have this ID. Open the project run browser to choose one."
                : "That run is unavailable in this project.",
            );
          target = await api.bind(context, await catalog.open(matches[0]));
        }
      }
      const ref = worker
        ? {
            run: target.state.run,
            worker,
            assignment: ordinal ? Number(ordinal) : target.state.latest[worker],
          }
        : undefined;
      try {
        await api.open(context, action as ScreenName, ref, target.source);
      } finally {
        if (target !== router && selected?.router === target)
          await api.bind(context, router.source);
      }
    } catch (error) {
      errors(context, error);
    }
  };
  pi.registerCommand("pinata", {
    description: "Browse the live fleet and exact worker conversations without a model turn.",
    handler: command,
    getArgumentCompletions: (prefix) => {
      const match = /^palette\s+(\S+)$/.exec(prefix);
      if (match) return paletteNames(match[1], "palette ");
      return ["fleet", "conversation", "main", "palette", "help"]
        .filter((name) => prefix && name.startsWith(prefix) && name !== prefix)
        .map((name) => ({ value: name, label: name }));
    },
  });
  for (const screen of ["main", "fleet", "conversation"] as const)
    pi.registerCommand(`pinata-${screen}`, {
      description: `Open the Pinata ${screen} screen.`,
      handler: (args, context) => command(`${screen} ${args}`, context),
    });
  pi.registerCommand("pinata-palette", {
    description: "Switch the Pinata semantic palette without restarting workers.",
    handler: (args, context) => command(`palette ${args}`, context),
    getArgumentCompletions: (prefix) => paletteNames(prefix),
  });
  pi.on("session_start", (_event, context) => {
    terminalInput?.();
    if (context.mode !== "tui") return;
    hint(context, true, selected?.router.keys);
    terminalInput = context.ui.onTerminalInput((data) => {
      if (opening) return undefined;
      const keys = resolveKeys(selected?.router.keys ?? {});
      if (!matchesKey(data, keys.openFleet)) return undefined;
      void api.open(context, "fleet").catch((error: unknown) => errors(context, error));
      return { consume: true };
    });
  });
  pi.on("session_shutdown", (_event, context) => {
    api.dispose(context);
  });
  return api;
}
