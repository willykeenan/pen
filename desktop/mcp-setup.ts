export function createMcpHostConfig(executablePath: string): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        pen: {
          command: executablePath,
          args: ["--mcp-server"],
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
