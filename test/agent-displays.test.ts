import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentDisplayBroker } from "../desktop/agent-display-broker.js";
import { AgentDisplayError, AgentDisplayRegistry } from "../desktop/agent-display-registry.js";
import { AgentDisplayClient } from "../src/agent-display-client.js";
import {
  agentDisplayResourceAllowed,
  agentDisplayActionSchema,
  agentDisplayRuntimePaths,
  normalizeAgentDisplayTarget,
} from "../src/agent-display-protocol.js";

test("agent displays accept only localhost or loopback test origins", () => {
  assert.equal(normalizeAgentDisplayTarget("http://127.0.0.1:3000/test?case=1#target").origin, "http://127.0.0.1:3000");
  assert.equal(normalizeAgentDisplayTarget("https://localhost:8443/fixture").origin, "https://localhost:8443");
  assert.throws(() => normalizeAgentDisplayTarget("https://example.com"), /local test surfaces/);
  assert.throws(() => normalizeAgentDisplayTarget("file:///etc/passwd"), /local test surfaces/);
  assert.throws(() => normalizeAgentDisplayTarget("http://user:secret@localhost:3000"), /credentials/);
});

test("a loopback surface cannot fetch public or cross-origin subresources", () => {
  const fixturePrefix = "file:///Applications/KE%20Pen.app/Contents/Resources/agent-ui/";
  const origin = "http://127.0.0.1:4173";
  assert.equal(agentDisplayResourceAllowed(`${fixturePrefix}surface.css`, fixturePrefix, null), true);
  assert.equal(agentDisplayResourceAllowed("http://127.0.0.1:4173/app.js", fixturePrefix, origin), true);
  assert.equal(agentDisplayResourceAllowed("ws://127.0.0.1:4173/hmr", fixturePrefix, origin), true);
  assert.equal(agentDisplayResourceAllowed("blob:http://127.0.0.1:4173/example", fixturePrefix, origin), true);
  assert.equal(agentDisplayResourceAllowed("https://example.com/tracker.js", fixturePrefix, origin), false);
  assert.equal(agentDisplayResourceAllowed("http://localhost:4173/other.js", fixturePrefix, origin), false);
  assert.equal(agentDisplayResourceAllowed("file:///etc/passwd", fixturePrefix, origin), false);
});

test("each exact agent task gets one isolated capability and no token is persisted", async (t) => {
  const fixture = await registryFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const first = await fixture.registry.claim({
    agentId: "codex:agent-one",
    taskId: "task-a",
    label: "Agent one",
    width: 1_440,
    height: 900,
  });
  const second = await fixture.registry.claim({
    agentId: "codex:agent-two",
    taskId: "task-b",
    label: "Agent two",
    width: 1_280,
    height: 800,
  });
  assert.notEqual(first.session.sessionId, second.session.sessionId);
  assert.notEqual(first.ownerToken, second.ownerToken);
  await assert.rejects(
    () =>
      fixture.registry.claim({
        agentId: "codex:agent-one",
        taskId: "task-a",
        label: "Duplicate",
        width: 1_440,
        height: 900,
      }),
    (error: unknown) => error instanceof AgentDisplayError && error.code === "DISPLAY_ALREADY_CLAIMED",
  );
  const state = await readFile(fixture.stateFile, "utf8");
  assert.doesNotMatch(state, new RegExp(first.ownerToken));
  assert.doesNotMatch(state, new RegExp(second.ownerToken));
  assert.match(state, /"tokenHash": "[a-f0-9]{64}"/);
});

