import { registerPinataMessageRenderers } from "./message-renderers.ts";
import { readPersonalGrants } from "./grants.ts";
import { join } from "node:path";
import {
  getAgentDir,
  ModelRuntime,
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type InputEvent,
  type InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { canonicalJson, grantsSchema } from "../contracts/index.ts";
import { openHost, type Host, type HostOptions } from "../host/index.ts";
import { processArtifacts } from "../backends/process-transport.ts";
import { freezeConversationSeed } from "../context/conversation.ts";
import { consumedNoticeIds, parentBranchArtifact, piNotifications } from "./notifications.ts";
import { registerCoordinatorTools } from "./tools.ts";
import { parseMention, routeMention, sendMention, type MentionResult } from "./mentions.ts";
import {
  mentionRequestId,
  readMentionIntent,
  recordMentionInput,
  retainMentionIntent,
} from "./mention-input.ts";
import { installCoordinatorUi } from "../ui/pi.ts";
import { ToolPages } from "../sources/pages.ts";
import { registerMemoryCommand } from "./memory.ts";

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
type Binding = { host: Host; context: ExtensionContext; unsubscribe: () => void; pages: ToolPages };

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
    registerPinataMessageRenderers(pi);
    const bindings = new Map<string, Binding>();
    const pending = new Map<string, Promise<Binding>>();
    const addressedInputs = new WeakMap<InputEvent, Promise<InputEventResult>>();
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
          sessionId: session,
          workspace: saved?.workspace ?? options.host?.workspace ?? context.cwd,
          ...(saved ? { directory: saved.directory, run: saved.run } : {}),
          agentDir,
          grants: configuredGrants ?? (await readPersonalGrants(agentDir)),
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
        active = {
          host: created,
          context,
          unsubscribe: () => {},
          pages: new ToolPages({
            artifacts: processArtifacts(created.directory),
            scope: created.caller.run,
          }),
        };
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
    const ui = installCoordinatorUi(
      pi,
      async (context) => (await getBinding(context)).host.source,
      {
        settings: (_context, source) =>
          [...bindings.values()].find((binding) => binding.host.source === source)?.host.config.ui,
        mode: (_context, source) =>
          [...bindings.values()].find((binding) => binding.host.source === source)?.host.config
            .mode,
      },
    );
    registerCoordinatorTools(
      pi,
      async (context) => {
        const source = (await getBinding(context)).host.source;
        await ui.bind(context, source);
        return source;
      },
      async (context) => (await getBinding(context)).pages,
    );
    registerMemoryCommand(pi, async (context) => (await getBinding(context)).host);

    const visibleBindings = (context: ExtensionContext): Binding[] => [
      ...new Map(
        [...bindings.values()]
          .filter(
            (binding) =>
              binding.context.sessionManager.getSessionId() ===
              context.sessionManager.getSessionId(),
          )
          .map((binding) => [binding.host.source.run, binding]),
      ).values(),
    ];
    const restoreDraft = (context: ExtensionContext, text: string): void => {
      if (!context.ui.getEditorText().trim()) context.ui.setEditorText(text);
    };
    const retryCommand = (run: string, token: string): string => {
      const selector = /^[A-Za-z0-9._-]+$/.test(run) ? run : JSON.stringify(run);
      return `/pinata-retry ${selector}:${token}`;
    };
    const showReceipt = (
      context: ExtensionContext,
      result: Extract<MentionResult, { kind: "receipt" }>,
      input: string,
      retry?: string,
    ): void => {
      if (result.receipt.status === "rejected") {
        restoreDraft(context, input);
        const recovery =
          result.receipt.error.code === "commit_unknown" && retry
            ? ` The receipt is uncertain. Retry the same input with ${retry}.`
            : "";
        context.ui.notify(`${result.receipt.error.message}${recovery}`, "error");
        return;
      }
      const draft = context.ui.getEditorText();
      if (!draft.trim() || draft === input) context.ui.setEditorText("");
      pi.sendMessage(
        {
          customType: "pinata.addressed.v3",
          content: canonicalJson({
            assignments: result.receipt.assignments,
            messageId: result.messageId,
            requestId: result.receipt.requestId,
            ...(retry ? { retry } : {}),
          }),
          display: true,
          details: result.receipt,
        },
        { triggerTurn: false },
      );
    };
    const handleMention = async (
      event: InputEvent,
      context: ExtensionContext,
    ): Promise<InputEventResult> => {
      let retry: string | undefined;
      try {
        const input = parseMention(event.text)?.text
          ? recordMentionInput(pi, context, event)
          : undefined;
        const active = await getBinding(context);
        await ui.bind(context, active.host.source);
        const visible = visibleBindings(context);
        const result = await routeMention(
          event.text,
          visible.map((binding) => binding.host.source),
          active.host.source,
          {
            ...(input ? { requestId: mentionRequestId(input) } : {}),
            beforeSend: async (source, envelope) => {
              const target = visible.find((binding) => binding.host.source === source);
              if (!input || !target) throw new Error("Addressed input has no bound run");
              const token = await retainMentionIntent(
                target.host.directory,
                input,
                source.run,
                envelope,
              );
              retry = retryCommand(source.run, token);
            },
          },
        );
        if (result.kind === "ordinary") return { action: "continue" };
        if (result.kind === "error") {
          restoreDraft(context, event.text);
          context.ui.notify(
            `${result.message}${retry ? ` Retry the same input with ${retry}.` : ""}`,
            "error",
          );
          return { action: "handled" };
        }
        if (result.kind === "navigate") {
          const target =
            [...bindings.values()].find((binding) => binding.host.source === result.source) ??
            active;
          if (options.navigate) await options.navigate(context, target.host, result.ref);
          else if (result.ref) await ui.open(context, "conversation", result.ref, result.source);
          else {
            const mention = parseMention(event.text);
            if (mention) await ui.definition(context, mention.handle, result.source);
          }
          return { action: "handled" };
        }
        showReceipt(context, result, event.text, retry);
        return { action: "handled" };
      } catch (error) {
        restoreDraft(context, event.text);
        report(context, error);
        if (retry)
          context.ui.notify(
            `The receipt is uncertain. Retry the same input with ${retry}.`,
            "error",
          );
        return { action: "handled" };
      }
    };
    pi.on("input", (event, context) => {
      if (event.source === "extension" || !parseMention(event.text)) return { action: "continue" };
      const existing = addressedInputs.get(event);
      if (existing) return existing;
      const handling = handleMention(event, context);
      addressedInputs.set(event, handling);
      return handling;
    });
    pi.registerCommand("pinata-retry", {
      description:
        "Retry an addressed input's retained exact command using its displayed token; never reroute it.",
      handler: async (args, context) => {
        try {
          const match = /^(?:([\s\S]+):)?([a-f0-9]{64})$/.exec(args.trim());
          if (!match)
            throw new Error(
              "Use /pinata-retry [run-prefix:]input-token from the addressed-input receipt or error.",
            );
          const active = await getBinding(context);
          const selector = match[1]?.startsWith('"')
            ? z.string().parse(JSON.parse(match[1]))
            : match[1];
          const visible = visibleBindings(context);
          const exact = visible.find((binding) => binding.host.source.run === selector);
          const candidates = selector
            ? visible.filter((binding) => binding.host.source.run.startsWith(selector))
            : [active];
          const targets = exact ? [exact] : candidates;
          if (targets.length !== 1)
            throw new Error("Select one original visible run before retrying its addressed input.");
          const target = targets[0];
          const intent = await readMentionIntent(target.host.directory, match[2], {
            run: target.host.source.run,
            session: context.sessionManager.getSessionId(),
          });
          const result = await sendMention(target.host.source, intent.envelope);
          if (result.kind === "error") throw new Error(result.message);
          if (result.kind !== "receipt")
            throw new Error("Runtime did not return the addressed input receipt");
          showReceipt(
            context,
            result,
            `/pinata-retry ${args}`,
            retryCommand(target.host.source.run, match[2]),
          );
        } catch (error) {
          restoreDraft(context, `/pinata-retry ${args}`);
          report(context, error);
        }
      },
    });

    pi.on("before_provider_request", async (event, context) => {
      const active = bindings.get(context.sessionManager.getSessionId());
      if (!active) return;
      active.context = context;
      const state = active.host.source.snapshot().snapshot;
      const ids = consumedNoticeIds(
        context.sessionManager.getBranch(),
        state.outbox,
        event.payload,
      );
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
