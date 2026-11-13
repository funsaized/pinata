import {
  assignmentKey,
  configSchema,
  commandEnvelopeSchema,
  exportSchemas,
  DomainError,
  runtimeQuerySchema,
  queryResultSchema,
  surfaceCallSchema,
  type RuntimeEvent,
  type SurfaceReply,
} from "../contracts/index.ts";
import { initialState, reduce } from "../core/state.ts";
import { queryMessages } from "../core/messages.ts";
import { inspectStore } from "../storage/journal.ts";
import { StorageError } from "../storage/io.ts";
import { verifyArtifactBytes } from "../storage/journal.ts";
import { ConversationQueries, savedConversation } from "../runtime/queries.ts";
import { readChanges } from "../runtime/changes.ts";
import { surfaceError, type RuntimeSource, type SnapshotEvent } from "./runtime.ts";

export async function openSavedSource(directory: string): Promise<RuntimeSource> {
  const inspected = await inspectStore(directory);
  if (inspected.tail.length)
    throw new StorageError(
      "conflict",
      "Saved run has an unresolved journal tail; retain and reconcile it before viewing a complete snapshot",
    );
  let state = initialState(inspected.manifest.run);
  for (const frame of inspected.frames)
    state = reduce(state, frame.record.transition, frame.record.revision);
  const ownerEpoch =
    inspected.owner?.epoch ?? `saved/${inspected.frames.at(-1)?.digest ?? "empty"}`;
  const current: SnapshotEvent = {
    schemaVersion: 1,
    kind: "snapshot",
    id: `${state.run}/saved/${state.revision}`,
    revision: state.revision,
    ownerEpoch,
    snapshot: state,
  };
  const events: RuntimeEvent[] = inspected.frames.map((frame) => ({
    schemaVersion: 1,
    kind: "committed",
    id: `${state.run}/transaction/${frame.record.revision}/${frame.digest}`,
    revision: frame.record.revision,
    ownerEpoch,
    transition: frame.record.transition,
  }));
  const conversations = new ConversationQueries({
    read: (ref) => verifyArtifactBytes(directory, ref),
  });
  const source: RuntimeSource = {
    run: state.run,
    capabilities: {
      live: false,
      control: false,
      wait: false,
      recover: false,
      notifications: false,
      snapshots: true,
    },
    snapshot: () => structuredClone(current),
    async subscribe(consume) {
      await consume(structuredClone(current));
      return () => {};
    },
    async request(input): Promise<SurfaceReply> {
      try {
        const call = surfaceCallSchema.parse(input);
        if (call.method === "execute") {
          const parsed = commandEnvelopeSchema.safeParse(call.input);
          const requestId = parsed.success
            ? parsed.data.requestId
            : typeof call.input === "object" &&
                call.input !== null &&
                "requestId" in call.input &&
                typeof call.input.requestId === "string" &&
                call.input.requestId.length &&
                !call.input.requestId.includes("\0")
              ? call.input.requestId
              : "invalid-request";
          const issue = !parsed.success ? parsed.error.issues[0] : undefined;
          return {
            status: "ok",
            response: {
              method: "execute",
              result: {
                status: "rejected",
                requestId,
                revision: state.revision,
                error: parsed.success
                  ? {
                      code: "capability_denied",
                      message:
                        "Saved run sources are read-only; attach to the owning runtime for control",
                    }
                  : {
                      code: "invalid_input",
                      message: issue?.message ?? "Invalid command envelope",
                      ...(issue?.path.length ? { field: issue.path.join(".") } : {}),
                    },
              },
            },
          };
        }
        if (call.method !== "query")
          throw new DomainError(
            "unsupported",
            "Saved run sources cannot wait, recover or acknowledge notifications; attach to the owning runtime",
          );
        const query = runtimeQuerySchema.parse(call.input);
        switch (query.kind) {
          case "messages":
            return {
              status: "ok",
              response: { method: "query", result: structuredClone(queryMessages(state, query)) },
            };
          case "application":
            return {
              status: "ok",
              response: {
                method: "query",
                result: {
                  kind: "application",
                  operation: Object.hasOwn(state.applications, query.operationId)
                    ? structuredClone(state.applications[query.operationId])
                    : null,
                },
              },
            };
          case "changes": {
            const key = assignmentKey(query.ref);
            if (query.ref.run !== state.run || !Object.hasOwn(state.assignments, key))
              throw new DomainError("invalid_input", "Unknown changes assignment", "ref");
            return {
              status: "ok",
              response: {
                method: "query",
                result: await readChanges(query.ref, state.results[key]?.result.snapshot, {
                  read: (ref) => verifyArtifactBytes(directory, ref),
                }),
              },
            };
          }
          case "config":
            return {
              status: "ok",
              response: {
                method: "query",
                result: {
                  kind: "config",
                  config: state.config
                    ? configSchema.parse(
                        JSON.parse(
                          Buffer.from(await verifyArtifactBytes(directory, state.config)).toString(
                            "utf8",
                          ),
                        ),
                      )
                    : null,
                },
              },
            };
          case "status":
            return {
              status: "ok",
              response: {
                method: "query",
                result: { kind: "status", state: structuredClone(state) },
              },
            };
          case "receipt":
            return {
              status: "ok",
              response: {
                method: "query",
                result: {
                  kind: "receipt",
                  receipt: structuredClone(state.receipts[query.requestId]?.receipt ?? null),
                },
              },
            };
          case "result": {
            const found = state.results[assignmentKey(query.ref)];
            return {
              status: "ok",
              response: {
                method: "query",
                result: {
                  kind: "result",
                  result: structuredClone(found?.result ?? null),
                  ...(found ? { artifact: found.artifact } : {}),
                },
              },
            };
          }
          case "conversation":
            return {
              status: "ok",
              response: {
                method: "query",
                result: await conversations.query(query, savedConversation(state, query.ref)),
              },
            };
          case "events":
            return {
              status: "ok",
              response: {
                method: "query",
                result: {
                  kind: "events",
                  events: structuredClone(events.slice(query.since)),
                  cursor: state.revision,
                },
              },
            };
          case "schemas": {
            const schemas = exportSchemas(query.name);
            return {
              status: "ok",
              response: {
                method: "query",
                result: queryResultSchema.parse({
                  kind: "schemas",
                  schemas,
                }),
              },
            };
          }
          default:
            throw new DomainError(
              "unsupported",
              `${query.kind} queries require a live runtime source`,
            );
        }
      } catch (error) {
        return { status: "error", error: surfaceError(error) };
      }
    },
  };
  return source;
}
