import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, type Component } from "@earendil-works/pi-tui";
import { exportSchemas, schemaRegistry } from "../contracts/schemas.ts";
import { namePicker } from "../ui/name-picker.ts";
import { fit } from "../ui/text.ts";

const names = Object.keys(schemaRegistry).sort();

function schemaPage(name: string, height: () => number, back: () => void): Component {
  const content = new Text(JSON.stringify(exportSchemas(name)[name], null, 2), 0, 0);
  let offset = 0;
  let total = 0;
  const page = () => Math.max(1, height() - 2);
  function scroll(position: number) {
    offset = Math.max(0, Math.min(position, total - page()));
  }
  return {
    capturesViewportInput: true,
    invalidate() {
      content.invalidate();
    },
    render(width) {
      const rows = content.render(width);
      total = rows.length;
      scroll(offset);
      return [
        fit(name, width),
        ...rows.slice(offset, offset + page()),
        fit(
          `Lines ${offset + 1}–${Math.min(total, offset + page())} of ${total} · ↑↓ scroll · PgUp/PgDn page · Esc back`,
          width,
        ),
      ].slice(0, height());
    },
    handleInput(key) {
      if (matchesKey(key, "escape") || key === "q") back();
      else if (matchesKey(key, "up")) scroll(offset - 1);
      else if (matchesKey(key, "down")) scroll(offset + 1);
      else if (matchesKey(key, "pageUp")) scroll(offset - page());
      else if (matchesKey(key, "pageDown")) scroll(offset + page());
      else if (matchesKey(key, "home")) scroll(0);
      else if (matchesKey(key, "end")) scroll(total);
    },
    handleMouse(event) {
      if (event.type !== "wheel") return undefined;
      scroll(offset + (event.wheelDelta ?? 0));
      return { handled: true, render: true };
    },
  };
}

async function inspectSchema(args: string, context: ExtensionContext): Promise<void> {
  const name = args.trim();
  if (name && !Object.hasOwn(schemaRegistry, name)) {
    context.ui.notify("Unknown schema. Use /pinata-schema to browse available names.", "error");
    return;
  }
  if (context.mode !== "tui") {
    context.ui.notify(
      name ? `Read ${name} with pinata schema ${name} --json` : names.join("\n"),
      "info",
    );
    return;
  }
  await context.ui.custom<void>(
    (tui, _theme, _keys, done) => {
      const height = () => tui.terminal.rows;
      let page: Component | undefined;
      const open = (value: string) => {
        page = schemaPage(value, height, () => {
          if (name) done();
          else page = undefined;
        });
      };
      const index = namePicker({
        title: "Piñata schemas",
        names,
        height,
        done: (value) => (value ? open(value) : done()),
      });
      if (name) open(name);
      return {
        capturesViewportInput: true,
        invalidate() {
          (page ?? index).invalidate();
        },
        render: (width) => (page ?? index).render(width),
        handleInput(key) {
          (page ?? index).handleInput?.(key);
          tui.requestRender();
        },
        handleMouse: (event) => (page ?? index).handleMouse?.(event),
      };
    },
    { overlay: true, overlayOptions: { width: "90%", maxHeight: "100%" } },
  );
}

export function registerSchemaCommand(pi: ExtensionAPI): void {
  pi.registerCommand("pinata-schema", {
    description: "Browse Piñata's data formats.",
    getArgumentCompletions: (prefix) =>
      prefix
        ? names
            .filter((name) => name.includes(prefix) && name !== prefix)
            .map((name) => ({ value: name, label: name }))
        : null,
    handler: inspectSchema,
  });
}
