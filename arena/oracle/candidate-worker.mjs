import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// This child imports candidate modules and returns observations. It has neither
// the oracle's assertions nor its result channel.
const send = process.send.bind(process);
const exit = process.exit.bind(process);
const apply = Reflect.apply;
const own = Object.hasOwn;
const keys = Object.keys;
const freeze = Object.freeze;
const modules = Object.create(null);
const seen = new WeakSet();
function freezeGraph(value) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const key of keys(value)) freezeGraph(value[key]);
  freeze(value);
}
let ordinal = 0;
let busy = false;
process.on("message", async (message) => {
  if (busy || message?.id !== ++ordinal) exit(2);
  busy = true;
  if (message.kind === "close") {
    send({ kind: "closed", id: message.id }, () => exit(0));
    return;
  }
  if (message.kind !== "call" || !Array.isArray(message.args)) exit(2);
  try {
    freezeGraph(message.args);
    const selected = modules[message.module];
    if (
      !selected ||
      !own(selected, message.method) ||
      typeof selected[message.method] !== "function"
    )
      throw new TypeError("Missing candidate export");
    const value = await apply(selected[message.method], selected, message.args);
    send({ kind: "result", id: message.id, args: message.args, value });
  } catch (error) {
    send({
      kind: "error",
      id: message.id,
      name: String(error?.name ?? "Error").slice(0, 100),
      message: String(error?.message ?? error).slice(0, 1200),
    });
  } finally {
    busy = false;
  }
});
try {
  const root = process.argv[2];
  for (const name of JSON.parse(process.argv[3]))
    modules[name] = await import(pathToFileURL(resolve(root, `${name}.mjs`)).href);
  send({ kind: "ready" });
} catch {
  exit(2);
}
