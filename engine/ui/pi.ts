import { piConversationPresentation } from "../pi/conversation.ts";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component } from "@earendil-works/pi-tui";
import { canonicalJson, type AssignmentRef, type Config } from "../contracts/index.ts";
import { paletteSchema } from "../contracts/config.ts";
import type { RuntimeSource } from "../sources/runtime.ts";
import { ScreenRouter, type ScreenName } from "./router.ts";
import { PinataScreen, resolveKeys } from "./screen.ts";
import { createPaint, rainbowText, type Paint, type SemanticToken } from "./palette.ts";
import { fleetWidget } from "./render.ts";

type UiBinding = { session: string; router: ScreenRouter; context: ExtensionContext };
export type CoordinatorUi = {
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
};

function inherit(theme: Theme, token: SemanticToken, text: string): string {
  switch (token) {
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

export function installCoordinatorUi(
  pi: ExtensionAPI,
  sourceProvider: (context: ExtensionContext) => Promise<RuntimeSource>,
  options: CoordinatorUiOptions = {},
): CoordinatorUi {
  const bindings = new Map<string, UiBinding>();
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
      const unsubscribe = binding.router.onChange(() => tui.requestRender());
      return {
        render: (width) =>
          fleetWidget(binding.router.state, {
            width,
            paint: paint(binding),
            mode: binding.router.mode,
            motion: binding.router.motion,
            activity: binding.router.activity,
            elapsed: (ref) => binding.router.observedElapsed(ref),
            ascii: process.env.TERM === "dumb" || process.env.PINATA_ASCII === "1",
          }),
        invalidate() {},
        dispose: unsubscribe,
      };
    });
  };
  const api: CoordinatorUi = {
    async bind(context, source) {
      const resolved = source ?? (await sourceProvider(context));
      const session = context.sessionManager.getSessionId();
      const key = `${session}/${resolved.run}`;
      let binding = bindings.get(key);
      if (!binding) {
        const router = new ScreenRouter(resolved, {
          ui: options.settings?.(context, resolved),
          mode: options.mode?.(context, resolved),
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
        binding = { session, router, context };
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
      router.navigate(screen, ref);
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
                  return piConversationPresentation(binding.context.ui.theme);
                },
                ascii: process.env.TERM === "dumb" || process.env.PINATA_ASCII === "1",
                error: (error) => errors(context, error),
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
      const [action = "fleet", worker, ordinal] = args.trim().split(/\s+/).filter(Boolean);
      if (action === "main") {
        api.navigate("main");
        return;
      }
      const router = await api.bind(context);
      if (action === "palette") {
        router.setPalette(paletteSchema.parse(worker));
        context.ui.notify(`Pinata palette: ${router.palette}`, "info");
        return;
      }
      if (!["fleet", "conversation"].includes(action))
        throw new Error(
          "Use /pinata main, fleet, conversation <worker> [assignment], or palette <name>",
        );
      const ref = worker
        ? {
            run: router.state.run,
            worker,
            assignment: ordinal ? Number(ordinal) : router.state.latest[worker],
          }
        : undefined;
      await api.open(context, action as ScreenName, ref);
    } catch (error) {
      errors(context, error);
    }
  };
  pi.registerCommand("pinata", {
    description: "Browse the live fleet and exact worker conversations without a model turn.",
    handler: command,
  });
  for (const screen of ["main", "fleet", "conversation"] as const)
    pi.registerCommand(`pinata-${screen}`, {
      description: `Open the Pinata ${screen} screen.`,
      handler: (args, context) => command(`${screen} ${args}`, context),
    });
  pi.registerCommand("pinata-palette", {
    description: "Switch the Pinata semantic palette without restarting workers.",
    handler: (args, context) => command(`palette ${args}`, context),
  });
  pi.on("session_start", (_event, context) => {
    terminalInput?.();
    if (context.mode !== "tui") return;
    hint(context, true, selected?.router.keys);
    terminalInput = context.ui.onTerminalInput((data) => {
      if (opening) return undefined;
      const keys = resolveKeys(selected?.router.keys ?? {});
      const fleet = matchesKey(data, keys.openFleet);
      const next = matchesKey(data, keys.nextScreen);
      const previous = matchesKey(data, keys.previousScreen);
      if (!fleet && !next && !previous) return undefined;
      void api
        .open(context, fleet || next ? "fleet" : "conversation")
        .catch((error: unknown) => errors(context, error));
      return { consume: true };
    });
  });
  pi.on("session_shutdown", (_event, context) => {
    api.dispose(context);
  });
  return api;
}
