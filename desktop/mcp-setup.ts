import path from "node:path";

export function createMcpHostConfig(executablePath: string, serverPath: string): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        pen: {
          command: executablePath,
          args: [serverPath],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
          },
        },
      },
    },
    null,
    2,
  )}\n`;
}

export function packagedMcpServerPath(options: {
  platform: NodeJS.Platform;
  resourcesPath: string;
  userDataPath: string;
  appImagePath?: string;
}): string {
  const targetPath = options.platform === "win32" ? path.win32 : path.posix;
  if (options.platform === "linux" && options.appImagePath) {
    return targetPath.join(options.userDataPath, "mcp", "index.js");
  }
  return targetPath.join(options.resourcesPath, "mcp", "index.js");
}

export function packagedExecutablePath(options: {
  platform: NodeJS.Platform;
  executablePath: string;
  appImagePath?: string;
}): string {
  if (options.platform === "linux" && options.appImagePath) return options.appImagePath;
  return options.executablePath;
}
