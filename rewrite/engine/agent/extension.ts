import type { AgentToolResult, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  reportedResultSchema,
  schemaRegistry,
  DomainError,
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
  runtimeTools?: readonly string[];
  outputType?: string;
  onReport(report: ReportedResult): Promise<void>;
  onReportingError(value: unknown, message: string): Promise<void>;
  beforeRequest(): Promise<void>;
}): ExtensionFactory {
  const outputSchema = options.outputType
    ? Object.entries(schemaRegistry).find(([name]) => name === options.outputType)?.[1]
    : undefined;
  if (options.outputType && !outputSchema)
    throw new DomainError("unsupported", `Unknown output schema ${options.outputType}`);
  const reportSchema =
    outputSchema && options.outputType !== "pinata.result.v1"
      ? reportedResultSchema.extend({ data: outputSchema })
      : reportedResultSchema;
  return (pi) => {
    pi.registerTool({
      name: reportTool,
      label: "Report result",
      description:
        "Optionally report your result and observed evidence. Checks and assessments are attributed claims; the coordinator decides acceptance.",
      parameters: piParameters(reportSchema),
      executionMode: "sequential",
      async execute(
        _id,
        value,
      ): Promise<AgentToolResult<{ report?: ReportedResult; reportingError?: string }>> {
        const parsed = reportSchema.safeParse(value);
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
        const report = reportedResultSchema.parse(parsed.data);
        await options.onReport(report);
        return {
          content: [{ type: "text", text: "Your report was recorded." }],
          details: { report },
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
        runtimeTools: [
          reportTool,
          ...(options.codemode ? ["codemode"] : []),
          ...(options.runtimeTools ?? []),
        ],
      });
      return reason ? { block: true, reason } : undefined;
    });
    pi.on("before_provider_request", async () => {
      await options.beforeRequest();
    });
  };
}
