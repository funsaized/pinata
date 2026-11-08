import { join } from "node:path";
import {
  getAgentDir,
  ModelRuntime,
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { canonicalJson, grantsSchema } from "../contracts/index.ts";
import { openHost, type Host, type HostOptions } from "../host/index.ts";
import { processArtifacts } from "../backends/process-transport.ts";
import { freezeConversationSeed } from "../context/conversation.ts";
import {
  noticeId,
  noticeInPayload,
  parentBranchArtifact,
  piNotifications,
} from "./notifications.ts";
import { registerCoordinatorTools } from "./tools.ts";
import { parseMention, routeMention } from "./mentions.ts";

const bindingType = "pinata.runtime.v3";
const bindingSchema = z.strictObject({
  session: z.string(),
  run: z.string(),
  directory: z.string(),
  workspace: z.string(),
});
export type PiExtensionOptions = {
  host?: Omit<HostOptions, "notifications" | "parentContext">;
  open?: typeof openHost;
  navigate?(
    context: ExtensionContext,
    host: Host,
    ref?: import("../contracts/index.ts").AssignmentRef,
  ): Promise<void>;
};
type Binding = { host: Host; context: ExtensionContext; unsubscribe: () => void };

async function modelRuntime(context: ExtensionContext, agentDir: string): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  // Public provider registrations are copied through supported APIs. No private
  // registry/session mutation or ambient extension loading is needed.
  for (const id of context.modelRegistry.getRegisteredProviderIds()) {
    const native = context.modelRegistry.getRegisteredNativeProvider(id);
    const config = context.modelRegistry.getRegisteredProviderConfig(id);
    if (native) runtime.registerNativeProvider(native);
    else if (config) runtime.registerProvider(id, config);
  }
  await runtime.refresh({ allowNetwork: false });
  return runtime;
}

