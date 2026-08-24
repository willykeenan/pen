import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { z } from "zod";
import {
  AGENT_DISPLAY_PROTOCOL,
  agentDisplayBrokerRequestSchema,
  agentDisplayBrokerResponseSchema,
  agentDisplayRuntimePaths,
  type AgentDisplayBrokerRequest,
} from "./agent-display-protocol.js";
import { defaultPenHome } from "./store.js";

const authSchema = z.object({
  schema: z.literal("dev.kestudios.pen.agent-display.broker-auth.v1"),
  secret: z.string().min(32).max(256),
  socket: z.string().min(1).max(4_096),
  pid: z.number().int().positive(),
});
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;

export class AgentDisplayClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentDisplayClientError";
    this.code = code;
  }
}

export class AgentDisplayClient {
  private readonly penHome: string;

  constructor(penHome = defaultPenHome()) {
    this.penHome = penHome;
  }

  async request(
    input: Omit<AgentDisplayBrokerRequest, "schema" | "requestId" | "brokerSecret">,
  ): Promise<unknown> {
    const paths = agentDisplayRuntimePaths(this.penHome);
    let auth: z.infer<typeof authSchema>;
    try {
      auth = authSchema.parse(JSON.parse(await readFile(paths.authFile, "utf8")));
    } catch {
      throw new AgentDisplayClientError(
        "DISPLAY_BROKER_OFFLINE",
        "KE Pen's Agent Displays broker is not running. Open the KE Pen app, then try again.",
      );
    }
    if (auth.socket !== paths.socket) {
      throw new AgentDisplayClientError(
        "DISPLAY_BROKER_AUTH_MISMATCH",
        "KE Pen refused a broker record that points outside this Pen data boundary.",
      );
    }
    const request = agentDisplayBrokerRequestSchema.parse({
      ...input,
      schema: AGENT_DISPLAY_PROTOCOL,
      requestId: randomUUID(),
      brokerSecret: auth.secret,
    });
    const response = await sendRequest(auth.socket, `${JSON.stringify(request)}\n`);
    const parsed = agentDisplayBrokerResponseSchema.parse(JSON.parse(response));
    if (parsed.requestId !== request.requestId) {
      throw new AgentDisplayClientError("BROKER_RESPONSE_MISMATCH", "The display broker response did not match this request.");
    }
    if (!parsed.ok) {
      throw new AgentDisplayClientError(
        parsed.error?.code ?? "DISPLAY_BROKER_ERROR",
        parsed.error?.message ?? "The display broker refused this request.",
      );
    }
    return parsed.result;
  }
}

function sendRequest(socketPath: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let body = "";
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("The local display broker timed out.")), 20_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(body.trim());
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_RESPONSE_BYTES) {
        finish(new Error("The local display broker response exceeded 24 MB."));
        return;
      }
      body += chunk;
    });
    socket.on("end", () => finish());
    socket.on("error", (error) => finish(error));
  });
}
