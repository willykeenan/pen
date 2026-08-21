export function createMcpHostConfig(executablePath: string): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        pen: {
          command: executablePath,
          args: ["--mcp-server"],
          env: {
            KE_PEN_MCP_SERVER: "1",
          },
        },
      },
    },
    null,
    2,
  )}\n`;
}

export function packagedExecutablePath(options: {
  platform: NodeJS.Platform;
  executablePath: string;
  appImagePath?: string;
}): string {
  if (options.platform === "linux" && options.appImagePath) return options.appImagePath;
  return options.executablePath;
}
