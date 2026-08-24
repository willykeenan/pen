import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AgentVisualReferenceError,
  AgentVisualReferenceStore,
} from "../src/agent-visual-reference.js";
import { createPenServer } from "../src/server.js";
import { AnnotationStore } from "../src/store.js";
import type { AnnotationRecord } from "../src/types.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString("base64")}`;

test("one addressed reference is private, capability-bound, and idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ke-pen-agent-reference-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const referenceStore = new AgentVisualReferenceStore(new AnnotationStore(root));
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const input = {
    recipientId,
    direction: "Match the marked button radius and vertical spacing.",
    idempotencyKey: "ui-button-radius-proof-001",
    expiresInSeconds: 300,
    source: {
      kind: "png-data-url" as const,
      dataUrl: PNG_DATA_URL,
      includesInk: true,
      region: { x: 0, y: 0, width: 1, height: 1 },
    },
  };

  const created = await referenceStore.create(input, senderId);
  assert.equal(created.deduplicated, false);
  assert.equal(created.record.senderId, senderId);
  assert.equal(created.record.recipientId, recipientId);
  assert.equal(created.capability.length, 43);

  const referenceDirectory = join(
    root,
    "agent-visual-references",
    "references",
    created.record.referenceId,
  );
  const recordPath = join(referenceDirectory, "reference.json");
  const imagePath = join(referenceDirectory, "reference.png");
  const recordText = await readFile(recordPath, "utf8");
  assert.doesNotMatch(recordText, new RegExp(created.capability));
  assert.doesNotMatch(recordText, /ui-button-radius-proof-001/);
  if (process.platform !== "win32") {
    assert.equal((await stat(referenceDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(recordPath)).mode & 0o777, 0o600);
    assert.equal((await stat(imagePath)).mode & 0o777, 0o600);
    assert.equal(
      (await stat(join(root, "agent-visual-references", "capability-secret.bin"))).mode & 0o777,
      0o600,
    );
  }

  await assert.rejects(
    () =>
      referenceStore.read(
        { referenceId: created.record.referenceId, capability: created.capability },
        randomUUID(),
      ),
    /not addressed and authorized/,
  );
  await assert.rejects(
    () =>
      referenceStore.read(
        { referenceId: created.record.referenceId, capability: "A".repeat(43) },
        recipientId,
      ),
    /not addressed and authorized/,
  );

  const firstRead = await referenceStore.read(
    { referenceId: created.record.referenceId, capability: created.capability },
    recipientId,
  );
  assert.deepEqual(firstRead.image, PNG);
  assert.equal(firstRead.record.direction, input.direction);
  assert.ok(firstRead.record.deliveredAt);
  const secondRead = await referenceStore.read(
    { referenceId: created.record.referenceId, capability: created.capability },
    recipientId,
  );
  assert.equal(secondRead.record.deliveredAt, firstRead.record.deliveredAt);
  assert.equal(secondRead.deliveryReceipt, firstRead.deliveryReceipt);

  const retry = await referenceStore.create(input, senderId);
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.record.referenceId, created.record.referenceId);
  assert.equal(retry.capability, created.capability);
  assert.deepEqual(
    await readdir(join(root, "agent-visual-references", "references")),
    [created.record.referenceId],
  );

  await assert.rejects(
    () =>
      referenceStore.create(
        { ...input, direction: "A conflicting direction must fail closed." },
        senderId,
      ),
    /idempotency key is already bound/,
  );
});

test("references expire, are removed, and do not revive an old capability", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ke-pen-agent-expiry-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let now = new Date("2026-08-24T20:00:00.000Z");
  const referenceStore = new AgentVisualReferenceStore(
    new AnnotationStore(root),
    () => now,
  );
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const input = {
    recipientId,
    direction: "Inspect the highlighted state.",
    idempotencyKey: "short-lived-reference-001",
    expiresInSeconds: 60,
    source: { kind: "png-data-url" as const, dataUrl: PNG_DATA_URL },
  };
  const first = await referenceStore.create(input, senderId);
  now = new Date("2026-08-24T20:01:01.000Z");
  await assert.rejects(
    () =>
      referenceStore.read(
        { referenceId: first.record.referenceId, capability: first.capability },
        recipientId,
      ),
    /expired and was removed/,
  );

  const replacement = await referenceStore.create(input, senderId);
  assert.equal(replacement.record.referenceId, first.record.referenceId);
  assert.notEqual(replacement.capability, first.capability);
  await assert.rejects(
    () =>
      referenceStore.read(
        { referenceId: replacement.record.referenceId, capability: first.capability },
        recipientId,
      ),
    /not addressed and authorized/,
  );
});

test("an inked Pen annotation can be referenced without changing the human lifecycle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ke-pen-agent-marked-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const annotationStore = new AnnotationStore(root);
  const annotation = buildAnnotation();
  await annotationStore.create(annotation, PNG);
  const before = await annotationStore.current();
  const referenceStore = new AgentVisualReferenceStore(annotationStore);
  const recipientId = randomUUID();
  const created = await referenceStore.create(
    {
      recipientId,
      direction: "Use the circled spacing as the visual target.",
      idempotencyKey: "marked-region-reference-001",
      source: { kind: "pen-annotation", annotationId: annotation.id },
    },
    randomUUID(),
  );
  const after = await annotationStore.current();
  assert.equal(after?.id, before?.id);
  assert.equal(after?.status, "pending");
  assert.equal(after?.updatedAt, before?.updatedAt);
  assert.equal(created.record.sourceKind, "pen-annotation");
  assert.equal(created.record.image.includesInk, true);
  assert.equal(JSON.stringify(created.record).includes(annotation.id), false);
});

