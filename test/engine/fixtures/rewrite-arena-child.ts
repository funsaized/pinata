import { runMatrix } from "../../../arena/matrix.ts";
import { defaultCondition, defaultLimits } from "../../../arena/runner.ts";
import { startCell } from "../../../arena/ledger.ts";

const adapter = { kind: "offline", mode: "known-good" } as const;
await runMatrix(
  {
    schemaVersion: 1,
    rounds: 2,
    tasks: [{ id: "checkout" }],
    conditions: [{ name: "control", adapter, requested: defaultCondition(adapter, "sequential") }],
    limits: defaultLimits,
  },
  {
    out: process.argv[2],
    repositoryRoot: process.argv[3],
    afterBatchAllocated: async (batch) => {
      await startCell(batch, batch.cells[0].cell.id);
      process.stdout.write(
        `${JSON.stringify({ batch: batch.directory, cell: batch.cells[0].cell.id })}\n`,
      );
      await new Promise(() => setInterval(() => {}, 1000));
    },
  },
);
