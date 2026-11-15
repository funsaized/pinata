// A scripted UI demonstration in the real Pi host; provider requests are rejected.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import {
  assignmentKey,
  runtimeQuerySchema,
  surfaceCallSchema,
} from "../../engine/contracts/index.ts";
import { installCoordinatorUi } from "../../engine/ui/pi.ts";
import { UiSource, uiState, conversationReply } from "../engine/rewrite-ui-fixture.ts";

export default function fleetDemo(pi: ExtensionAPI): void {
  const report = process.env.PINATA_DEMO_LOG;
  if (!report) throw new Error("PINATA_DEMO_LOG must name a new capture log");
  const record = (event: Record<string, unknown>) =>
    appendFileSync(report, JSON.stringify({ at: performance.now(), ...event }) + "\n");
  const names = [
    "discovery",
    "api",
    "storage",
    "viewer",
    "layout",
    "navigation",
    "evidence",
    "review",
  ];
  const prompts = [
    "Trace the assignment lifecycle and identify the smallest safe UI changes. Preserve cancellation, cleanup evidence and the shared engine contract.",
    "Check the shared preview query. Return assistant text for the selected assignment, excluding thinking and tool payloads. Keep reads bounded.",
    "Inspect retained transcripts and checkpoint boundaries. Verify that an earlier assignment's response cannot appear as the current answer.",
    "Refine the fleet view so selection, prompt and last message are visible together. Preserve terminal themes, keyboard navigation and drafts.",
    "Build a readable inspector beside the fleet. Stack it below the list on smaller terminals. Keep the exact prompt and cleanup problems available.",
    "Verify filters, pane focus and mouse hit regions. Clicking inspector text must not select the fleet row at the same height.",
    "Collect the scripted test and terminal capture results after discovery completes. Keep incomplete evidence clearly labeled.",
    "Review the final changes after discovery and viewer work settle. Check behavior against tests and retain any remaining limitations.",
  ];
  const messages = [
    "The engine already retains assignment transcripts. I found the UI boundary and am checking how live checkpoints reach the viewer.",
    "The preview returns only assistant text. Tool arguments and thinking blocks are excluded; a bounded scan reports incomplete evidence explicitly.",
    "Assignment references match the retained manifests. A whole-worker checkpoint is kept separate from assignment-specific evidence.",
    "The wide layout now keeps the selected row beside its prompt and last message. I am checking stacked layouts and keyboard focus next.",
    "The inspector fits within a readable width. Long prompts expand with d, and each pane scrolls independently.",
    "Mouse clicks in the inspector keep the selected assignment. Filter counts are calculated before branch collapse.",
    "",
    "",
  ];
  function source(run: string, saved = false) {
    const state = uiState(names.length);
    state.run = run;
    state.workers = {};
    state.assignments = {};
    state.latest = {};
    const template = uiState(names.length);
    for (const [index, id] of names.entries()) {
      const worker = structuredClone(template.workers[`worker-${index + 1}`]);
      worker.id = id;
      worker.agent = index < 3 ? "scout" : index < 6 ? "builder" : "reviewer";
      worker.model = { provider: "scripted", id: "offline-demo", thinking: "off" };
      if ([1, 2, 4, 5].includes(index)) {
        worker.parentAssignment = {
          run,
          worker: index < 3 ? "discovery" : "viewer",
          assignment: 1,
        };
        worker.depth = 1;
      }
      state.workers[id] = worker;
      const ref = { run, worker: id, assignment: 1 };
      state.assignments[assignmentKey(ref)] = {
        ...structuredClone(Object.values(template.assignments)[index]),
        ref,
        task: prompts[index],
        execution:
          saved || index === 2
            ? { phase: "ended", reason: "completed", cleanup: "confirmed" }
            : index < 6
              ? { phase: "running" }
              : { phase: "queued" },
        after:
          index >= 6
            ? [
                { run, worker: "discovery", assignment: 1 },
                ...(index === 7 ? [{ run, worker: "viewer", assignment: 1 }] : []),
              ]
            : [],
      };
      state.latest[id] = 1;
    }
    const fixture = Object.assign(new UiSource(state), {
      location: { workspace: "/demo/pinata", directory: `/demo/pinata/.pinata/runs/${run}` },
    });
    if (saved)
      fixture.capabilities = {
        ...fixture.capabilities,
        live: false,
        control: false,
        recover: false,
      };
    fixture.respond = async (input) => {
      const call = surfaceCallSchema.parse(input);
      if (call.method !== "query") throw new Error("The demo only permits inspection");
      const query = runtimeQuerySchema.parse(call.input);
      if (query.kind !== "conversation" && query.kind !== "conversation_preview")
        throw new Error("Unexpected demo query");
      const index = names.indexOf(query.ref.worker);
      const text = messages[index] || "No assistant message yet.";
      if (query.kind === "conversation")
        return conversationReply(
          query.ref,
          `## Progress\n\n${text}\n\n### Checks\n\n- Selection and prompt remain visible together.\n- Saved evidence stays read-only.\n- This demonstration uses scripted data, with no model calls.`,
        );
      return {
        status: "ok",
        response: {
          method: "query",
          result: {
            kind: "conversation_preview",
            ref: query.ref,
            source: "assignment",
            complete: true,
            ...(messages[index] ? { message: { text, truncated: false } } : {}),
          },
        },
      };
    };
    return fixture;
  }
  const live = source("scripted-demo");
  const saved = source("previous-demo", true);
  const sources = [live, saved];
  const ui = installCoordinatorUi(pi, async () => live, {
    settings: () => ({ palette: "pinata", motion: "full" }),
    runs: () => ({
      workspace: "/demo/pinata",
      async list() {
        return {
          runs: sources.map((source) => ({
            run: source.run,
            ...source.location,
            live: source.capabilities.live,
            control: source.capabilities.control,
          })),
          skipped: 0,
        };
      },
      async open(run) {
        const selected = sources.find((source) => source.run === run.run);
        if (!selected) throw new Error("Unknown demo run");
        return selected;
      },
    }),
  });
  pi.on("before_provider_request", () => {
    record({ phase: "provider-request" });
    throw new Error("The offline demo cannot call a provider");
  });
  pi.on("session_start", () => record({ phase: "ready" }));
  pi.registerShortcut("f12", {
    description: "Open scripted fleet demo",
    handler: async (context) => {
      const instrumented: ExtensionContext = {
        ...context,
        ui: {
          ...context.ui,
          async custom(factory, options) {
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
                  record({ phase: "frame", width, output });
                  return output;
                },
                invalidate() {
                  component.invalidate();
                },
                handleInput(data: string) {
                  record({ phase: "key", data });
                  component.handleInput?.(data);
                },
                handleMouse(event: TuiMouseEvent) {
                  return component.handleMouse?.(event);
                },
                dispose() {
                  component.dispose?.();
                },
              };
            }, options);
          },
        },
      };
      await ui.open(instrumented, "fleet", { run: live.run, worker: "discovery", assignment: 1 });
      record({ phase: "closed" });
    },
  });
  pi.on("session_shutdown", () => ui.dispose());
}
