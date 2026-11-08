// Replace only the external runner with a no-model crash boundary.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.endsWith("/arena/matrix.ts")) return loaded;
    const source = String(loaded.source);
    const needle = 'import { parseAdapterConfig, runArena } from "./runner.ts";';
    assert.equal(source.split(needle).length, 2, "Matrix hook drifted");
    return {
      ...loaded,
      source: source.replace(
        needle,
        `
import { parseAdapterConfig } from "./runner.ts";
async function runArena(options: { out: string }) {
  const directory = join(options.out, "created-before-return");
  mkdirSync(directory);
  writeFileSync(join(directory, "fixture.json"), JSON.stringify({ providerCalls: 0 }));
  process.kill(process.pid, "SIGKILL");
  throw new Error("Crash did not terminate the fixture");
}`,
      ),
    };
  },
});
const config = process.argv[2];
process.argv = [
  process.execPath,
  fileURLToPath(new URL("../../arena/matrix.ts", import.meta.url)),
  config,
  "--allow-external",
];
await import("../../arena/matrix.ts");