test("malformed PNGs, out-of-bounds regions, and self-addressing fail closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ke-pen-agent-bounds-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const referenceStore = new AgentVisualReferenceStore(new AnnotationStore(root));
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const base = {
    recipientId,
    direction: "Bounded visual direction.",
    idempotencyKey: "bounded-reference-001",
  };

  await assert.rejects(
    () =>
      referenceStore.create(
        {
          ...base,
          source: {
            kind: "png-data-url",
            dataUrl: `data:image/png;base64,${Buffer.from("not a PNG").toString("base64")}`,
          },
        },
        senderId,
      ),
    /not a valid PNG/,
  );
  await assert.rejects(
    () =>
      referenceStore.create(
        {
          ...base,
          source: {
            kind: "png-data-url",
            dataUrl: PNG_DATA_URL,
            region: { x: 0, y: 0, width: 2, height: 1 },
          },
        },
        senderId,
      ),
    /stay inside/,
  );
  const oversizedDimensions = Buffer.from(PNG);
  oversizedDimensions.writeUInt32BE(8_193, 16);
  await assert.rejects(
    () =>
      referenceStore.create(
        {
          ...base,
          source: {
            kind: "png-data-url",
            dataUrl: `data:image/png;base64,${oversizedDimensions.toString("base64")}`,
          },
        },
        senderId,
      ),
    /dimensions exceed/,
  );
  await assert.rejects(
    () =>
      referenceStore.create(
        { ...base, recipientId: senderId, source: { kind: "png-data-url", dataUrl: PNG_DATA_URL } },
        senderId,
      ),
    /one different recipient/,
  );
});

test("the reference implementation has no UI, capture, clipboard, network, or Agent Display bridge", async () => {
  const implementation = `${await readFile(
    new URL("../src/agent-visual-reference.ts", import.meta.url),
    "utf8",
  )}\n${await readFile(
    new URL("../src/agent-visual-reference-tools.ts", import.meta.url),
    "utf8",
  )}`;
  for (const forbidden of [
    "from \"electron\"",
    "node:http",
    "node:https",
    "fetch(",
    "desktopCapturer",
    "clipboard",
    "Notification",
    "agent-display",
    "penDisplay",
    "send_message",
  ]) {
    assert.equal(
      implementation.includes(forbidden),
      false,
      `agent visual references must not contain ${forbidden}`,
    );
  }
});

test("two MCP runtimes complete an addressed sender-to-recipient handoff", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ke-pen-agent-mcp-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const annotationStore = new AnnotationStore(root);
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const senderServer = createPenServer(annotationStore, { agentId: senderId });
  const recipientServer = createPenServer(annotationStore, { agentId: recipientId });
  const senderClient = new Client({ name: "pen-reference-sender", version: "1.0.0" });
  const recipientClient = new Client({ name: "pen-reference-recipient", version: "1.0.0" });
  const [senderClientTransport, senderServerTransport] = InMemoryTransport.createLinkedPair();
  const [recipientClientTransport, recipientServerTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await senderClient.close();
    await recipientClient.close();
    await senderServer.close();
    await recipientServer.close();
  });
  await Promise.all([
    senderServer.connect(senderServerTransport),
    senderClient.connect(senderClientTransport),
    recipientServer.connect(recipientServerTransport),
    recipientClient.connect(recipientClientTransport),
  ]);

  const createResult = await senderClient.callTool({
    name: "pen_agent_reference_create",
    arguments: {
      recipientId,
      direction: "Align the recipient UI to the marked pixel reference.",
      idempotencyKey: "mcp-sender-recipient-proof-001",
      source: { kind: "png-data-url", dataUrl: PNG_DATA_URL, includesInk: true },
    },
  });
  assert.equal(createResult.isError, undefined);
  const createContent = createResult.content as Array<{
    type: string;
    text?: string;
  }>;
  assert.equal(createContent[0]?.type, "text");
  const createText =
    createContent[0]?.type === "text" ? createContent[0].text ?? "{}" : "{}";
  assert.doesNotMatch(createText, /Align the recipient UI/);
  assert.doesNotMatch(createText, /data:image\/png/);
  const created = JSON.parse(createText) as {
    sent: boolean;
    routingEnvelope: { referenceId: string; capability: string; recipientId: string };
  };
  assert.equal(created.sent, false);
  assert.equal(created.routingEnvelope.recipientId, recipientId);

  const readResult = await recipientClient.callTool({
    name: "pen_agent_reference_read",
    arguments: {
      referenceId: created.routingEnvelope.referenceId,
      capability: created.routingEnvelope.capability,
    },
  });
  assert.equal(readResult.isError, undefined);
  const readContent = readResult.content as Array<{
    type: string;
    text?: string;
    data?: string;
  }>;
  assert.equal(readContent.length, 2);
  assert.equal(readContent[1]?.type, "image");
  assert.match(JSON.stringify(readContent[0]), /Align the recipient UI/);
  assert.match(JSON.stringify(readContent[0]), /Visual context and direction only/);
});

function buildAnnotation(): AnnotationRecord {
  const now = new Date().toISOString();
  return {
    schema: "dev.kestudios.pen.annotation.v1",
    id: randomUUID(),
    status: "pending",
    createdAt: now,
    updatedAt: now,
    source: {
      appName: "Synthetic Test Surface",
      bundleIdentifier: "dev.kestudios.pen.test",
      displayID: 1,
      screenFramePoints: { x: 0, y: 0, width: 1, height: 1 },
    },
    selection: {
      strokeBoundsPoints: { x: 0, y: 0, width: 1, height: 1 },
      cropRectPixels: { x: 0, y: 0, width: 1, height: 1 },
      normalizedStrokes: [[{ x: 0, y: 0, t: 0 }]],
      coordinateNote: "Synthetic one-pixel marked region.",
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
}
