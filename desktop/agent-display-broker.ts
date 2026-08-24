import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  AGENT_DISPLAY_RESPONSE_PROTOCOL,
  agentDisplayBrokerRequestSchema,
  type AgentDisplayBrokerRequest,
  type AgentDisplayBrokerResponse,
  type AgentDisplayRuntimePaths,
} from "../src/agent-display-protocol.js";
import { AgentDisplayError } from "./agent-display-registry.js";

const MAX_REQUEST_BYTES = 256 * 1024;

export class AgentDisplayBroker {
  private readonly paths: AgentDisplayRuntimePaths;
  private readonly handler: (request: AgentDisplayBrokerRequest) => Promise<unknown>;
  private server: Server | null = null;
  private secret = "";

  constructor(
    paths: AgentDisplayRuntimePaths,
    handler: (request: AgentDisplayBrokerRequest) => Promise<unknown>,
  ) {
    this.paths = paths;
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.server) return;
    await mkdir(this.paths.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      await chmod(this.paths.directory, 0o700);
      await rm(this.paths.socket, { force: true });
    }
    this.secret = randomBytes(32).toString("base64url");
    const instanceId = randomUUID();
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.paths.socket);
    });
    if (process.platform !== "win32") await chmod(this.paths.socket, 0o600);
    await atomicWrite(
      this.paths.authFile,
      `${JSON.stringify(
        {
          schema: "dev.kestudios.pen.agent-display.broker-auth.v1",
          instanceId,
          secret: this.secret,
          pid: process.pid,
          socket: this.paths.socket,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.secret = "";
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
    }
    await rm(this.paths.authFile, { force: true });
    if (process.platform !== "win32") await rm(this.paths.socket, { force: true });
  }

  private accept(socket: Socket): void {
    let bytes = 0;
    let body = "";
    let settled = false;
    const fail = (requestId: string, code: string, message: string) => {
      if (settled) return;
      settled = true;
      socket.end(`${JSON.stringify(responseError(requestId, code, message))}\n`);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(20_000, () => fail(randomUUID(), "BROKER_TIMEOUT", "The display broker request timed out."));
    socket.on("data", (chunk: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_REQUEST_BYTES) {
        fail(randomUUID(), "REQUEST_TOO_LARGE", "The display broker request exceeded 256 KB.");
        return;
      }
      body += chunk;
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      settled = true;
      void this.process(body.slice(0, newline), socket);
    });
    socket.on("error", () => undefined);
  }

  private async process(line: string, socket: Socket): Promise<void> {
    let requestId: string = randomUUID();
    try {
      const raw = JSON.parse(line) as unknown;
      const request = agentDisplayBrokerRequestSchema.parse(raw);
      requestId = request.requestId;
      if (!constantTimeEqual(request.brokerSecret, this.secret)) {
        socket.end(`${JSON.stringify(responseError(request.requestId, "BROKER_AUTH_FAILED", "The local display broker rejected this client."))}\n`);
        return;
      }
      const result = await this.handler(request);
      const response: AgentDisplayBrokerResponse = {
        schema: AGENT_DISPLAY_RESPONSE_PROTOCOL,
        requestId: request.requestId,
        ok: true,
        result,
      };
      socket.end(`${JSON.stringify(response)}\n`);
    } catch (error) {
      const code = error instanceof AgentDisplayError ? error.code : "DISPLAY_BROKER_ERROR";
      const message =
        error instanceof Error ? error.message : "KE Pen could not process the agent display request.";
      socket.end(`${JSON.stringify(responseError(requestId, code, message))}\n`);
    }
  }
}

function responseError(requestId: string, code: string, message: string): AgentDisplayBrokerResponse {
  return {
    schema: AGENT_DISPLAY_RESPONSE_PROTOCOL,
    requestId,
    ok: false,
    error: { code, message: message.slice(0, 1_000) },
  };
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function atomicWrite(file: string, data: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, file);
  if (process.platform !== "win32") await chmod(file, 0o600);
}
