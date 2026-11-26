import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import type { RuntimeSource } from "../sources/runtime.ts";
import { matchingRuns, parseMention } from "./mentions.ts";

type MentionFleet = {
  current: RuntimeSource;
  workers: ReadonlyMap<RuntimeSource, ReadonlySet<string>>;
};

export function mentionAutocomplete(
  base: AutocompleteProvider,
  fleet: () => MentionFleet | undefined,
): AutocompleteProvider {
  const addresses = new WeakSet<AutocompleteItem>();
  let previous: { source: RuntimeSource; prefix: string; names: string[] } | undefined;

  async function definitionNames(source: RuntimeSource, prefix: string, signal: AbortSignal) {
    // Narrow the open menu without rereading every agent file for each character.
    if (
      previous?.source === source &&
      prefix !== previous.prefix &&
      prefix.startsWith(previous.prefix)
    ) {
      previous.prefix = prefix;
      return previous.names;
    }
    previous = undefined;
    const reply = await source.request({ method: "query", input: { kind: "definitions" } }, signal);
    if (
      reply.status !== "ok" ||
      reply.response.method !== "query" ||
      reply.response.result.kind !== "definitions"
    )
      return [];
    const names = reply.response.result.definitions.map(({ definition }) => definition.name);
    if (!signal.aborted) previous = { source, prefix, names };
    return names;
  }

  return {
    triggerCharacters: base.triggerCharacters,
    async getSuggestions(lines, line, col, options) {
      const hostSuggestions = base.getSuggestions(lines, line, col, options);
      const firstLine = lines[0] ?? "";
      if (line !== 0 || /^\S/.test(firstLine.slice(col))) return hostSuggestions;
      const prefix = firstLine.slice(0, col);
      const match = /^@(?:([A-Za-z0-9._-]+):)?((?:[a-z][a-z0-9-]{0,31})?)$/.exec(prefix);
      if (!match || options.signal.aborted) return hostSuggestions;
      const visible = fleet();
      if (!visible) return hostSuggestions;
      const [, selector, partial] = match;
      const runs = matchingRuns([...visible.workers.keys()], selector);
      const target = selector ? runs[0] : visible.current;
      if (!target || (selector && runs.length !== 1)) return hostSuggestions;
      const [host, names] = await Promise.all([
        hostSuggestions,
        definitionNames(target, prefix, options.signal),
      ]);
      if (options.signal.aborted) return null;
      const workers = new Map<string, RuntimeSource[]>();
      for (const run of runs) {
        for (const name of visible.workers.get(run) ?? []) {
          if (name.startsWith(partial)) workers.set(name, [...(workers.get(name) ?? []), run]);
        }
      }
      const items: AutocompleteItem[] = [];
      function add(value: string, description: string) {
        const item = { value, label: value, description };
        items.push(item);
        addresses.add(item);
      }
      for (const [name, owners] of workers) {
        for (const owner of owners) {
          const qualifier =
            selector ?? (owners.length > 1 && owner !== visible.current ? owner.run : undefined);
          const value = qualifier ? `@${qualifier}:${name}` : `@${name}`;
          if (parseMention(value)) add(value, "Piñata worker");
        }
      }
      for (const name of names) {
        if (!workers.has(name) && name.startsWith(partial))
          add(selector ? `@${selector}:${name}` : `@${name}`, "Piñata agent");
      }
      if (!items.length) return host;
      items.sort((a, b) => a.value.localeCompare(b.value));
      return { prefix: host?.prefix ?? prefix, items: [...items, ...(host?.items ?? [])] };
    },
    applyCompletion(lines, line, col, item, prefix) {
      if (!addresses.has(item)) {
        // Pi can offer a root file with exactly the same spelling as an agent.
        // Qualify that file so the input router still sees a path on submission.
        if (
          line === 0 &&
          lines[0].slice(0, col) === prefix &&
          item.value === "@" + item.label &&
          item.description === item.label &&
          parseMention(item.value)
        )
          return base.applyCompletion(
            lines,
            line,
            col,
            { ...item, value: "@./" + item.label },
            prefix,
          );
        return base.applyCompletion(lines, line, col, item, prefix);
      }
      const after = lines[line].slice(col);
      const rest = /^\s/.test(after) ? after : " " + after;
      return {
        lines: [item.value + rest, ...lines.slice(1)],
        cursorLine: line,
        cursorCol: item.value.length + 1,
      };
    },
    shouldTriggerFileCompletion: base.shouldTriggerFileCompletion?.bind(base),
  };
}
