import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import {
  numberedPath,
  processObservationSchema,
  processOutcomeSchema,
  readRecord,
} from "./process-transport.ts";

const directory = process.argv[2];
if (!directory) throw new Error("A worker transport directory is required");
process.stdout.write("Pinata worker monitor · steer through the coordinator\n\n");
let ordinal = 1;
while (true) {
  const record = await readRecord(
    numberedPath(directory, "observations", ordinal),
    processObservationSchema,
  );
  if (record) {
    if (record.ordinal !== ordinal) throw new Error("Worker monitor observation ordinal mismatch");
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
  await delay(50);
}
