import { realpath } from "node:fs/promises";
import { type RuntimeApplicationPort } from "../runtime/application.ts";
import { DomainError } from "../contracts/common.ts";
import { ApplicationStore, type ApplicationOptions } from "./index.ts";

// Each host binds this adapter to its own runtime artifact port. It never accepts
// model-supplied artifact readers, owner records, or cleanup process identities.
export function createApplicationPort(
  options: Pick<ApplicationOptions, "fault" | "createGit" | "recoverGit"> = {},
): RuntimeApplicationPort {
  const stores = new Map<string, ApplicationStore>();
  return {
    async execute(intent, { artifacts, signal }) {
      const destination = await realpath(intent.destination);
      if (destination !== intent.destination)
        throw new DomainError(
          "invalid_input",
          "Application destination must be its canonical absolute checkout path",
        );
      let store = stores.get(destination);
      if (!store) {
        store = await ApplicationStore.open({ ...options, destination, artifacts });
        stores.set(destination, store);
      }
      switch (intent.command.kind) {
        case "apply":
          return store.apply({ snapshot: intent.snapshot, operationId: intent.id, signal });
        case "rollback":
          if (!intent.targetOperation)
            throw new DomainError("invalid_input", "Rollback has no recorded target operation");
          return store.rollback(intent.targetOperation, signal, { id: intent.id });
        case "reconcile": {
          const journal = await store.inspect();
          const recorded = journal.operations.find(
            (operation) => operation.id === intent.targetOperation,
          );
          if (recorded && recorded !== journal.operations.at(-1))
            throw new DomainError(
              "conflict",
              "Reconciliation names an earlier destination operation",
            );
          if (!recorded && journal.operations.length)
            throw new DomainError(
              "conflict",
              "Reconciliation target has no destination journal record",
            );
          return store.reconcile(signal);
        }
      }
    },
    async close() {
      const receipts = await Promise.all([...stores.values()].map((store) => store.close()));
      return receipts.every((receipt) => receipt.status === "stopped");
    },
  };
}
