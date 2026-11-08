import { once } from "node:events";
import { openCheckoutGate } from "../../../rewrite/engine/workspace/gate.ts";

const [root, mode] = process.argv.slice(2);
if (!root || !mode) throw new Error("Gate fixture needs a root and mode");
const gate = await openCheckoutGate(
  root,
  mode === "crash-writer"
    ? {
        fault: (point: string) => {
          if (point === "writer.publish.after") process.exit(77);
        },
      }
    : {},
);
const lease =
  mode === "exclusive"
    ? await gate.acquireExclusive({
        operationId: "child-application",
        ownerEpoch: "child-epoch",
        purpose: "apply",
      })
    : await gate.registerWriter({
        ref: { run: "child", worker: "worker", assignment: 1 },
        ownerEpoch: "child-epoch",
      });
if (!process.send) throw new Error("Gate fixture requires an IPC channel");
process.send({ phase: "ready", lease });
await once(process, "message");
if (lease.kind === "exclusive") await gate.releaseExclusive(lease.id);
else
  await gate.releaseWriter(lease.id, {
    status: "stopped",
    ownerEpoch: "child-epoch",
    identities: [],
    evidence: [],
  });
process.disconnect();
