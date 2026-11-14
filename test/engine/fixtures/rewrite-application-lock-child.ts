import { ApplicationLock } from "../../../engine/application/lock.ts";
import { claimOwner } from "../../../engine/storage/owner.ts";

const root = process.argv[2];
if (!root) throw new Error("Missing checkout");
const lock = await ApplicationLock.open(root);
if (process.argv[3] === "before-operation") {
  await claimOwner(lock.directory);
  process.exit(85);
}
await lock.acquire({ operationId: "child-handoff", ownerEpoch: "child", purpose: "apply" });
process.send?.({ ready: true });
process.once("message", () => process.exit(85));
