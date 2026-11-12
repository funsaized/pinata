import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createAgentSession,
  createBashToolDefinition,
  createPowerShellToolDefinition,
  createCodemodeExtension,
  DefaultResourceLoader,
  loadSkills,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type BashOperations,
  type ModelRuntime,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  BackendStartFailure,
  canonicalJson,
  definitionSchema,
  DomainError,
  digestValue,
  workspacePlanSchema,
  type ArtifactRef,
  type BackendCapabilities,
  type BackendHandle,
  type BackendLaunch,
  type BackendObservation,
  type BackendOutcome,
  type BackendPort,
  type CleanupReceipt,
  type InboxMessage,
  type SessionCheckpoint,
  type Usage,
  type UsageObservation,
} from "../contracts/index.ts";
import { storeConversation } from "../storage/conversation.ts";
import { checkpointConversation, openConversation } from "../agent/conversation.ts";
import { reportTool, workerExtension } from "../agent/extension.ts";
import { memoryTools } from "../agent/memory.ts";
import { childExtension, childTools } from "../agent/delegation.ts";
import { dependencyExtension, dependencyList, dependencyTool } from "../agent/dependencies.ts";
import { ToolPages } from "../sources/pages.ts";
import type { ChildPort } from "../contracts/delegation.ts";
import { materializeSkills, readLoadout, verifyProviders } from "../definitions/resources.ts";
import { freezeInstructions } from "../context/instructions.ts";
import { importConversationSeed, readConversationSeed } from "../context/conversation.ts";
import { trustedOutputSchema, type TrustedBootstrap } from "../definitions/typed.ts";

export type SessionProcesses = {
  bash: BashOperations;
  powershell?: BashOperations;
  stop(): Promise<CleanupReceipt>;
};
export type InProcessOptions = {
  modelRuntime(): Promise<ModelRuntime>;
  bootstrap?: TrustedBootstrap;
  agentDir: string;
  codemode?: boolean;
  extensions?: string[];
  memoryProject?: string;
  children?(launch: BackendLaunch): ChildPort;
  createProcesses?(launch: BackendLaunch): SessionProcesses;
};

const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

export class InProcessBackend implements BackendPort {
  readonly kind = "in-process" as const;
  readonly capabilities: BackendCapabilities = {
    available: true,
    steer: true,
    continuation: true,
    conversationSeed: true,
    skills: true,
    memory: true,
    fallbacks: true,
    surviving: false,
    cleanup: "confirmed",
  };
  private readonly options: InProcessOptions;

  constructor(options: InProcessOptions) {
    this.options = options;
    this.capabilities.delegation = Boolean(options.children);
  }

