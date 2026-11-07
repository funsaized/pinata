import { requestJson } from "./api-client.mjs";
import { renderBoard } from "./view.mjs";
export async function mount(doc = document) {
  const board = doc.querySelector("#board"),
    error = doc.querySelector("#error"),
    form = doc.querySelector("#ticket-form"),
    search = doc.querySelector("#search"),
    filter = doc.querySelector("#status-filter");
  const refresh = async () => {
    const data = await requestJson(
      "",
      "GET",
      `/api/tickets?search=${encodeURIComponent(search.value)}&status=${encodeURIComponent(filter.value)}`,
    );
    board.innerHTML = renderBoard(data.tickets);
  };
  const run = (fn) => async (event) => {
    event.preventDefault();
    error.textContent = "";
    try {
      await fn(event);
      await refresh();
    } catch (cause) {
      error.textContent = cause.message;
    }
  };
  form.addEventListener(
    "submit",
    run(async () => {
      const data = new FormData(form);
      await requestJson("", "POST", "/api/tickets", {
        title: data.get("title"),
        assignee: data.get("assignee"),
        priority: Number(data.get("priority")),
      });
      form.reset();
    }),
  );
  board.addEventListener(
    "click",
    run(async (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const card = button.closest("[data-id]"),
        id = card.dataset.id,
        revision = Number(card.dataset.revision);
      if (button.dataset.action === "delete")
        await requestJson("", "DELETE", `/api/tickets/${id}`, { revision });
      else {
        const status = card.querySelector("[data-status]").textContent,
          next = { todo: "doing", doing: "done", done: "todo" }[status];
        await requestJson("", "PATCH", `/api/tickets/${id}`, { revision, patch: { status: next } });
      }
    }),
  );
  search.addEventListener(
    "input",
    run(async () => {}),
  );
  filter.addEventListener(
    "change",
    run(async () => {}),
  );
  try {
    await refresh();
  } catch (cause) {
    error.textContent = cause.message;
  }
}
if (typeof document !== "undefined") await mount();
