// E6.6 prototype: an agent runner with only pi-agent-core + pi-ai (and, with --tools, Pi's
// tool definitions for parity). It speaks a minimal subset of Pi's RPC: get_state and
// prompt. Used only to measure startup and memory against `pi --mode rpc`.
//   node bench/prototypes/slim-runner.ts <loopback base URL> [--tools]
import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";

const [baseUrl, flag] = process.argv.slice(2);
const tools =
  flag === "--tools"
    ? await (async () => {
        const pi = await import("@earendil-works/pi-coding-agent");
        const cwd = process.cwd();
        return [
          pi.createReadToolDefinition(cwd),
          pi.createLsToolDefinition(cwd),
          pi.createGrepToolDefinition(cwd),
          pi.createFindToolDefinition(cwd),
          pi.createEditToolDefinition(cwd),
          pi.createWriteToolDefinition(cwd),
          pi.createBashToolDefinition(cwd),
        ].map((d: any) => ({
          name: d.name,
          label: d.label ?? d.name,
          description: d.description,
          parameters: d.parameters,
          execute: (id: string, params: unknown, signal?: AbortSignal) =>
            d.execute(id, params, signal, undefined, {}),
        }));
      })()
    : [];
const model = {
  id: "loopback",
  name: "loopback",
  api: "openai-completions",
  provider: "pinata-loopback",
  baseUrl,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 65536,
  maxTokens: 8192,
} as any;
const agent = new Agent({
  initialState: { systemPrompt: "You are a test agent.", model, tools: tools as any },
  streamFn: streamSimple as any,
  getApiKey: () => "fixture-not-a-real-secret",
});
const out = (record: unknown) => process.stdout.write(JSON.stringify(record) + "\n");
agent.subscribe((event: any) => void out(event));
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk: string) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const command = JSON.parse(buffer.slice(0, nl));
    buffer = buffer.slice(nl + 1);
    if (command.type === "get_state")
      out({ id: command.id, type: "response", command: "get_state", success: true, data: {} });
    else if (command.type === "prompt") {
      out({ id: command.id, type: "response", command: "prompt", success: true });
      await agent.prompt(command.message);
      out({ type: "agent_settled" });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