  async start(
    launch: BackendLaunch,
    observe: (event: BackendObservation) => Promise<void>,
    signal: AbortSignal,
  ): Promise<BackendHandle> {
    signal.throwIfAborted();
    if (launch.worker.lifetime !== "attached")
      throw new DomainError("unsupported", "An in-process worker cannot survive its host");
    if (!launch.worker.model)
      throw new DomainError("invalid_input", "No model was resolved for this worker");
    const children = launch.worker.grants.delegation.maxDepth
      ? this.options.children?.(launch)
      : undefined;
    if (launch.worker.grants.delegation.maxDepth && !children)
      throw new DomainError("unsupported", "Delegation requires a host-bound child command port");
    const definition = definitionSchema.parse(
      JSON.parse(
        Buffer.from(await launch.artifacts.read(launch.worker.definition)).toString("utf8"),
      ),
    );
    if (definition.pinata.skills.length && !launch.worker.loadout)
      throw new DomainError(
        "unsupported",
        "Skills require an immutable resolved loadout before this backend can launch",
      );
    if (
      launch.worker.tools.some((name) => name === "bash" || name === "powershell") &&
      !this.options.createProcesses
    )
      throw new DomainError("unsupported", "Shell tools require an enrolled process supervisor");
    const modelRuntime = await this.options.modelRuntime();
    const model = modelRuntime.getModel(launch.worker.model.provider, launch.worker.model.id);
    if (!model)
      throw new DomainError(
        "unsupported",
        "The resolved model is unavailable to the selected backend",
      );
    const identity = { id: randomUUID(), kind: this.kind, ownerEpoch: launch.ownerEpoch };
    await observe({ kind: "enrolled", identity, evidence: [] });
    let session: AgentSession | undefined;
    let processes: SessionProcesses | undefined;
    try {
      processes = this.options.createProcesses?.(launch);
      const manager = await openConversation(launch);
      if (launch.worker.context && !launch.continuation)
        importConversationSeed(
          manager,
          await readConversationSeed(launch.worker.context, launch.artifacts),
          model,
        );
      const initialEntryCount = manager.getEntryCount();
      const initialBranch = manager.getLeafId();
      let isFinished = false;
      let isStopping = false;
      let stopPromise: ReturnType<BackendHandle["stop"]> | undefined;
      let observationQueue = Promise.resolve();
      let observationFailure: Error | undefined;
      let activityOrdinal = 0;
      let responseNumber = 0;
      let responseId: string | undefined;
      let compactionId: string | undefined;
      let compactionNumber = 0;
      let incompleteResponses = false;
      let summary = "";
      let finalStopReason = "";
      let reported: ArtifactRef | undefined;
      let reportingError: string | undefined;
      const retained: ArtifactRef[] = [];
      const instructions = await freezeInstructions({
        cwd: launch.cwd,
        agentDir: this.options.agentDir,
        artifacts: launch.artifacts,
      });
      retained.push(instructions.artifact);
      const loadout = launch.worker.loadout
        ? await readLoadout(launch.worker.loadout, launch.artifacts)
        : undefined;
      if (
        loadout &&
        (loadout.agent !== launch.worker.agent ||
          digestValue(loadout.definition) !== digestValue(launch.worker.definition))
      )
        throw new DomainError("conflict", "Frozen loadout differs from the accepted definition");
      const outputSchema = loadout?.trusted
        ? await trustedOutputSchema(this.options.bootstrap, loadout, definition, launch.artifacts)
        : undefined;
      const skillPaths = loadout
        ? await materializeSkills(
            loadout.skills,
            launch.artifacts,
            join(launch.storeDirectory, "resources", launch.worker.id),
          )
        : [];
      const selectedSkills = loadSkills({
        cwd: launch.cwd,
        agentDir: this.options.agentDir,
        skillPaths,
        includeDefaults: false,
      });
      if (selectedSkills.diagnostics.length || selectedSkills.skills.length !== skillPaths.length)
        throw new DomainError("context_unavailable", "Frozen skills could not be loaded exactly");
      const providerPaths = loadout ? await verifyProviders(loadout) : [];
      let memory: Awaited<ReturnType<typeof memoryTools>> | undefined;
      if (launch.worker.grants.memory.scope !== "none") {
        let project = this.options.memoryProject;
        if (launch.worker.workspacePlan) {
          const plan = workspacePlanSchema.parse(
            JSON.parse(
              Buffer.from(await launch.artifacts.read(launch.worker.workspacePlan)).toString(
                "utf8",
              ),
            ),
          );
          if (
            plan.run !== launch.ref.run ||
            plan.worker !== launch.worker.id ||
            plan.destination !== launch.cwd
          )
            throw new DomainError(
              "capability_denied",
              "Memory workspace binding differs from the frozen plan",
            );
          project = plan.source;
        }
        if (!project)
          throw new DomainError("unsupported", "Scoped memory requires a host-bound project root");
        memory = await memoryTools(launch, project);
      }
      const usage: UsageObservation[] = [];
      const pendingInputs = new Map<string, { message: InboxMessage; entryId?: string }>();
      const consumed = new Set<string>();
      const dependencyTools = launch.brief.dependencies.length ? [dependencyTool] : [];
      const toolUsage = new Set<string>();
      const reportCalls = new Map<string, unknown>();
      const providerFreeTools = new Set([
        "read",
        "write",
        "edit",
        "bash",
        "powershell",
        "grep",
        "find",
        "ls",
        reportTool,
        ...dependencyTools,
        ...(memory?.names ?? []),
        ...(children ? childTools : []),
      ]);

      const enqueue = (operation: () => Promise<void>): void => {
        observationQueue = observationQueue
          .then(async () => {
            if (!observationFailure) await operation();
          })
          .catch((error: unknown) => {
            observationFailure = error instanceof Error ? error : new Error(String(error));
            void session?.abort().catch((cause: unknown) => {
              observationFailure = new Error(
                "Observer failed and session abort could not be confirmed",
                { cause },
              );
            });
          });
      };
      const checkpoint = () => checkpointConversation(manager, launch.worker.id, launch.artifacts);
      const flushConsumed = async (): Promise<void> => {
        const ready = [...pendingInputs.entries()].filter(
          ([id, item]) => item.entryId && !consumed.has(id),
        );
        if (!ready.length) return;
        const saved = await checkpoint();
        for (const [messageId, item] of ready) {
          await observe({
            kind: "input_consumed",
            messageId,
            checkpoint: saved.artifact,
            entryId: item.entryId,
          });
          consumed.add(messageId);
          pendingInputs.delete(messageId);
        }
      };
      const extension = workerExtension({
        worker: launch.worker,
        root: launch.cwd,
        codemode: this.options.codemode ?? false,
        outputType: definition.outputType,
        outputSchema,
        runtimeTools: [
          ...(memory?.names ?? []),
          ...(children ? childTools : []),
          ...dependencyTools,
        ],
        async onReport(report) {
          reported = await launch.artifacts.put(Buffer.from(canonicalJson(report)));
          summary = report.summary;
        },
        async onReportingError(value, message) {
          reportingError = message;
          retained.push(
            await launch.artifacts.put(Buffer.from(canonicalJson({ value, error: message }))),
          );
        },
        beforeRequest: flushConsumed,
      });
      const settings = SettingsManager.inMemory({
        cacheWarming: "off",
        compaction: { enabled: true },
      });
      const processExtension: ExtensionFactory = (pi) => {
        if (processes) {
          if (launch.worker.tools.includes("bash"))
            pi.registerTool(
              createBashToolDefinition(launch.cwd, {
                operations: processes.bash,
                exposeSessionEnvironment: false,
              }),
            );
          if (launch.worker.tools.includes("powershell")) {
            if (!processes.powershell)
              throw new DomainError(
                "unsupported",
                "The PowerShell supervisor is unavailable on this host",
              );
            pi.registerTool(
              createPowerShellToolDefinition(launch.cwd, {
                operations: processes.powershell,
                exposeSessionEnvironment: false,
              }),
            );
          }
        }
      };
      const loader = new DefaultResourceLoader({
        cwd: launch.cwd,
        agentDir: this.options.agentDir,
        settingsManager: settings,
        noExtensions: true,
        disabledBuiltinExtensions: ["mcp"],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        additionalExtensionPaths: [
          ...new Set([...(this.options.extensions ?? []), ...providerPaths]),
        ],
        extensionFactories: [
          extension,
          processExtension,
          ...(memory ? [memory.extension] : []),
          ...(children
            ? [
                childExtension(
                  children,
                  new ToolPages({
                    artifacts: launch.artifacts,
                    scope: launch.attemptId,
                  }),
                ),
              ]
            : []),
          ...(dependencyTools.length ? [dependencyExtension(launch)] : []),
          ...(this.options.codemode ? [createCodemodeExtension({ models: false })] : []),
        ],
        agentsFilesOverride: () => ({ agentsFiles: instructions.files }),
        skillsOverride: () => selectedSkills,
        systemPromptOverride: () => undefined,
        appendSystemPromptOverride: () => [
          definition.instructions,
          ...(memory ? [memory.prompt] : []),
        ],
      });
      await loader.reload();
      const created = await createAgentSession({
        cwd: launch.cwd,
        agentDir: this.options.agentDir,
        modelRuntime,
        model,
        thinkingLevel: launch.worker.model.thinking,
        sessionManager: manager,
        settingsManager: settings,
        resourceLoader: loader,
        tools: [
          ...launch.worker.tools,
          reportTool,
          ...dependencyTools,
          ...(memory?.names ?? []),
          ...(children ? childTools : []),
          ...(this.options.codemode ? ["codemode"] : []),
        ],
      });
      session = created.session;
      const activeSession = session;
      const recordContext = async (): Promise<void> => {
        const current = activeSession.getContextUsage();
        await observe({
          kind: "context",
          attemptId: launch.attemptId,
          context: {
            tokens: current?.tokens ?? null,
            window: current?.contextWindow ?? null,
            percent: current?.percent ?? null,
            source: "pi/session",
            timestamp: Date.now(),
          },
        });
      };
      const unsubscribe = activeSession.subscribe((event: AgentSessionEvent) => {
        if (
          event.type === "tool_execution_start" &&
          !event.parentToolCallId &&
          !providerFreeTools.has(event.toolName)
        ) {
          const id = `${launch.attemptId}/tool-usage/${event.toolCallId}`;
          toolUsage.add(event.toolCallId);
          enqueue(() =>
            observe({
              kind: "response",
              attemptId: launch.attemptId,
              responseId: id,
              status: "started",
            }),
          );
        }
        if (event.type === "compaction_start") {
          const id = `${launch.attemptId}/compaction/${++compactionNumber}`;
          compactionId = id;
          enqueue(() =>
            observe({
              kind: "response",
              attemptId: launch.attemptId,
              responseId: id,
              status: "started",
            }),
          );
        }
        if (event.type === "compaction_end") {
          const id = compactionId ?? `${launch.attemptId}/compaction/${++compactionNumber}`;
          compactionId = undefined;
          const measured = event.result?.usage;
          const interrupted = event.aborted || !measured;
          incompleteResponses ||= interrupted;
          if (measured) {
            const observation: UsageObservation = {
              attempt: launch.attemptId,
              source: `${identity.id}/${id}`,
              kind: "response",
              responseId: id,
              usage: {
                input: measured.input,
                output: measured.output,
                cacheRead: measured.cacheRead,
                cacheWrite: measured.cacheWrite,
                cost: Number.isFinite(measured.cost.total) ? measured.cost.total : null,
              },
            };
            usage.push(observation);
            enqueue(() => observe({ kind: "usage", attemptId: launch.attemptId, observation }));
          }
          enqueue(async () => {
            await observe({
              kind: "response",
              attemptId: launch.attemptId,
              responseId: id,
              status: interrupted ? "interrupted" : "completed",
            });
            await recordContext();
          });
        }
        if (event.type === "message_start" && event.message.role === "assistant") {
          responseId = `${launch.attemptId}/response/${++responseNumber}`;
          const id = responseId;
          enqueue(() =>
            observe({
              kind: "response",
              attemptId: launch.attemptId,
              responseId: id,
              status: "started",
            }),
          );
        }
        if (event.type === "message_update") {
          const delta = event.assistantMessageEvent;
          if (delta.type === "text_delta" || delta.type === "thinking_delta") {
            const ordinal = ++activityOrdinal;
            enqueue(() =>
              observe({ kind: "activity", source: identity.id, ordinal, text: delta.delta }),
            );
          }
        }
        if (event.type !== "message_end") return;
        if (event.message.role === "custom" && event.message.customType === "pinata.input") {
          const details: unknown = event.message.details;
          const messageId =
            details !== null &&
            typeof details === "object" &&
            "messageId" in details &&
            typeof details.messageId === "string"
              ? details.messageId
              : undefined;
          if (messageId && pendingInputs.has(messageId)) {
            queueMicrotask(() => {
              const entry = manager.getLeafEntry();
              if (
                entry?.type === "custom_message" &&
                entry.customType === "pinata.input" &&
                entry.details &&
                typeof entry.details === "object" &&
                "messageId" in entry.details &&
                entry.details.messageId === messageId
              ) {
                const pending = pendingInputs.get(messageId);
                if (pending) pending.entryId = entry.id;
              }
            });
          }
        }
        if (event.message.role === "toolResult") {
          const message = event.message;
          if (message.toolName === reportTool && message.isError) {
            const value = reportCalls.get(message.toolCallId);
            const error = message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
            reportingError = error || "Pi rejected the optional report";
            enqueue(async () => {
              retained.push(
                await launch.artifacts.put(
                  Buffer.from(canonicalJson({ value: value ?? null, error: reportingError })),
                ),
              );
            });
          }
          reportCalls.delete(message.toolCallId);
          const measured = message.usage;
          if (toolUsage.has(message.toolCallId) || measured) {
            const id = `${launch.attemptId}/tool-usage/${message.toolCallId}`;
            if (!toolUsage.has(message.toolCallId))
              enqueue(() =>
                observe({
                  kind: "response",
                  attemptId: launch.attemptId,
                  responseId: id,
                  status: "started",
                }),
              );
            const knownZero =
              message.toolName === "codemode" &&
              message.nestedCalls?.complete === true &&
              message.nestedCalls.calls.every(
                (call) => providerFreeTools.has(call.name) && call.status !== "unfinished",
              );
            const hasCompleteUsage =
              Boolean(measured || knownZero) && message.nestedCalls?.complete !== false;
            incompleteResponses ||= !hasCompleteUsage;
            if (measured || knownZero) {
              const observation: UsageObservation = {
                attempt: launch.attemptId,
                source: `${identity.id}/${id}`,
                kind: "response",
                responseId: id,
                usage: measured
                  ? {
                      input: measured.input,
                      output: measured.output,
                      cacheRead: measured.cacheRead,
                      cacheWrite: measured.cacheWrite,
                      cost: Number.isFinite(measured.cost.total) ? measured.cost.total : null,
                    }
                  : zeroUsage(),
              };
              usage.push(observation);
              enqueue(() => observe({ kind: "usage", attemptId: launch.attemptId, observation }));
            }
            enqueue(() =>
              observe({
                kind: "response",
                attemptId: launch.attemptId,
                responseId: id,
                status: hasCompleteUsage ? "completed" : "interrupted",
              }),
            );
          }
        }
        if (event.message.role !== "assistant") return;
        const message = event.message;
        for (const part of message.content) {
          if (part.type === "toolCall" && part.name === reportTool)
            reportCalls.set(part.id, part.arguments);
        }
        const id = responseId ?? `${launch.attemptId}/response/${++responseNumber}`;
        responseId = undefined;
        const interrupted = message.stopReason === "aborted" || message.stopReason === "error";
        incompleteResponses ||= interrupted;
        finalStopReason = message.stopReason;
        if (!reported)
          summary = message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
        const observation: UsageObservation = {
          attempt: launch.attemptId,
          source: `${identity.id}/${id}`,
          kind: "response",
          responseId: id,
          usage: {
            input: message.usage.input,
            output: message.usage.output,
            cacheRead: message.usage.cacheRead,
            cacheWrite: message.usage.cacheWrite,
            cost: Number.isFinite(message.usage.cost.total) ? message.usage.cost.total : null,
          },
        };
        usage.push(observation);
        enqueue(async () => {
          await observe({ kind: "usage", attemptId: launch.attemptId, observation });
          await observe({
            kind: "response",
            attemptId: launch.attemptId,
            responseId: id,
            status: interrupted ? "interrupted" : "completed",
          });
          await recordContext();
        });
      });
      const onAbort = (): void => {
        void activeSession.abort().catch((error: unknown) => {
          observationFailure = error instanceof Error ? error : new Error(String(error));
        });
      };
      signal.addEventListener("abort", onAbort, { once: true });

      const stop: BackendHandle["stop"] = (reason) => {
        if (stopPromise) return stopPromise;
        isStopping = true;
        stopPromise = (async () => {
          const reasons: string[] = [];
          const checkpointErrors: string[] = [];
          let disposed = false;
          try {
            await activeSession.abort();
            await activeSession.waitForIdle();
          } catch (error) {
            reasons.push(
              `Session shutdown: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          await observationQueue;
          // The assignment span and partial provider outcome must finish before
          // disposal. A stop receipt can win the controller's completion race.
          const outcome = await done;
          try {
            await flushConsumed();
          } catch (error) {
            checkpointErrors.push(
              `Input checkpoint: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          let saved: SessionCheckpoint | undefined;
          try {
            saved = await checkpoint();
          } catch (error) {
            checkpointErrors.push(
              `Conversation checkpoint: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          let processCleanup: CleanupReceipt | undefined;
          try {
            processCleanup = await processes?.stop();
          } catch (error) {
            reasons.push(
              `Process shutdown: ${error instanceof Error ? error.message : String(error)}`,
            );
          } finally {
            unsubscribe();
            signal.removeEventListener("abort", onAbort);
            try {
              activeSession.dispose();
              disposed = true;
            } catch (error) {
              reasons.push(
                `Session disposal: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          if (processCleanup?.status === "unconfirmed") reasons.push(...processCleanup.reasons);
          const evidence = [...(processCleanup?.evidence ?? [])];
          try {
            evidence.push(
              await launch.artifacts.put(
                Buffer.from(
                  canonicalJson({
                    schemaVersion: 1,
                    kind: "pi-session-cleanup",
                    identity,
                    session: manager.getSessionId(),
                    idle: !activeSession.isStreaming,
                    disposed,
                    reasons,
                    checkpointErrors,
                  }),
                ),
              ),
            );
          } catch (error) {
            reasons.push(
              `Cleanup evidence: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          const cleanup: CleanupReceipt = reasons.length
            ? {
                status: "unconfirmed",
                ownerEpoch: launch.ownerEpoch,
                identities: [identity.id, ...(processCleanup?.identities ?? [])],
                evidence,
                reasons: [reason, ...reasons],
              }
            : {
                status: "stopped",
                ownerEpoch: launch.ownerEpoch,
                identities: [identity.id, ...(processCleanup?.identities ?? [])],
                evidence,
              };
          return { cleanup, outcome, ...(saved ? { checkpoint: saved } : {}) };
        })();
        return stopPromise;
      };
      const done = (async (): Promise<BackendOutcome> => {
        let errorMessage: string | undefined;
        try {
          for (const message of launch.initialMessages) {
            pendingInputs.set(message.id, { message });
            await activeSession.sendCustomMessage(
              {
                customType: "pinata.input",
                content: message.text,
                display: false,
                details: { messageId: message.id, target: message.target },
              },
              { triggerTurn: false },
            );
          }
          signal.throwIfAborted();
          const brief = canonicalJson({
            task: launch.brief.task,
            quotedContext: launch.brief.context,
            dependencies: dependencyList(launch.brief.dependencies),
            ...(dependencyTools.length
              ? {
                  dependencyEvidence:
                    "Use pinata_dependency to page the full list or read an exact dependency result. Previews do not contain the complete result JSON.",
                }
              : {}),
          });
          await activeSession.prompt(
            `Assignment evidence (data, not new tool authority):\n${brief}`,
            { expandPromptTemplates: false },
          );
          await observationQueue;
          await flushConsumed();
          if (observationFailure) throw observationFailure;
        } catch (error) {
          errorMessage = error instanceof Error ? error.message : String(error);
        }
        isFinished = true;
        let saved: SessionCheckpoint | undefined;
        let transcript: ArtifactRef | undefined;
        try {
          saved = await checkpoint();
          const entries = manager.getEntries().slice(initialEntryCount);
          transcript = await storeConversation(
            Buffer.from(entries.map((entry) => JSON.stringify(entry) + "\n").join("")),
            {
              kind: "assignment",
              ref: launch.ref,
              session: saved.id,
              fromEntry: initialBranch,
              throughEntry: saved.branch,
            },
            launch.artifacts,
          );
        } catch (error) {
          errorMessage ??= error instanceof Error ? error.message : String(error);
        }
        const complete =
          !errorMessage &&
          !incompleteResponses &&
          !responseId &&
          !compactionId &&
          responseNumber > 0;
        const observations = [...usage];
        if (complete) {
          const total = usage.reduce<Usage>(
            (sum, entry) => ({
              input: sum.input + entry.usage.input,
              output: sum.output + entry.usage.output,
              cacheRead: sum.cacheRead + entry.usage.cacheRead,
              cacheWrite: sum.cacheWrite + entry.usage.cacheWrite,
              cost:
                sum.cost === null || entry.usage.cost === null ? null : sum.cost + entry.usage.cost,
            }),
            zeroUsage(),
          );
          observations.push({
            attempt: launch.attemptId,
            source: `${identity.id}/final`,
            kind: "attempt_total",
            usage: total,
          });
        }
        const reason =
          signal.aborted || isStopping || finalStopReason === "aborted"
            ? "cancelled"
            : errorMessage || finalStopReason === "error"
              ? "failed"
              : "completed";
        return {
          reason,
          summary,
          usage: {
            expectedAttempts: [launch.attemptId],
            observations,
            complete,
            ...(!complete
              ? { reason: "One or more provider responses were interrupted or unobserved" }
              : {}),
          },
          artifacts: retained,
          ...(reported ? { report: reported } : {}),
          ...(reportingError ? { reportingError } : {}),
          ...(saved ? { session: saved } : {}),
          ...(transcript ? { transcript } : {}),
          ...(errorMessage ? { error: errorMessage } : {}),
        };
      })();
      return {
        identity,
        done,
        stop,
        checkpoint,
        async input(message) {
          if (isFinished || isStopping || !activeSession.isStreaming)
            return { status: "undelivered" };
          if (pendingInputs.has(message.id) || consumed.has(message.id))
            return { status: "transport_handled" };
          pendingInputs.set(message.id, { message });
          await activeSession.sendCustomMessage(
            {
              customType: "pinata.input",
              content: message.text,
              display: false,
              details: { messageId: message.id, target: message.target },
            },
            { triggerTurn: true, deliverAs: "steer" },
          );
          return { status: "transport_queued" };
        },
      };
    } catch (cause) {
      const reasons: string[] = [];
      if (session) {
        try {
          await session.abort();
          await session.waitForIdle();
          session.dispose();
        } catch (error) {
          reasons.push(
            `Session setup cleanup: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      let processCleanup: CleanupReceipt | undefined;
      try {
        processCleanup = await processes?.stop();
      } catch (error) {
        reasons.push(
          `Process setup cleanup: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (processCleanup?.status === "unconfirmed") reasons.push(...processCleanup.reasons);
      const evidence = [...(processCleanup?.evidence ?? [])];
      try {
        evidence.push(
          await launch.artifacts.put(
            Buffer.from(
              canonicalJson({
                schemaVersion: 1,
                kind: "pi-setup-cleanup",
                identity,
                sessionCreated: Boolean(session),
                idle: !session?.isStreaming,
                reasons,
              }),
            ),
          ),
        );
      } catch (error) {
        reasons.push(
          `Setup cleanup evidence: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const cleanup: CleanupReceipt = reasons.length
        ? {
            status: "unconfirmed",
            ownerEpoch: launch.ownerEpoch,
            identities: [identity.id, ...(processCleanup?.identities ?? [])],
            evidence,
            reasons,
          }
        : {
            status: "stopped",
            ownerEpoch: launch.ownerEpoch,
            identities: [identity.id, ...(processCleanup?.identities ?? [])],
            evidence,
          };
      throw new BackendStartFailure(
        cause instanceof Error ? cause.message : String(cause),
        { cleanup, artifacts: cleanup.evidence, identity },
        { cause },
      );
    }
  }
}
