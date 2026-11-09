import { z } from "zod";
import { dependencyQuerySchema } from "../contracts/dependencies.ts";
import { toolPageRequestSchema } from "../contracts/pages.ts";
import {
  childCommandEnvelopeSchema,
  childQuerySchema,
  childWaitSchema,
  memoryClearSchema,
  memoryEditSchema,
  reportedResultSchema,
} from "../contracts/index.ts";

// These are the schemas registered by the worker extensions. Discovery never
// grants the corresponding tools; availability follows the frozen worker grants.
export const workerToolSchemas = {
  pinata_page: {
    input: toolPageRequestSchema,
    output: "pinata.tool-page-reply.v1",
    availability:
      "Only for previously returned child-tool output in this worker's current session; cursors do not grant arbitrary artifact access.",
  },
  pinata_dependency: {
    input: dependencyQuerySchema,
    output: "pinata.dependency-page.v1",
    availability:
      "Only for immutable dependency results assigned to this worker; pages contain complete result JSON, not the contents of referenced report or transcript artifacts.",
  },
  submit_result: {
    input: reportedResultSchema,
    output: "pinata.report-tool-result.v1",
    availability: "Optional reporting; outputType may refine the data field.",
  },
  pinata_children: {
    input: childCommandEnvelopeSchema,
    output: "pinata.receipt.v1",
    availability: "Only with an explicit scoped delegation grant.",
  },
  pinata_child_status: {
    input: childQuerySchema,
    output: "pinata.child-query-result.v1",
    availability: "Only with an explicit scoped delegation grant.",
  },
  pinata_child_wait: {
    input: childWaitSchema,
    output: "pinata.child-wait-result.v1",
    availability: "Only with an explicit scoped delegation grant.",
  },
  pinata_memory_read: {
    input: z.strictObject({}),
    output: "pinata.memory-snapshot.v1",
    availability: "Only with an explicit worker or project-agent memory grant.",
  },
  pinata_memory_edit: {
    input: memoryEditSchema,
    output: "pinata.memory-snapshot.v1",
    availability: "Only with an explicit scoped memory write grant; revision checked.",
  },
  pinata_memory_clear: {
    input: memoryClearSchema,
    output: "pinata.memory-snapshot.v1",
    availability: "Only with an explicit scoped memory write grant; revision checked.",
  },
} as const;
