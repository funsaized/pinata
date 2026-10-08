// Test extension for the Pi smoke: registers a faux provider whose scripted model plays both the
// parent (it calls pinata tools) and the in-process children (they read, then submit).
// No network, no tokens.
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function texts(context: any) {
  return (context.messages ?? [])
    .filter((m: any) => m.role !== "system")
    .map((m: any) =>
      typeof m.content === "string"
        ? m.content
        : (m.content ?? []).map((c: any) => (c.type === "text" ? c.text : "")).join(" "),
    );
}

const scouts = (n: number, after?: boolean) => [
  ...Array.from({ length: n }, (_, i) => ({
    id: `scout-${i + 1}`,
    role: "scout",
    task: `Map area ${i + 1}`,
    acceptance: ["A map"],
  })),
  ...(after
    ? [
        {
          id: "plan",
          role: "planner",
          task: "Plan from the maps",
          acceptance: ["A plan"],
          after: Array.from({ length: n }, (_, i) => `scout-${i + 1}`),
        },
      ]
    : []),
];

function step(context: any) {
  const all = texts(context);
  const joined = all.join("\n");
  const assistants = (context.messages ?? []).filter((m: any) => m.role === "assistant").length;
  const child = /# Task ([a-z][a-z0-9-]*) \(([a-z]+)\)/.exec(joined);
  if (child) {
    if (assistants === 0)
      return fauxAssistantMessage([fauxToolCall("read", { path: "README.md" })], {
        stopReason: "toolUse",
      });
    return fauxAssistantMessage(
      [
        fauxToolCall("submit_result", {
          status: "succeeded",
          summary: `${child[1]} finished`,
          changedFiles: [],
          checks: [{ name: "read README.md", status: "passed", detail: "read it" }],
          findings: [],
          blockers: [],
          brief: `${child[1]}: README.md:1 is the title`,
        }),
      ],
      { stopReason: "toolUse" },
    );
  }
  // The parent: answer the latest user message (prompts and delivered results arrive as user turns).
  const messages = (context.messages ?? []).filter((m: any) => m.role !== "system");
  const lastUser = messages.map((m: any) => m.role).lastIndexOf("user");
  const answered = messages.slice(lastUser + 1).some((m: any) => m.role === "assistant");
  const last = lastUser === -1 ? "" : all[lastUser];
  if (!answered && last.includes("pinata run") && last.includes("settled"))
    return fauxAssistantMessage(fauxText("SMOKE-BACKGROUND-RECEIVED"));
  if (!answered && last.includes("smoke-foreground"))
    return fauxAssistantMessage([fauxToolCall("pinata_run", { tasks: scouts(3, true) })], {
      stopReason: "toolUse",
    });
  if (!answered && last.includes("smoke-background"))
    return fauxAssistantMessage(
      [fauxToolCall("pinata_run", { tasks: scouts(1), background: true })],
      { stopReason: "toolUse" },
    );
  return fauxAssistantMessage(fauxText("SMOKE-TURN-DONE"));
}

export default function (pi: ExtensionAPI) {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 8192 }],
  });
  faux.setResponses(Array.from({ length: 10_000 }, () => step));
  pi.registerProvider(faux.provider);
}
