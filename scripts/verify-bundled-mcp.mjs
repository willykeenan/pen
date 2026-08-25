import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EXPECTED_TOOL_NAMES } from "./expected-tools.mjs";

const serverPath = resolve(process.argv[2] ?? "");
await access(serverPath);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  stderr: "pipe",
});
const client = new Client({ name: "pen-installed-bundle-check", version: "1.0.0" });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    EXPECTED_TOOL_NAMES,
  );
  const status = await client.callTool({ name: "pen_status", arguments: {} });
  assert.equal(status.isError, undefined);
  assert.match(JSON.stringify(status.content), /Pen by KE Studios/);
  process.stdout.write(`PEN_BUNDLED_MCP_OK tools=${EXPECTED_TOOL_NAMES.length} server=${serverPath}\n`);
} finally {
  await client.close();
}
