import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import test from "node:test";
import { assertOwnerDead } from "../../engine/storage/owner.ts";

test(
  "a Linux owner from a previous boot is dead even when its PID has been reused",
  { skip: process.platform !== "linux" },
  async () => {
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const owner = {
      schemaVersion: 1 as const,
      host: hostname(),
      pid: process.pid,
      startIdentity: `linux:${boot}:0`,
      token: "token",
      epoch: "epoch",
    };
    // Different process ticks in the same boot do not authorize ownership theft.
    assert.throws(() => assertOwnerDead(owner), /PID is live/);
    const previous = { ...owner, startIdentity: `linux:${randomUUID()}:0` };
    assert.doesNotThrow(() => assertOwnerDead(previous));
    assert.throws(
      () => assertOwnerDead({ ...previous, host: `${hostname()}-remote` }),
      /Remote owner/,
    );
    assert.throws(
      () => assertOwnerDead({ ...owner, startIdentity: "linux:not-a-boot-id:0" }),
      /PID is live/,
    );
  },
);
