import { once } from "node:events";
import { digestValue } from "../../../engine/contracts/digest.ts";
import { DurableStore, inspectStore, reconcileStore } from "../../../engine/storage/index.ts";

const [mode, directory, crashAt] = process.argv.slice(2);
if (!mode || !directory) throw new Error("Expected mode and store directory");

const manifest = {
  schemaVersion: 1 as const,
  run: "storage-run",
  workspace: directory,
  store: directory,
  createdAt: "2026-11-08T00:00:00.000Z",
};
const transition = {
  kind: "effect_intent" as const,
  effect: {
    id: "prepare-base",
    ref: { run: manifest.run, worker: "base", assignment: 1 },
    kind: "prepare" as const,
  },
};
const entry = {
  requestId: "prepare-request",
  payloadDigest: digestValue(transition),
  transition,
};

async function fault(point: string): Promise<void> {
  if (point !== crashAt) return;
  process.send?.({ phase: "boundary", point });
  await once(process, "message");
}

process.send?.({ phase: "ready" });
await once(process, "message");
try {
  if (mode === "inspect") {
    const inspection = await inspectStore(directory);
    process.send?.({ phase: "inspected", frames: inspection.frames, tail: inspection.tail.length });
  } else if (mode === "reconcile") {
    const inspection = await inspectStore(directory);
    if (!inspection.owner) throw new Error("Expected retained owner");
    const reconciliation = await reconcileStore({
      directory,
      expectedOwnerToken: inspection.owner.token,
      reason: "explicit child fixture recovery",
      isolateTornTail: true,
      fault,
    });
    process.send?.({ phase: "receipt", reconciliation });
  } else {
    const store = await DurableStore.open({
      directory,
      manifest,
      fault,
    });
    process.send?.({ phase: "claimed", pid: process.pid });
    if (mode === "append" || mode === "retry") {
      const frame = await store.append(entry);
      process.send?.({ phase: "receipt", frame });
    }
    if (mode === "artifact") {
      const artifact = await store.putArtifact(Buffer.from("immutable fixture artifact"));
      process.send?.({ phase: "receipt", artifact });
    }
    if (mode !== "retry") await once(process, "message");
    await store.close();
  }
} catch (error) {
  process.send?.({
    phase: "rejected",
    code: error !== null && typeof error === "object" && "code" in error ? error.code : null,
    message: error instanceof Error ? error.message : String(error),
  });
}
process.disconnect?.();
