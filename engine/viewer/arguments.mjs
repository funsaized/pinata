// Shared public grammar; plain JavaScript also runs from an installed npm package.
/** @typedef {{ run?: string, task?: string, external?: boolean }} ViewArgs */

export const VIEW_ARGS = "[run] [--task <task>]";

// Slash commands need the same quoted paths that the shell passes as one CLI argument.
/** @param {string} input @returns {string[]} */
export function commandWords(input) {
  const words = [];
  let word = "",
    quote = "",
    started = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = "";
      else if (ch === "\\" && input[i + 1] === quote) word += input[++i];
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += ch;
      started = true;
    }
  }
  if (quote) throw new Error("Unclosed quote in command");
  if (started) words.push(word);
  return words;
}

/** @param {string[]} args @param {boolean} [external] @returns {ViewArgs} */
export function parseViewArgs(args, external = false) {
  /** @type {ViewArgs} */
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--task") {
      if (result.task !== undefined) throw new Error("Use --task only once");
      const task = args[++i];
      if (!task || task.startsWith("--")) throw new Error("--task requires a task ID");
      result.task = task;
    } else if (arg === "--external" && external) {
      if (result.external) throw new Error("Use --external only once");
      result.external = true;
    } else if (arg.startsWith("-")) {
      throw new Error(
        `Unknown option ${arg}. Usage: ${VIEW_ARGS}${external ? " [--external]" : ""}`,
      );
    } else if (result.run !== undefined) {
      throw new Error(`Unexpected argument ${arg}. Select a conversation with --task <task>.`);
    } else if (!arg) throw new Error("Run cannot be empty");
    else result.run = arg;
  }
  return result;
}
