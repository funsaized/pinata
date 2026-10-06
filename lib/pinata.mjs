#!/usr/bin/env node
// Public API and CLI entry point. Implementation lives in the sibling modules.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./cli.mjs";

export { config } from "./config.mjs";
export { doctor, resources } from "./preflight.mjs";
export { init, summary } from "./run.mjs";
export { tick, wait, add, barrier, repair, retryLaunch, cancel } from "./schedule.mjs";
export { integrate, rollback } from "./integrate.mjs";
export { cleanup, unlock } from "./cleanup.mjs";
export { gc } from "./gc.mjs";
export { start } from "./background.mjs";
export { progress, history } from "./progress.mjs";
export { HELP } from "./cli.mjs";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((e) => {
    console.error(JSON.stringify({ error: e.message }));
    process.exitCode = 1;
  });
