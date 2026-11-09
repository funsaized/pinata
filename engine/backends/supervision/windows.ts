import { z } from "zod";
import { identitySchema, revisionSchema, textSchema } from "../../contracts/common.ts";
import { cleanupReceiptSchema } from "../../contracts/backend.ts";

// Windows is a separate launcher contract. A process ID and taskkill invocation
// cannot implement creation-time Job Object enrollment or prove descendant cleanup.
export const windowsLaunchSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: z.uuid(),
  ownerEpoch: identitySchema,
  executable: textSchema,
  arguments: z.array(z.string()),
  workingDirectory: textSchema,
  environment: z.record(z.string(), z.string()),
  invocation: z.enum(["executable", "cmd"]),
  lifetime: z.enum(["attached", "surviving"]),
});
export const windowsJobEnrollmentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: z.uuid(),
  ownerEpoch: identitySchema,
  launcherId: z.uuid(),
  jobName: textSchema,
  rootPid: revisionSchema.positive(),
  creationIdentity: textSchema,
  membership: z.literal("creation-time-job-list"),
  killOnClose: z.literal(true),
});
export const windowsHelperSelection = Object.freeze({
  name: "PinataJobLauncher",
  implementation: "source-packaged C# with explicit Win32 interop",
  enrollment: "STARTUPINFOEX PROC_THREAD_ATTRIBUTE_JOB_LIST",
  minimumWindows: "Windows 10 / Windows Server 2016",
  verification: "native-job-contract" as const,
  available: true as const,
});

export type WindowsSupervisorPort = {
  launch(
    request: z.infer<typeof windowsLaunchSchema>,
  ): Promise<z.infer<typeof windowsJobEnrollmentSchema>>;
  stop(request: {
    launcherId: string;
    ownerEpoch: string;
    jobName: string;
  }): Promise<z.infer<typeof cleanupReceiptSchema>>;
};