test("independent agents can move concurrently without crossing session or controller state", async (t) => {
  const fixture = await registryFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const first = await fixture.registry.claim({
    agentId: "codex:parallel-one",
    taskId: "task-one",
    label: "Parallel one",
    width: 1_440,
    height: 900,
  });
  const second = await fixture.registry.claim({
    agentId: "codex:parallel-two",
    taskId: "task-two",
    label: "Parallel two",
    width: 900,
    height: 700,
  });

  const [firstMoved, secondMoved] = await Promise.all([
    fixture.registry.recordAction(first.session.sessionId, first.ownerToken, {
      type: "move",
      x: 111,
      y: 222,
    }),
    fixture.registry.recordAction(second.session.sessionId, second.ownerToken, {
      type: "move",
      x: 777,
      y: 555,
    }),
  ]);
  assert.deepEqual([firstMoved.cursor.x, firstMoved.cursor.y], [111, 222]);
  assert.deepEqual([secondMoved.cursor.x, secondMoved.cursor.y], [777, 555]);
  assert.equal(firstMoved.controller, "agent");
  assert.equal(secondMoved.controller, "agent");
  const persisted = JSON.parse(await readFile(fixture.stateFile, "utf8")) as {
    sessions: Array<{ sessionId: string; cursor: { x: number; y: number } }>;
  };
  const persistedFirst = persisted.sessions.find(
    (session) => session.sessionId === first.session.sessionId,
  );
  const persistedSecond = persisted.sessions.find(
    (session) => session.sessionId === second.session.sessionId,
  );
  assert.deepEqual([persistedFirst?.cursor.x, persistedFirst?.cursor.y], [111, 222]);
  assert.deepEqual([persistedSecond?.cursor.x, persistedSecond?.cursor.y], [777, 555]);
  assert.throws(
    () => fixture.registry.requireAgent(first.session.sessionId, second.ownerToken),
    (error: unknown) => error instanceof AgentDisplayError && error.code === "INVALID_DISPLAY_TOKEN",
  );
});

test("human handoff pauses the agent, return restores it, and Stop revokes the surface", async (t) => {
  const fixture = await registryFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const claimed = await fixture.registry.claim({
    agentId: "codex:handoff",
    taskId: "safe-control",
    label: "Handoff proof",
    width: 1_440,
    height: 900,
  });
  await fixture.registry.takeHumanControl(claimed.session.sessionId);
  assert.throws(
    () => fixture.registry.requireAgent(claimed.session.sessionId, claimed.ownerToken),
    (error: unknown) => error instanceof AgentDisplayError && error.code === "HUMAN_HAS_CONTROL",
  );
  const human = await fixture.registry.recordHumanAction(claimed.session.sessionId, {
    type: "click",
    x: 120,
    y: 80,
    button: "left",
  });
  assert.equal(human.lastAction, "human_clicked");
  await fixture.registry.returnAgentControl(claimed.session.sessionId);
  assert.doesNotThrow(() => fixture.registry.requireAgent(claimed.session.sessionId, claimed.ownerToken));
  const stopped = await fixture.registry.stop(claimed.session.sessionId, {
    token: claimed.ownerToken,
    reason: "Test complete.",
  });
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.controller, "none");
  assert.throws(() => fixture.registry.requireAgent(stopped.sessionId, claimed.ownerToken), /stopped/);
});

test("typed text and URL paths are never retained in the redacted session ledger", async (t) => {
  const fixture = await registryFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const claimed = await fixture.registry.claim({
    agentId: "codex:redaction",
    taskId: "private-fixture",
    label: "Redaction proof",
    width: 1_440,
    height: 900,
  });
  await fixture.registry.setTargetOrigin(
    claimed.session.sessionId,
    claimed.ownerToken,
    "http://127.0.0.1:4173",
  );
  await fixture.registry.recordAction(claimed.session.sessionId, claimed.ownerToken, {
    type: "type",
    text: "DO-NOT-PERSIST-THIS-SECRET",
  });
  const state = await readFile(fixture.stateFile, "utf8");
  assert.doesNotMatch(state, /DO-NOT-PERSIST-THIS-SECRET/);
  assert.doesNotMatch(state, /private-fixture-path|query-token/);
  assert.match(state, /typed_redacted_text/);
  assert.match(state, /http:\/\/127\.0\.0\.1:4173/);
});

