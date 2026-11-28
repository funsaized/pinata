import { Input, SelectList, type Component } from "@earendil-works/pi-tui";
import { fit } from "./text.ts";

// Shared by Pi's command overlay and the standalone conversation viewer.
export function namePicker(options: {
  title: string;
  names: readonly string[];
  current?: string;
  height(): number;
  done(name?: string): void;
}): Component {
  const search = new Input({ prompt: "Filter: " });
  search.focused = true;
  const plain = (text: string) => text;
  const visibleRows = () => Math.max(1, Math.min(16, options.height() - 4));
  let pageSize = 0;
  function choices(selected?: string) {
    pageSize = visibleRows();
    const query = search.getValue().trim().toLowerCase();
    const items = options.names
      .filter((name) => name.includes(query))
      .map((name) => ({
        value: name,
        label: name,
        description: name === options.current ? "current" : undefined,
      }));
    const list = new SelectList(
      items,
      pageSize,
      {
        selectedPrefix: plain,
        selectedText: plain,
        description: plain,
        scrollInfo: plain,
        noMatch: () => "No matches",
      },
      { maxPrimaryColumnWidth: 60 },
    );
    list.setSelectedIndex(
      Math.max(
        0,
        items.findIndex((item) => item.value === selected),
      ),
    );
    list.onSelect = (item) => options.done(item.value);
    list.onCancel = () => options.done();
    return list;
  }
  let list = choices(options.current);
  return {
    capturesViewportInput: true,
    invalidate() {
      search.invalidate();
      list.invalidate();
    },
    render(width) {
      if (pageSize !== visibleRows()) list = choices(list.getSelectedItem()?.value);
      return [
        options.title,
        ...search.render(width),
        ...list.render(width),
        "↑↓ select · Enter choose · Esc back",
      ]
        .slice(0, options.height())
        .map((row) => fit(row, width));
    },
    handleInput(data) {
      const before = search.getValue();
      search.handleInput(data);
      if (before === search.getValue()) list.handleInput(data);
      else list = choices();
    },
    handleMouse(event) {
      if (event.y === 1) return search.handleMouse({ ...event, y: 0 });
      if (event.y >= 2) return list.handleMouse({ ...event, y: event.y - 2 });
      return undefined;
    },
  };
}
