// Pause both real hosts after reading the same record, before either writes its claim.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { once } from "node:events";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { fauxWorld } from "../engine/faux.ts";

registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.endsWith("/engine/pi/host.ts")) return loaded;
    const source = String(loaded.source);
    const needle =
      "async resumeDir(dir: string, ctx: ExtensionContext, settled = false): Promise<RunHandle> {\n    const record = await readRunRecord(dir);";
    assert.equal(source.split(needle).length, 2, "Claim barrier drifted");
    return {
      ...loaded,
      source: source.replace(
        needle,
        `${needle}\nawait new Promise<void>(resolve => { process.send?.({ phase: "read" }); process.once("message", () => resolve()); });`,
      ),
    };
  },
});

test("one independently constructed host resumes the fixture", async (t) => {
  const world = await fauxWorld(t, () => fauxAssistantMessage([fauxText("fixture")]));
  process.env.PI_CODING_AGENT_DIR = world.agentDir;
  const { PinataHost } = await import("../../engine/pi/host.ts");
  const host = new PinataHost({
    getSettings: () => ({}),
    getThinkingLevel: () => "off",
    getAllTools: () => [],
    sendMessage: () => {},
  } as unknown as ExtensionAPI);
  t.after(() => host.shutdown("probe cleanup"));
  const handle = await host.resumeDir(
    process.argv[2],
    {
      cwd: process.argv[3],
      modelRegistry: world.registry,
      model: world.registry.find("faux", "faux-1"),
    } as ExtensionContext,
    true,
  );
  process.send?.({ phase: "claimed", pid: process.pid, run: handle.id });
  await once(process, "message");
  process.disconnect?.();
});
