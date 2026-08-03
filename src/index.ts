#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPenServer, SERVER_VERSION } from "./server.js";

const server = createPenServer();
const transport = new StdioServerTransport();

process.stderr.write(
  `Pen by KE Studios MCP ${SERVER_VERSION} ready — local stdio, created by William Keenan · https://kestudios.dev\n`,
);

await server.connect(transport);

