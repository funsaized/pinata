import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { incidentPhases, runPricesIncident } from "./rewrite-prices-incident.ts";

test(
  "historical prices public task resolves existing dependencies across acceptance, follow-up, settlement and fresh Pi RPC recovery",
  { timeout: 120_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "pinata-prices-incident-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const command = [
      process.execPath,
      fileURLToPath(
        new URL(
          "../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
          import.meta.url,
        ),
      ),
    ];
    for (const phase of incidentPhases) {
      const result = await runPricesIncident({ directory: join(directory, phase), phase, command });
      assert(result.acceptedRevision > result.beforeRevision);
    }
    const historical = JSON.parse(
      await readFile(new URL("./fixtures/rewrite-prices-incident.json", import.meta.url), "utf8"),
    );
    assert.equal(historical.historicalStatus, "unexplained");
    assert.match(JSON.stringify(historical.response), /Worker audit: unknown dependency prices/);
  },
);
