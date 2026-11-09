import { randomUUID } from "node:crypto";
import { type ArtifactPort } from "../contracts/backend.ts";
import {
  applicationReceiptSchema,
  type ApplicationCommand,
  type ApplicationReceipt,
  type ApplicationIntent,
  type ApplicationObservation,
} from "../contracts/application.ts";
import { type CallerAuthority, DomainError } from "../contracts/common.ts";
import { type CommandEnvelope } from "../contracts/commands.ts";
import { canonicalJson, digestValue } from "../contracts/digest.ts";
import { type CommandReceipt } from "../contracts/lifecycle.ts";
import { prepareApplication } from "../core/application.ts";
import { StorageError } from "../storage/io.ts";
import { type ExecutionTransaction } from "./execution.ts";
import { immutable } from "./immutable.ts";

export type RuntimeApplicationPort = {
  execute(
    intent: ApplicationIntent,
    context: { artifacts: ArtifactPort; signal: AbortSignal },
  ): Promise<ApplicationReceipt | null>;
  close?(): Promise<boolean>;
};
export type ApplicationHost = {
  ownerEpoch: string;
  artifacts: ArtifactPort;
  transaction<T>(operation: (transaction: ExecutionTransaction) => Promise<T>): Promise<T>;
  assertOwner(): Promise<void>;
};

// Acceptance is journaled while the run transaction is held. Checkout exclusion,
// application IO and cancellation run outside it, so unrelated stop/status work
// remains responsive while an application waits for writers to stop.
export class RuntimeApplications {
  private readonly host: ApplicationHost;
  private readonly port: RuntimeApplicationPort;
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private closing = false;

  constructor(host: ApplicationHost, port: RuntimeApplicationPort) {
    this.host = host;
    this.port = port;
  }

  async execute(
    request: CommandEnvelope & { command: ApplicationCommand },
    caller: CallerAuthority,
  ): Promise<CommandReceipt> {
    const accepted = await this.host.transaction(async ({ state, commit }) => {
      await this.host.assertOwner();
      if (this.closing) throw new DomainError("conflict", "Application service is closing");
      const current = state();
      const previous = Object.hasOwn(current.receipts, request.requestId)
        ? current.receipts[request.requestId]
        : undefined;
      if (previous) {
        if (previous.payloadDigest !== digestValue(request))
          throw new DomainError(
            "conflict",
            "Request ID already has a different accepted payload",
            "requestId",
          );
        return { receipt: previous.receipt };
      }
      const prepared = prepareApplication(current, request, caller, {
        operationId: randomUUID(),
        ownerEpoch: this.host.ownerEpoch,
      });
      await commit(prepared, {
        requestId: request.requestId,
        payloadDigest: prepared.payloadDigest,
      });
      return { receipt: prepared.receipt, intent: prepared.intent };
    });
    if (accepted.intent) {
      // Shutdown may have started while acceptance was being persisted. Leave
      // that durable intent inspectable; it must never launch after close won.
      if (this.closing) return immutable(accepted.receipt);
      const controller = new AbortController();
      const done = this.run(accepted.intent, controller.signal);
      this.active.set(accepted.intent.id, { controller, done });
      try {
        await done;
      } finally {
        this.active.delete(accepted.intent.id);
      }
    } else if (accepted.receipt.operationId) {
      await this.active.get(accepted.receipt.operationId)?.done;
    }
    return immutable(accepted.receipt);
  }

  private async run(intent: ApplicationIntent, signal: AbortSignal): Promise<void> {
    let observation: ApplicationObservation;
    try {
      await this.host.assertOwner();
      const returned = await this.port.execute(immutable(intent), {
        artifacts: this.host.artifacts,
        signal,
      });
      const receipt = returned === null ? null : applicationReceiptSchema.parse(returned);
      observation = { status: "completed", receipt };
    } catch (error) {
      const code =
        error instanceof DomainError || error instanceof StorageError ? error.code : "conflict";
      observation = {
        status: "uncertain",
        error: {
          code,
          message:
            error instanceof Error
              ? error.message
              : "Application did not return a confirmed outcome",
        },
      };
    }
    observation.evidence = await this.host.artifacts.put(
      Buffer.from(canonicalJson({ schemaVersion: 1, operationId: intent.id, ...observation })),
    );
    await this.host.transaction(async ({ commit }) => {
      await this.host.assertOwner();
      await commit({ kind: "application_observed", operationId: intent.id, observation });
    });
  }

  async close(): Promise<boolean> {
    this.closing = true;
    for (const operation of this.active.values())
      operation.controller.abort(new Error("Runtime application service closed"));
    const operations = await Promise.allSettled(
      [...this.active.values()].map((operation) => operation.done),
    );
    const confirmed = (await this.port.close?.()) ?? true;
    return confirmed && operations.every((operation) => operation.status === "fulfilled");
  }
}
