// The agent extension runs inside every agent, whatever the backend. It registers
// `submit_result` with the role's schema and guards tool calls: tools outside the loadout are
// blocked, readers cannot write, and builders can only edit owned paths inside their
// worktree. Codemode's nested calls go through `tool_call` too, so they cannot bypass it.
//
// In process it is loaded inline with its options. Out of process (`--extension`), the default
// export reads them from PINATA_AGENT_OPTIONS (JSON) or the file named by
// PINATA_AGENT_OPTIONS_FILE.
import { readFileSync } from "node:fs";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { ResultError, resultSchema, validateResult } from "../core/results.ts";
import type { AgentOptions, AgentResult } from "../core/types.ts";
import { PathError, checkWrite } from "../workspace/paths.ts";
import { detachedControl, type DetachedOptions } from "./detached.ts";

export const SUBMIT = "submit_result";
const WRITE_TOOLS = new Set(["edit", "write", "bash", "powershell"]);

export interface AgentExtensionOptions extends AgentOptions {
  codemode?: boolean;
  // Out of process and detached: the control file, reminder and budgets (agent/detached.ts).
  detached?: DetachedOptions;
}

// What the agent extension reports to its host.
export interface AgentReporter {
  result(result: AgentResult): void;
}

const SUBMIT_DESCRIPTION =
  "Report your final result to the coordinator. Call it exactly once, when you are done, with every required field. " +
  "The coordinator verifies changed files and runs checks itself; report only what you actually observed. " +
  "If the call returns an error, fix what it names and call it again.";

export function allowedTools(opts: AgentExtensionOptions): Set<string> {
  return new Set([...opts.tools, SUBMIT, ...(opts.codemode ? ["codemode"] : [])]);
}

// Decides whether one tool call may run. Returns a reason the model can act on, or null.
export function guard(
  opts: AgentExtensionOptions,
  allowed: ReadonlySet<string>,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): string | null {
  if (!allowed.has(toolName))
    return `${toolName} is not available to the ${opts.role} role. Use only: ${[...allowed].join(", ")}.`;
  if (!WRITE_TOOLS.has(toolName)) return null;
  if (opts.readOnly)
    return `The ${opts.role} role is read-only: ${toolName} is not allowed. Report what should change in submit_result instead.`;
  if (toolName === "edit" || toolName === "write") {
    if (!opts.writeRoot) return "This agent has no writable workspace.";
    try {
      checkWrite(
        opts.writeRoot,
        cwd,
        String(input.path ?? ""),
        opts.ownership,
        opts.caseInsensitive,
      );
    } catch (error) {
      if (error instanceof PathError)
        return `${error.message}. Write only inside your ownership: ${opts.ownership.join(", ")}. If the task needs other files, report a blocker.`;
      throw error;
    }
  }
  return null;
}

export function agentExtension(
  opts: AgentExtensionOptions,
  reporter?: AgentReporter,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const allowed = allowedTools(opts);
    const schema = resultSchema(opts.role);
    pi.registerTool({
      name: SUBMIT,
      label: "Submit result",
      description: SUBMIT_DESCRIPTION,
      parameters: schema,
      executionMode: "sequential",
      async execute(_id, params): Promise<AgentToolResult<Record<string, unknown>>> {
        let result: AgentResult;
        try {
          result = validateResult(params as AgentResult, {
            role: opts.role,
            reviewTarget: opts.reviewTarget,
          });
        } catch (error) {
          if (!(error instanceof ResultError)) throw error;
          return {
            content: [
              {
                type: "text",
                text: `submit_result rejected: ${error.message} Call submit_result again with the fix.`,
              },
            ],
            details: { pinataError: error.message },
            isError: true,
          };
        }
        reporter?.result(result);
        return {
          content: [{ type: "text", text: "Result recorded. Your work is done; stop here." }],
          // Out of process, the host reads the result from this tool result's details.
          details: { pinataResult: result },
          terminate: true,
        };
      },
    });
    pi.on("tool_call", (event, ctx) => {
      const reason = guard(
        opts,
        allowed,
        event.toolName,
        (event.input ?? {}) as Record<string, unknown>,
        ctx.cwd,
      );
      return reason ? { block: true, reason } : undefined;
    });
  };
}

export function readOptions(env: NodeJS.ProcessEnv = process.env): AgentExtensionOptions | null {
  const raw =
    env.PINATA_AGENT_OPTIONS ??
    (env.PINATA_AGENT_OPTIONS_FILE ? readFileSync(env.PINATA_AGENT_OPTIONS_FILE, "utf8") : null);
  if (!raw) return null;
  const opts = JSON.parse(raw) as AgentExtensionOptions;
  if (!opts || typeof opts.role !== "string" || !Array.isArray(opts.tools))
    throw new Error("Invalid PINATA_AGENT_OPTIONS");
  return opts;
}

// Out-of-process entry point (`pi --extension engine/agent/extension.ts`).
export default function (pi: ExtensionAPI) {
  const opts = readOptions();
  if (!opts) return;
  let submitted = false;
  agentExtension(opts, { result: () => (submitted = true) })(pi);
  if (opts.detached) detachedControl(pi, opts.detached, () => submitted);
}
