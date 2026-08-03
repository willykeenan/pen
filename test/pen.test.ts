import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPenServer } from "../src/server.js";
import { AnnotationStore, defaultPenHome, PenStoreError } from "../src/store.js";
import { penComplete, penRead } from "../src/tools.js";
import type { AnnotationRecord } from "../src/types.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("KE_PEN_HOME overrides the platform data path", () => {
  assert.equal(defaultPenHome({ KE_PEN_HOME: "/tmp/ke-pen-contract" }), "/tmp/ke-pen-contract");
});

test("pen_read claims the image without clearing it, then pen_complete schedules the fade", async (t) => {
  const fixture = await createFixture("pending");
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));

  const before = await fixture.store.status();
  assert.equal(before.available, true);
  assert.equal((await fixture.store.current())?.status, "pending");

  const readResult = await penRead(fixture.store);
  assert.equal(readResult.content.length, 2);
  assert.equal(readResult.content[1]?.type, "image");
  assert.equal((await fixture.store.current())?.status, "reading");

  const completeResult = await penComplete(fixture.store, {
    id: fixture.record.id,
    summary: "The marked region contains a misaligned primary button.",
    delayMs: 250,
  });
  assert.equal(completeResult.isError, undefined);

  const completed = await fixture.store.current();
  assert.equal(completed?.status, "completing");
  assert.equal(completed?.completionSummary, "The marked region contains a misaligned primary button.");
  assert.equal(completed?.credit.creator, "William Keenan");
  assert.equal(completed?.credit.studio, "K&E Studios");
  assert.ok(completed?.clearAfter);
});

test("pen_read returns a bounded empty state when no ink is waiting", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ke-pen-empty-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const result = await penRead(new AnnotationStore(root));
  assert.equal(result.content.length, 1);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /No unread Pen annotation/);
});

test("image paths and annotation ids cannot escape the local Pen store", async (t) => {
  const fixture = await createFixture("pending");
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));

  await assert.rejects(() => fixture.store.read("../../etc/passwd"), PenStoreError);

  const malicious = { ...fixture.record, image: { ...fixture.record.image, file: "../outside.png" } };
  await fixture.store.write(malicious);
  await assert.rejects(() => fixture.store.claimCurrentForRead(), /outside its annotation directory/);
});

test("the MCP surface exposes exactly the three Pen lifecycle tools", async (t) => {
  const fixture = await createFixture("pending");
  const server = createPenServer(fixture.store);
  const client = new Client({ name: "pen-contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  t.after(async () => {
    await client.close();
    await server.close();
    await rm(fixture.root, { recursive: true, force: true });
  });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    ["pen_complete", "pen_read", "pen_status"],
  );

  const status = await client.callTool({ name: "pen_status", arguments: {} });
  assert.equal(status.isError, undefined);
  assert.match(JSON.stringify(status.content), /Pen by KE Studios/);
});

async function createFixture(status: AnnotationRecord["status"]) {
  const root = await mkdtemp(join(tmpdir(), "ke-pen-test-"));
  const id = randomUUID();
  const annotationDirectory = join(root, "annotations", id);
  await mkdir(annotationDirectory, { recursive: true });
  await writeFile(join(annotationDirectory, "crop.png"), PNG);

  const now = new Date().toISOString();
  const record: AnnotationRecord = {
    schema: "dev.kestudios.pen.annotation.v1",
    id,
    status,
    createdAt: now,
    updatedAt: now,
    source: {
      appName: "Test App",
      bundleIdentifier: "dev.kestudios.test",
      displayID: 1,
      screenFramePoints: { x: 0, y: 0, width: 1440, height: 900 },
    },
    selection: {
      strokeBoundsPoints: { x: 10, y: 10, width: 100, height: 80 },
      cropRectPixels: { x: 0, y: 0, width: 1, height: 1 },
      normalizedStrokes: [[{ x: 0.2, y: 0.3, t: 0 }]],
      coordinateNote: "top-left",
    },
    image: {
      file: "crop.png",
      mimeType: "image/png",
      width: 1,
      height: 1,
      sha256: createHash("sha256").update(PNG).digest("hex"),
      includesInk: true,
    },
    credit: {
      creator: "William Keenan",
      studio: "K&E Studios",
      url: "https://kestudios.dev/?ref=pen",
      product: "Pen",
    },
  };

  await writeFile(join(annotationDirectory, "annotation.json"), `${JSON.stringify(record, null, 2)}\n`);
  await writeFile(
    join(root, "current.json"),
    `${JSON.stringify({ schema: "dev.kestudios.pen.current.v1", id }, null, 2)}\n`,
  );

  // Prove the fixture on disk is the same object the store validates.
  const stored = JSON.parse(await readFile(join(annotationDirectory, "annotation.json"), "utf8"));
  assert.equal(stored.id, id);

  return { root, store: new AnnotationStore(root), record };
}