test("startup interrupts orphaned surfaces and exact identity can recover with a rotated token", async (t) => {
  const fixture = await registryFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const claimed = await fixture.registry.claim({
    agentId: "codex:recovery",
    taskId: "task-recovery",
    label: "Recovery proof",
    width: 1_440,
    height: 900,
  });
  const restarted = new AgentDisplayRegistry(fixture.stateFile);
  await restarted.loadAndInterrupt();
  assert.equal(restarted.list()[0]?.state, "interrupted");
  assert.equal(restarted.list()[0]?.controller, "none");
  const recovered = await restarted.claim({
    agentId: "codex:recovery",
    taskId: "task-recovery",
    label: "Recovery proof",
    width: 1_440,
    height: 900,
  });
  assert.equal(recovered.session.sessionId, claimed.session.sessionId);
  assert.notEqual(recovered.ownerToken, claimed.ownerToken);
  assert.throws(() => restarted.requireAgent(recovered.session.sessionId, claimed.ownerToken), /token/);
});

test("stale authenticated sessions expire and cannot keep a controller", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ke-pen-display-stale-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let clock = new Date("2026-08-24T22:00:00.000Z");
  const registry = new AgentDisplayRegistry(join(root, "sessions.json"), () => clock);
  await registry.loadAndInterrupt();
  const claimed = await registry.claim({
    agentId: "codex:stale",
    taskId: "stale-task",
    label: "Stale proof",
    width: 1_440,
    height: 900,
  });
  clock = new Date("2026-08-24T22:31:00.000Z");
  assert.deepEqual(await registry.cleanupStale(), [claimed.session.sessionId]);
  assert.equal(registry.list()[0]?.state, "expired");
  assert.equal(registry.list()[0]?.controller, "none");
});

test("the local broker authenticates same-user MCP traffic without opening TCP", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ke-pen-display-broker-"));
  const paths = agentDisplayRuntimePaths(root);
  const broker = new AgentDisplayBroker(paths, async (request) => ({
    echoedMethod: request.method,
    tcp: false,
  }));
  await broker.start();
  t.after(async () => {
    await broker.stop();
    await rm(root, { recursive: true, force: true });
  });
  const result = await new AgentDisplayClient(root).request({ method: "status", params: {} });
  assert.deepEqual(result, { echoedMethod: "status", tcp: false });
  assert.equal(paths.socket.includes("127.0.0.1"), false);
  assert.ok(Buffer.byteLength(paths.socket) < 100, "macOS Unix socket paths must stay bounded");
  const auth = JSON.parse(await readFile(paths.authFile, "utf8")) as Record<string, unknown>;
  await writeFile(paths.authFile, `${JSON.stringify({ ...auth, socket: "/tmp/not-ke-pen.sock" })}\n`);
  await assert.rejects(
    () => new AgentDisplayClient(root).request({ method: "status", params: {} }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "DISPLAY_BROKER_AUTH_MISMATCH",
  );
});

test("display action validation bounds cursor and text payloads", () => {
  assert.equal(agentDisplayActionSchema.parse({ type: "move", x: 1, y: 2 }).type, "move");
  assert.throws(() => agentDisplayActionSchema.parse({ type: "type", text: "x".repeat(2_001) }));
  assert.throws(() => agentDisplayActionSchema.parse({ type: "scroll", x: 1, y: 1, deltaX: 0, deltaY: 9_999 }));
});

test("the Agent Display implementation contains no system-input or desktop-capture primitive", async () => {
  const manager = await readFile(new URL("../desktop/agent-display-manager.ts", import.meta.url), "utf8");
  assert.doesNotMatch(manager, /desktopCapturer|CGEvent|robotjs|screen\.getCursor|setCursorScreenPoint/);
  const html = await readFile(new URL("../desktop/agent-displays.html", import.meta.url), "utf8");
  assert.match(html, /Stop and revoke this display/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /Not a macOS virtual monitor/);
});

async function registryFixture() {
  const root = await mkdtemp(join(tmpdir(), "ke-pen-display-registry-"));
  const stateFile = join(root, "sessions.json");
  const registry = new AgentDisplayRegistry(stateFile);
  await registry.loadAndInterrupt();
  return { root, stateFile, registry };
}
