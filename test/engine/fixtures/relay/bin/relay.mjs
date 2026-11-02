#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { parseEvents } from "../src/parse.mjs";
import { renderReport } from "../src/render.mjs";
import { summarize } from "../src/summarize.mjs";

const inputPaths = process.argv.slice(2);

if (inputPaths.length !== 1) {
  console.error("Usage: relay <input-file>");
  process.exitCode = 2;
} else {
  const inputPath = inputPaths[0];
  let input;

  try {
    input = await readFile(inputPath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`relay: cannot read ${JSON.stringify(inputPath)}: ${detail}`);
    process.exitCode = 2;
  }

  if (input !== undefined) {
    const { events, errors } = parseEvents(input);
    const summary = summarize(events);
    process.stdout.write(renderReport(summary, errors));
    process.exitCode = errors.length > 0 ? 1 : 0;
  }
}
