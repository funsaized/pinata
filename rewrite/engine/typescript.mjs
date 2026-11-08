import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";

// Native stripping excludes node_modules. Every replacement-engine entry and
// owned Node helper installs this package-scoped loader before importing .ts;
// dependencies and caller-provided programs keep their own loader behavior.
const engine = new URL("./", import.meta.url).href;
export const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith(engine) || !url.endsWith(".ts")) return nextLoad(url, context);
    return {
      format: "module",
      source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { sourceUrl: url }),
      shortCircuit: true,
    };
  },
});
