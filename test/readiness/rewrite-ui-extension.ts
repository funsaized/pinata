// Offline terminal capture for the replacement UI, using public Pi APIs only.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import {
  assignmentKey,
  runtimeQuerySchema,
  surfaceCallSchema,
  transitionSchema,
  type Transition,
} from "../../engine/contracts/index.ts";
import { reduce } from "../../engine/core/state.ts";
import { installCoordinatorUi } from "../../engine/ui/pi.ts";
import { UiSource, uiState, conversationReply } from "../engine/rewrite-ui-fixture.ts";

export default function rewriteUiCapture(pi: ExtensionAPI): void {
  const report = process.env.PINATA_REWRITE_UI_LOG;
  if (!report) throw new Error("The offline UI capture requires an explicit report path");
  const record = (event: Record<string, unknown>) =>
    appendFileSync(report, JSON.stringify({ at: performance.now(), ...event }) + "\n");
  const state = uiState(32);
  const tasks = [
    "Find TODO/FIXME comments",
    "Inspect matching source files",
    "Count files and lines of code",
    "Summarize the README",
  ];
  for (let index = 0; index < 4; index++) {
    const worker = `worker-${index + 1}`;
    state.workers[worker].agent = "explore";
    state.assignments[assignmentKey({ run: state.run, worker, assignment: 1 })].task = tasks[index];
  }
  state.workers["worker-2"].parentAssignment = {
    run: state.run,
    worker: "worker-1",
    assignment: 1,
  };
  state.workers["worker-2"].depth = 1;
  state.assignments[assignmentKey({ run: state.run, worker: "worker-1", assignment: 1 })].task =
    "Inspect terminal 👩🏽‍💻 漢字 e\u0301";
  state.contextUsage[assignmentKey({ run: state.run, worker: "worker-1", assignment: 1 })] = {
    tokens: 24000,
    window: 200000,
    percent: 12,
    source: "scripted provider report",
    timestamp: Date.now(),
  };
  const source = new UiSource(state);
  source.respond = async (input) => {
    const call = surfaceCallSchema.parse(input);
    if (call.method !== "query") throw new Error("The UI capture only supports queries");
    const query = runtimeQuerySchema.parse(call.input);
    if (query.kind !== "conversation") throw new Error("Unexpected capture query");
    const reply = conversationReply(
      query.ref,
      Array.from(
        { length: 100 },
        (_, index) => `Full retained conversation line ${index + 1}`,
      ).join("\n") +
        "\n\n## Highlighted result\n\n**Worker response** with code:\n\n```typescript\nconst answer: number = 42;\nconsole.log(answer);\n```",
    );
    if (
      reply.status === "ok" &&
      reply.response.method === "query" &&
      reply.response.result.kind === "conversation"
    ) {
      reply.response.result.entries.push(
        {
          message: {
            role: "toolResult",
            toolName: "read",
            toolCallId: "read-result",
            content: "Native tool surface",
          },
        },
        {
          message: {
            role: "toolResult",
            toolName: "read",
            toolCallId: "read-error",
            isError: true,
            content: "Native error surface",
          },
        },
        { message: { role: "custom", content: "Native extension surface" } },
      );
    }
    return reply;
  };
  const ui = installCoordinatorUi(pi, async () => source, {
    settings: () => ({ palette: "inherit", motion: "reduced" }),
    mode: () => "observe",
  });
  const parentDraft = "Retained parent draft 👩🏽‍💻 漢字";
  let visits = 0;
  let ticks = 0;
  let disposals = 0;
  let active = false;
  let timer: NodeJS.Timeout | undefined;
  pi.on("before_provider_request", () => {
    record({ phase: "provider-request" });
    throw new Error("Offline UI capture cannot call a provider");
  });
  pi.on("session_start", async (_event, context) => {
    if (context.mode !== "tui") throw new Error("A real terminal is required");
    const router = await ui.bind(context);
    for (let index = 1; index <= 4; index++) {
      const ref = { run: source.run, worker: `worker-${index}`, assignment: 1 };
      const attemptId = `capture/attempt-${index}`;
      const transitions: Transition[] = [
        { kind: "assignment_state", ref, execution: { phase: "preparing" } },
        {
          kind: "attempt_started",
          attempt: {
            id: attemptId,
            ref,
            ordinal: 1,
            backend: "in-process",
            ownerEpoch: source.epoch,
          },
        },
        {
          kind: "backend_enrolled",
          attemptId,
          identity: {
            id: `capture/backend-${index}`,
            kind: "in-process",
            ownerEpoch: source.epoch,
          },
          evidence: [],
        },
        { kind: "assignment_state", ref, execution: { phase: "running" } },
      ];
      for (const transition of transitions) {
        source.state = reduce(
          source.state,
          transitionSchema.parse(transition),
          source.state.revision + 1,
        );
        await source.emit({
          schemaVersion: 1,
          kind: "committed",
          id: `capture/${source.state.revision}`,
          revision: source.state.revision,
          ownerEpoch: source.epoch,
          transition,
        });
      }
    }
    record({
      phase: "lifecycle",
      attempts: Object.keys(source.state.attempts).length,
      revision: source.state.revision,
    });
    context.ui.setEditorText(parentDraft);
    timer = setInterval(() => {
      ticks++;
      for (let worker = 1; worker <= 4; worker++)
        void source
          .activity(worker, ticks, `worker ${worker}: stream ${ticks}\n`)
          .catch((error: unknown) => record({ phase: "error", message: String(error) }));
    }, 30);
    record({ phase: "ready", draft: context.ui.getEditorText(), palette: router.palette });
  });
  pi.registerShortcut("f12", {
    description: "Offline replacement UI capture",
    handler: async (context) => {
      if (active) return;
      active = true;
      visits++;
      const router = await ui.bind(context);
      router.setPalette(visits === 1 ? "inherit" : visits === 2 ? "one-light" : "terminal-default");
      const instrumented: ExtensionContext = {
        ...context,
        ui: {
          ...context.ui,
          async custom(factory, options) {
            record({ phase: "custom", visits, overlay: options?.overlay ?? false });
            return context.ui.custom(async (tui, theme, keys, done) => {
              const component = await factory(tui, theme, keys, done);
              return {
                get focused() {
                  return "focused" in component && Boolean(component.focused);
                },
                set focused(value: boolean) {
                  if ("focused" in component) component.focused = value;
                },
                render(width: number) {
                  const output = component.render(width);
                  record({
                    phase: "render",
                    visits,
                    ticks,
                    width,
                    screen: router.screen,
                    selected: router.selected,
                    draft: router.draft,
                    scroll: router.conversation().scroll,
                    loading: router.conversation().loading,
                    output,
                  });
                  return output;
                },
                invalidate() {
                  component.invalidate();
                },
                handleInput(data: string) {
                  component.handleInput?.(data);
                },
                handleMouse(event: TuiMouseEvent) {
                  return component.handleMouse?.(event);
                },
                dispose() {
                  component.dispose?.();
                  disposals++;
                  record({ phase: "disposed", visits, disposals });
                },
              };
            }, options);
          },
        },
      };
      await ui.open(instrumented, "fleet", { run: source.run, worker: "worker-1", assignment: 1 });
      const first = router.draft;
      router.navigate("main", { run: source.run, worker: "worker-2", assignment: 1 });
      const second = router.draft;
      record({
        phase: "restored",
        visits,
        parentUnchanged: context.ui.getEditorText() === parentDraft,
        first,
        second,
      });
      active = false;
      if (visits === 3) {
        clearInterval(timer);
        record({
          phase: "finished",
          visits,
          disposals,
          parentUnchanged: context.ui.getEditorText() === parentDraft,
          workerDrafts: first === "worker-one draft" && second === "worker-two draft",
          providerCalls: 0,
        });
      }
    },
  });
  pi.on("session_shutdown", () => {
    clearInterval(timer);
    ui.dispose();
  });
}
