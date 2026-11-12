import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import {
  numberedPath,
  processObservationSchema,
  processOutcomeSchema,
  processEnrollmentSchema,
  readRecord,
} from "./process-transport.ts";
import { ProcessSignals } from "./process-signals.ts";

const directory = process.argv[2];
if (!directory) throw new Error("A worker transport directory is required");
process.stdout.write("Pinata worker monitor · steer through the coordinator\n\n");
const enrollment = await readRecord(join(directory, "enrollment.json"), processEnrollmentSchema);
const signals = enrollment ? new ProcessSignals(enrollment.supervisor, "coordinator") : undefined;
await signals?.connect();
let ordinal = 1;
let offset = 0;
try {
  while (true) {
    const version = signals?.version ?? 0;
    const activity = signals?.activity;
    if (activity && activity.offset > offset) {
      const start = Math.max(0, offset - (activity.offset - activity.text.length));
      process.stdout.write(stripVTControlCharacters(activity.text.slice(start)));
      offset = activity.offset;
    }
    const record = await readRecord(
      numberedPath(directory, "observations", ordinal),
      processObservationSchema,
    );
    if (record) {
      if (record.ordinal !== ordinal)
        throw new Error("Worker monitor observation ordinal mismatch");
      if (record.observation.kind === "activity")
        process.stdout.write(stripVTControlCharacters(record.observation.text));
      ordinal++;
      continue;
    }
    const ended = await readRecord(join(directory, "outcome.json"), processOutcomeSchema);
    if (ended && ordinal > ended.throughOrdinal) {
      process.stdout.write(
        `\n\n[${ended.outcome.reason}] ${stripVTControlCharacters(ended.outcome.summary)}\n`,
      );
      break;
    }
    if (signals) await signals.wait(version);
    else await delay(50);
  }
} finally {
  signals?.close();
}
