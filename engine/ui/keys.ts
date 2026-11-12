import type { KeyId, KeybindingsManager } from "@earendil-works/pi-tui";

const defaults = {
  openFleet: "shift+down",
  parentScreen: "shift+up",
  previousScreen: "ctrl+left",
  nextScreen: "ctrl+right",
  previousWorker: "shift+left",
  nextWorker: "shift+right",
  previousAssignment: "alt+left",
  nextAssignment: "alt+right",
  stop: "ctrl+x",
  background: "ctrl+b",
  recover: "ctrl+r",
  refresh: "ctrl+l",
  scrollUp: "alt+pageUp",
  scrollDown: "alt+pageDown",
  expandTools: "ctrl+o",
  toggleThinking: "ctrl+t",
} as const;
export type UiKeys = Record<keyof typeof defaults, KeyId>;
export type ConversationKeys = { expandTools: KeyId[]; toggleThinking: KeyId[] };

export function resolveConversationKeys(
  config: Record<string, string>,
  host?: Pick<KeybindingsManager, "getKeys">,
): ConversationKeys {
  const keys = resolveKeys(config);
  return {
    expandTools:
      host && !Object.hasOwn(config, "expandTools")
        ? host.getKeys("app.tools.expand")
        : [keys.expandTools],
    toggleThinking:
      host && !Object.hasOwn(config, "toggleThinking")
        ? host.getKeys("app.thinking.toggle")
        : [keys.toggleThinking],
  };
}
export function resolveKeys(config: Record<string, string>): UiKeys {
  const keys = { ...defaults } as UiKeys;
  for (const [name, key] of Object.entries(config)) {
    if (!Object.hasOwn(defaults, name)) throw new Error(`Unknown Pinata key action: ${name}`);
    if (
      !/^(?:(?:ctrl|alt|shift|super)\+)*(?:[a-z0-9]|left|right|up|down|enter|escape|tab|space|pageUp|pageDown|home|end|f(?:[1-9]|1[0-2]))$/.test(
        key,
      )
    )
      throw new Error(`Invalid Pinata key: ${key}`);
    if (
      [
        "escape",
        "enter",
        "tab",
        "up",
        "down",
        "left",
        "right",
        "q",
        "h",
        "w",
        "f",
        "a",
        "d",
        "m",
        "space",
        "home",
        "end",
        "pageUp",
        "pageDown",
        "shift+enter",
        "ctrl+enter",
      ].includes(key)
    )
      throw new Error(`Pinata key is reserved by navigation: ${key}`);
    if (/^(?:shift\+)?(?:[a-z0-9]|space)$/.test(key))
      throw new Error(
        `Pinata shortcut would intercept message text: ${key}; use a modifier or function key`,
      );
    keys[name as keyof UiKeys] = key as KeyId;
  }
  if (new Set(Object.values(keys)).size !== Object.values(keys).length)
    throw new Error("Pinata key actions must use distinct shortcuts");
  return keys;
}
