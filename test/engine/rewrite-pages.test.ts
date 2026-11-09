import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalJson,
  toolPageSchema,
  type ArtifactPort,
  type ArtifactRef,
} from "../../engine/contracts/index.ts";
import { digestBytes } from "../../engine/storage/io.ts";
import { ToolPages, toolContentBytes } from "../../engine/sources/pages.ts";

function artifacts() {
  const values = new Map<string, Buffer>();
  const port: ArtifactPort = {
    async put(value) {
      const bytes = Buffer.from(value);
      const ref = { digest: digestBytes(bytes), size: bytes.length };
      values.set(ref.digest, bytes);
      return ref;
    },
    async read(ref) {
      const bytes = values.get(ref.digest);
      if (!bytes) throw new Error("Missing fixture artifact");
      return bytes;
    },
  };
  return { values, port };
}

test("bounded tool pages retain exact large JSON including Unicode and escape-heavy fragments", async () => {
  const stored = artifacts();
  const pages = new ToolPages({ artifacts: stored.port, scope: "run-one" });
  const small = { status: "accepted", assignments: [{ worker: "a", assignment: 1 }] };
  assert.equal(await pages.format(small), canonicalJson(small));
  assert.equal(stored.values.size, 0);
  const original = {
    status: "ok",
    tasks: Array.from({ length: 80 }, (_, index) => ({
      id: `worker-${index}`,
      text: '👩🏽‍💻 家族 e\u0301\\"\n\r\t'.repeat(300),
    })),
  };
  const first = await pages.format(original);
  assert(Buffer.byteLength(first) <= toolContentBytes);
  let page = toolPageSchema.parse(JSON.parse(first));
  let complete = page.text;
  let count = 1;
  while (!page.complete) {
    assert(page.nextCursor);
    const next = await pages.read(page.nextCursor);
    assert.equal(next.offset, page.nextOffset);
    assert.equal(next.digest, page.digest);
    assert(Buffer.byteLength(canonicalJson(next)) <= toolContentBytes);
    complete += next.text;
    page = next;
    count++;
  }
  assert(count > 2);
  assert.equal(Buffer.byteLength(complete), page.totalBytes);
  assert.equal(complete, canonicalJson(original));
  assert.deepEqual(JSON.parse(complete), original);
});

test("tool page cursors cannot select arbitrary evidence, cross hosts or hide changed retained bytes", async () => {
  const stored = artifacts();
  const pages = new ToolPages({ artifacts: stored.port, scope: "run-one" });
  const first = toolPageSchema.parse(JSON.parse(await pages.format({ text: "x".repeat(100_000) })));
  assert(first.nextCursor);
  const second = await pages.read(first.nextCursor);
  const secret: ArtifactRef = await stored.port.put(Buffer.from("unrelated private evidence"));
  const forgedPayload = Buffer.from(canonicalJson({ artifact: secret, offset: 0 })).toString(
    "base64url",
  );
  const forged = `${forgedPayload}.${first.nextCursor.split(".")[1]}`;
  await assert.rejects(pages.read(forged), /re-query/);
  for (const scope of ["run-one", "run-two"])
    await assert.rejects(
      new ToolPages({ artifacts: stored.port, scope }).read(first.nextCursor),
      /another host/,
    );
  stored.values.set(first.digest, Buffer.from("replaced bytes"));
  await assert.rejects(pages.read(first.nextCursor), /unavailable or changed/);
  assert.equal(second.text, "x".repeat(Buffer.byteLength(second.text)));
});

test("paging publication failure preserves a bounded recovery message without implying mutation rejection", async () => {
  const stored = artifacts();
  const pages = new ToolPages({
    artifacts: {
      ...stored.port,
      async put() {
        throw new Error("fixture disk full");
      },
    },
    scope: "run-one",
  });
  const value = {
    status: "accepted",
    requestId: "retain-this-request",
    results: "x".repeat(100_000),
  };
  const content = await pages.format(value);
  assert(Buffer.byteLength(content) <= toolContentBytes);
  assert.match(content, /original reply remains in tool details/);
  assert.match(content, /do not repeat a mutation under a new request ID/);
  assert.equal(value.status, "accepted");
});
