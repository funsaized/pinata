// Test-only provider, run in a separate internal-network container. Never copied
// into a contestant image. Its canned tool calls test CLI plumbing, not models.
import { createServer } from "node:http";
import { fixtureSource } from "./fixtures.ts";
const stats = [];
let serial = 0;
const text = (m) =>
  typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? "").join("\n");
const toolNames = (body) => (body.tools ?? []).map((t) => t.function?.name ?? t.name);
function response(body, stack) {
  const tools = toolNames(body);
  const history = body.messages ?? [];
  const previous = history
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.tool_calls ?? [])
    .map((c) => c.function?.name);
  const all = history.map(text).join("\n");
  const call = (name, args) => ({
    tool_calls: [
      {
        id: `call_${++serial}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
  const plain = (content) => ({ content });
  const submit = (extra = {}) =>
    call("submit_result", {
      status: "succeeded",
      summary: "Offline mock fixture finished",
      changedFiles: [],
      checks: [],
      findings: [],
      blockers: [],
      brief: "Offline contract fixture",
      ...extra,
    });
  if (tools.includes("pinata_run")) {
    if (!previous.includes("pinata_run"))
      return call("pinata_run", {
        approval:
          "Arena authorizes editing solution.mjs and running its public check in this container",
        config: { mode: "observe", backend: "process", setup: false, codemode: false },
        integratedChecks: [{ id: "public", argv: ["node", "public-check.mjs"] }],
        tasks: [
          {
            id: "scout",
            agent: "scout",
            task: "Read requirements.md",
            acceptance: ["Public contract understood"],
          },
          {
            id: "build",
            agent: "builder",
            task: "Implement the published contract in solution.mjs",
            acceptance: ["Public checks pass"],
            after: ["scout"],
            ownership: ["solution.mjs"],
            checks: [{ id: "public", argv: ["node", "public-check.mjs"] }],
          },
          {
            id: "review",
            agent: "reviewer",
            task: "Review the implementation against requirements",
            acceptance: ["No defects"],
            after: ["build"],
            reviewOf: "build",
          },
        ],
      });
    if (!previous.includes("pinata_integrate")) {
      const run =
        /"run"\s*:\s*"([a-f0-9-]{36})"/.exec(all)?.[1] ??
        /"id"\s*:\s*"([a-f0-9-]{36})"/.exec(all)?.[1];
      if (!run) return plain("No run id returned by Piñata");
      return call("pinata_integrate", { run });
    }
    return plain("Implementation integrated; all fixture work ended.");
  }
  if (tools.includes("submit_result")) {
    if (/# Task build \(/.test(all)) {
      if (!previous.includes("write"))
        return call("write", { path: "solution.mjs", content: fixtureSource("good") });
      return submit({ changedFiles: ["solution.mjs"] });
    }
    if (/# Task review \(/.test(all)) {
      const fingerprint = /"fingerprint"\s*:\s*"([^"]+)"/.exec(all)?.[1];
      return submit({ review: { taskId: "build", fingerprint, verdict: "approve" } });
    }
    if (!previous.includes("read")) return call("read", { path: "requirements.md" });
    return submit();
  }
  if (stack === "pi-example" && tools.includes("subagent")) {
    if (!previous.includes("subagent"))
      return call("subagent", {
        chain: [
          { agent: "scout", task: "Read requirements.md and identify acceptance criteria" },
          {
            agent: "worker",
            task: "Implement requirements.md in solution.mjs. Prior context: {previous}",
          },
          {
            agent: "reviewer",
            task: "Read solution.mjs and run node public-check.mjs. Prior context: {previous}",
          },
        ],
        agentScope: "user",
      });
    return plain("Official subagent chain ended; final code is in the shared checkout.");
  }
  if (stack === "opencode" && tools.includes("subagent") && all.includes("ARENA_PARENT_DISPATCH")) {
    const n = previous.filter((x) => x === "subagent").length;
    const tasks = [
      [
        "explore",
        "Scout ledger requirements",
        "ARENA_SCOUT Read requirements.md and report acceptance criteria",
      ],
      [
        "general",
        "Implement ledger",
        "ARENA_BUILD Implement requirements.md in solution.mjs and run node public-check.mjs",
      ],
      [
        "general",
        "Review final ledger",
        "ARENA_REVIEW Read solution.mjs and run node public-check.mjs. Do not write files.",
      ],
    ];
    if (n < tasks.length) {
      const [agent, description, prompt] = tasks[n];
      return call("subagent", {
        agent,
        description,
        prompt,
        model: "arena/arena-model",
        background: false,
      });
    }
    return plain(
      "Native scout, builder and independent review ended; parent accepts final fixture candidate.",
    );
  }
  const write = tools.find((n) => n === "write" || n === "write_file");
  const read = tools.find((n) => n === "read" || n === "read_file");
  const bash = tools.find((n) => n === "bash" || n === "shell");
  if (
    write &&
    !previous.includes(write) &&
    ((stack === "opencode" && all.includes("ARENA_BUILD")) ||
      /You are a worker|general-purpose subagent/i.test(all))
  )
    return call(write, { path: "solution.mjs", content: fixtureSource("good") });
  if (read && !previous.includes(read)) return call(read, { path: "requirements.md" });
  if (
    bash &&
    !previous.includes(bash) &&
    (previous.includes(write) || /ARENA_REVIEW|reviewer|code review/i.test(all))
  )
    return call(
      bash,
      stack === "opencode"
        ? { command: "node public-check.mjs", description: "Run public checks" }
        : { command: "node public-check.mjs" },
    );
  return plain("Offline fixture done.");
}
const server = createServer(async (req, res) => {
  if (req.url === "/health") {
    res.end("ok");
    return;
  }
  if (req.url === "/stats") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(stats));
    return;
  }
  const stack = req.url.split("/")[1];
  let bytes = "";
  for await (const chunk of req) {
    bytes += chunk;
    if (bytes.length > 2e6) {
      res.writeHead(413);
      res.end();
      return;
    }
  }
  let body;
  try {
    body = JSON.parse(bytes);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (!req.url.endsWith("/chat/completions")) {
    res.writeHead(404);
    res.end("Mock supports chat completions only");
    return;
  }
  stats.push({ stack, model: body.model, tools: toolNames(body) });
  const result = response(body, stack);
  const id = `chatcmpl_${++serial}`;
  const base = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: body.model,
  };
  const finish = result.tool_calls ? "tool_calls" : "stop";
  const usage = {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 0 },
  };
  if (body.stream) {
    res.setHeader("content-type", "text/event-stream");
    const send = (x) => res.write(`data: ${JSON.stringify(x)}\n\n`);
    send({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: result.content ?? null,
            ...(result.tool_calls && {
              tool_calls: result.tool_calls.map((c, index) => ({ ...c, index })),
            }),
          },
          finish_reason: null,
        },
      ],
    });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
    send({ ...base, choices: [], usage });
    res.end("data: [DONE]\n\n");
  } else {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ...base,
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", ...result }, finish_reason: finish }],
        usage,
      }),
    );
  }
});
server.listen(8080, "0.0.0.0");
