import type { AgentToolResult, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  reportedResultSchema,
  type FrozenWorker,
  type ReportedResult,
} from "../contracts/index.ts";
import { piParameters } from "../pi/schema.ts";
import { guardToolCall } from "./guard.ts";

export const reportTool = "submit_result";

export function workerExtension(options: {
  worker: FrozenWorker;
  root: string;
  codemode: boolean;
  onReport(report: ReportedResult): Promise<void>;
  onReportingError(value: unknown, message: string): Promise<void>;
  beforeRequest(): Promise<void>;
}): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: reportTool,
      label: "Report result",
      description:
        "Optionally report your result and observed evidence. Checks and assessments are attributed claims; the coordinator decides acceptance.",
      parameters: piParameters(reportedResultSchema),
      executionMode: "sequential",
      async execute(
        _id,
        value,
      ): Promise<AgentToolResult<{ report?: ReportedResult; reportingError?: string }>> {
        const parsed = reportedResultSchema.safeParse(value);
        if (!parsed.success) {
          const message = parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ");
          await options.onReportingError(value, message);
          return {
            content: [{ type: "text", text: `Report could not be parsed: ${message}` }],
            details: { reportingError: message },
            isError: true,
          };
        }
        await options.onReport(parsed.data);
        return {
          content: [{ type: "text", text: "Your report was recorded." }],
          details: { report: parsed.data },
          terminate: true,
        };
      },
    });
    pi.on("tool_call", async (event, context) => {
      const reason = await guardToolCall({
        worker: options.worker,
        root: options.root,
        cwd: context.cwd,
        name: event.toolName,
        input: event.input,
        runtimeTools: [reportTool, ...(options.codemode ? ["codemode"] : [])],
      });
      return reason ? { block: true, reason } : undefined;
    });
    pi.on("before_provider_request", async () => {
      await options.beforeRequest();
    });
  };
}