export function createPinataExtension(options: PiExtensionOptions = {}): ExtensionFactory {
  return (pi) => {
    if (process.env.PINATA_AGENT === "1") return;
    const bindings = new Map<string, Binding>();
    const pending = new Map<string, Promise<Binding>>();
    let configuredGrants = options.host?.grants;
    let nextRun = false;
    const report = (context: ExtensionContext, error: unknown): void => {
      context.ui.notify(error instanceof Error ? error.message : String(error), "error");
    };
    const getBinding = async (context: ExtensionContext): Promise<Binding> => {
      const session = context.sessionManager.getSessionId();
      const existing = bindings.get(session);
      if (existing && !nextRun) {
        existing.context = context;
        return existing;
      }
      const creating = pending.get(session);
      if (creating) return creating;
      const replace = nextRun;
      nextRun = false;
      const opening = (async (): Promise<Binding> => {
        const saved = replace
          ? undefined
          : context.sessionManager
              .getEntries()
              .flatMap((entry) => {
                if (entry.type !== "custom" || entry.customType !== bindingType) return [];
                const value = bindingSchema.safeParse(entry.data);
                return value.success && value.data.session === session ? [value.data] : [];
              })
              .at(-1);
        const agentDir = options.host?.agentDir ?? getAgentDir();
        let active: Binding | undefined;
        let host: Host | undefined;
        const created = await (options.open ?? openHost)({
          ...options.host,
          workspace: saved?.workspace ?? options.host?.workspace ?? context.cwd,
          ...(saved ? { directory: saved.directory, run: saved.run } : {}),
          agentDir,
          grants: configuredGrants,
          modelRuntime: options.host?.modelRuntime ?? (await modelRuntime(context, agentDir)),
          parentModel:
            options.host?.parentModel ??
            (context.model
              ? {
                  provider: context.model.provider,
                  id: context.model.id,
                  thinking: context.thinkingLevel ?? "off",
                }
              : undefined),
          notifications: piNotifications(pi, () => active?.context ?? context),
          parentContext: async () => {
            if (!host) throw new Error("Parent context requested before the host was ready");
            const artifacts = processArtifacts(host.directory);
            const parent = await parentBranchArtifact(active?.context ?? context, artifacts);
            return (
              await freezeConversationSeed({
                checkpoint: {
                  ...parent,
                  worker: "coordinator",
                  format: "pi",
                  producerVersion: VERSION,
                },
                artifacts,
              })
            ).artifact;
          },
        });
        host = created;
        active = { host: created, context, unsubscribe: () => {} };
        active.unsubscribe = created.runtime.subscribe({}, created.caller, (event) => {
          if (event.kind !== "committed" || event.transition.kind !== "settled") return;
          return created.runtime
            .deliverNotifications(created.caller)
            .then(() => {})
            .catch((error: unknown) => report(active?.context ?? context, error));
        });
        if (existing) bindings.set(`${session}/${existing.host.caller.run}`, existing);
        bindings.set(session, active);
        pi.appendEntry(bindingType, {
          session,
          run: created.caller.run,
          directory: created.directory,
          workspace: created.workspace,
        });
        await created.runtime.deliverNotifications(created.caller);
        return active;
      })();
      pending.set(session, opening);
      try {
        return await opening;
      } finally {
        pending.delete(session);
      }
    };
    registerCoordinatorTools(pi, async (context) => (await getBinding(context)).host.source);

    pi.on("input", async (event, context) => {
      if (event.source === "extension" || !parseMention(event.text)) return { action: "continue" };
      try {
        const active = await getBinding(context);
        const sources = [
          ...new Map(
            [...bindings.values()]
              .filter(
                (binding) =>
                  binding.context.sessionManager.getSessionId() ===
                  context.sessionManager.getSessionId(),
              )
              .map((binding) => [binding.host.source.run, binding.host.source]),
          ).values(),
        ];
        const result = await routeMention(event.text, sources, active.host.source);
        if (result.kind === "ordinary") return { action: "continue" };
        if (result.kind === "error") {
          context.ui.setEditorText(event.text);
          context.ui.notify(result.message, "error");
          return { action: "handled" };
        }
        if (result.kind === "navigate") {
          const target =
            [...bindings.values()].find((binding) => binding.host.source === result.source) ??
            active;
          if (options.navigate) await options.navigate(context, target.host, result.ref);
          else
            context.ui.notify(
              result.ref
                ? canonicalJson(result.ref)
                : "Definition found; include a message to start its worker.",
              "info",
            );
          return { action: "handled" };
        }
        if (result.receipt.status === "rejected") {
          context.ui.setEditorText(event.text);
          context.ui.notify(result.receipt.error.message, "error");
        } else {
          // The runtime receipt is durable before the draft is cleared. This
          // input route never asks Pi to start a coordinator model turn.
          context.ui.setEditorText("");
          pi.sendMessage(
            {
              customType: "pinata.addressed.v3",
              content: canonicalJson({
                assignments: result.receipt.assignments,
                messageId: result.messageId,
              }),
              display: true,
              details: result.receipt,
            },
            { triggerTurn: false },
          );
        }
        return { action: "handled" };
      } catch (error) {
        context.ui.setEditorText(event.text);
        report(context, error);
        return { action: "handled" };
      }
    });

    pi.on("before_provider_request", async (event, context) => {
      const active = bindings.get(context.sessionManager.getSessionId());
      if (!active) return;
      active.context = context;
      const state = active.host.source.snapshot().snapshot;
      const ids = context.sessionManager.getBranch().flatMap((entry) => {
        const id = noticeId(entry);
        return id &&
          state.outbox[id] &&
          state.outbox[id].state !== "consumed" &&
          state.outbox[id].attempts.length &&
          entry.type === "custom_message" &&
          noticeInPayload(event.payload, id, entry.content)
          ? [id]
          : [];
      });
      if (!ids.length) return;
      const checkpoint = await parentBranchArtifact(
        context,
        processArtifacts(active.host.directory),
      );
      for (const id of ids)
        await active.host.runtime.recordNotificationConsumption(
          id,
          checkpoint.artifact,
          active.host.caller,
        );
    });
    pi.on("agent_end", async (_event, context) => {
      const active = bindings.get(context.sessionManager.getSessionId());
      if (!active) return;
      active.context = context;
      await active.host.runtime.deliverNotifications(active.host.caller);
    });
    pi.on("session_shutdown", async (_event, context) => {
      await Promise.allSettled(pending.values());
      const session = context.sessionManager.getSessionId();
      for (const [key, binding] of bindings) {
        if (binding.context.sessionManager.getSessionId() !== session) continue;
        binding.unsubscribe();
        const closed = await binding.host.close("Pi session closed");
        if (closed.status !== "closed")
          context.ui.notify(
            closed.reason ??
              "Owned activity remains unconfirmed; retained exclusion requires reconciliation.",
            "warning",
          );
        bindings.delete(key);
      }
    });
    pi.registerCommand("pinata-new", {
      description: "Select a new Pinata run without cancelling existing workers.",
      handler: async (_args, context) => {
        nextRun = true;
        const binding = await getBinding(context);
        context.ui.notify(`Selected run ${binding.host.caller.run}`, "info");
      },
    });
    pi.registerCommand("pinata-grants", {
      description:
        "Set host-approved grants for the next new run using the grants JSON schema. Existing worker grants stay frozen.",
      handler: async (args, context) => {
        try {
          configuredGrants = grantsSchema.parse(JSON.parse(args));
          context.ui.notify(
            "Grants saved for the next new run. Use /pinata-new to select it.",
            "info",
          );
        } catch (error) {
          report(context, error);
        }
      },
    });
    pi.registerCommand("pinata-schema", {
      description: "Inspect a canonical Pinata schema without a model call.",
      handler: async (name, context) => {
        const active = await getBinding(context);
        const response = await active.host.source.request({
          method: "query",
          input: { kind: "schemas", ...(name.trim() ? { name: name.trim() } : {}) },
        });
        pi.sendMessage(
          { customType: "pinata.schema.v3", content: canonicalJson(response), display: true },
          { triggerTurn: false },
        );
      },
    });
  };
}

export default function pinataExtension(pi: ExtensionAPI): void | Promise<void> {
  return createPinataExtension()(pi);
}
