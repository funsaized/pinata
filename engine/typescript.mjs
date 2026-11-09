import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";

// Native stripping excludes node_modules. Every replacement-engine entry and
// owned Node helper installs this package-scoped loader before importing .ts;
// dependencies and caller-provided programs keep their own loader behavior.
// Bun already loads TypeScript and does not implement Node's synchronous hooks.
const engine = new URL("./", import.meta.url).href;
export const hooks = process.versions.bun
  ? undefined
  : nodeModule.registerHooks({
      load(url, context, nextLoad) {
        if (!url.startsWith(engine) || !new URL(url).pathname.endsWith(".ts"))
          return nextLoad(url, context);
        return {
          format: "module",
          source: nodeModule.stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), {
            sourceUrl: url,
          }),
          shortCircuit: true,
        };
      },
    });
