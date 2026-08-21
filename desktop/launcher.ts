async function launch(): Promise<void> {
  if (process.argv.includes("--mcp-server")) {
    const [{ StdioServerTransport }, { createPenServer, SERVER_VERSION }] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/stdio.js"),
      import("../src/server.js"),
    ]);
    const server = createPenServer();
    const transport = new StdioServerTransport();
    process.stderr.write(
      `Pen by KE Studios MCP ${SERVER_VERSION} ready — local stdio, created by William Keenan · https://kestudios.dev\n`,
    );
    await server.connect(transport);
    return;
  }
  await import("./main.js");
}

void launch().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`KE Pen could not start: ${message}\n`);
  process.exitCode = 1;
});
