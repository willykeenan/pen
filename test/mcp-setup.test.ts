import assert from "node:assert/strict";
import test from "node:test";
import {
  createMcpHostConfig,
  packagedExecutablePath,
  packagedMcpServerPath,
} from "../desktop/mcp-setup.js";

test("the copied MCP setup launches the server embedded in the installed app", () => {
  const config = JSON.parse(
    createMcpHostConfig(
      "/Applications/KE Pen.app/Contents/MacOS/KE Pen",
      "/Applications/KE Pen.app/Contents/Resources/mcp/index.js",
    ),
  );
  assert.deepEqual(config, {
    mcpServers: {
      pen: {
        command: "/Applications/KE Pen.app/Contents/MacOS/KE Pen",
        args: ["/Applications/KE Pen.app/Contents/Resources/mcp/index.js"],
        env: {
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
    },
  });
});

test("AppImage setup scopes its launcher probe to the private MCP directory", () => {
  const config = JSON.parse(
    createMcpHostConfig(
      "/home/charles/Downloads/KE-Pen.AppImage",
      "/home/charles/.config/KE Pen/mcp/index.js",
      "/home/charles/.config/KE Pen/mcp/bin",
    ),
  );
  assert.deepEqual(config.mcpServers.pen.env, {
    ELECTRON_RUN_AS_NODE: "1",
    PATH: "/home/charles/.config/KE Pen/mcp/bin:/usr/bin:/bin",
  });
});

test("AppImage setup uses its stable original path rather than the temporary mount", () => {
  assert.equal(
    packagedExecutablePath({
      platform: "linux",
      executablePath: "/tmp/.mount_KEPen/ke-pen",
      appImagePath: "/home/charles/Downloads/KE-Pen.AppImage",
    }),
    "/home/charles/Downloads/KE-Pen.AppImage",
  );
  assert.equal(
    packagedExecutablePath({ platform: "darwin", executablePath: "/Applications/KE Pen.app" }),
    "/Applications/KE Pen.app",
  );
});

test("AppImage setup stages its bundled server outside the temporary mount", () => {
  assert.equal(
    packagedMcpServerPath({
      platform: "linux",
      resourcesPath: "/tmp/.mount_KEPen/resources",
      userDataPath: "/home/charles/.config/KE Pen",
      appImagePath: "/home/charles/Downloads/KE-Pen.AppImage",
    }),
    "/home/charles/.config/KE Pen/mcp/index.js",
  );
  assert.equal(
    packagedMcpServerPath({
      platform: "darwin",
      resourcesPath: "/Applications/KE Pen.app/Contents/Resources",
      userDataPath: "/Users/charles/Library/Application Support/KE Pen",
    }),
    "/Applications/KE Pen.app/Contents/Resources/mcp/index.js",
  );
  assert.equal(
    packagedMcpServerPath({
      platform: "win32",
      resourcesPath: "C:\\Program Files\\KE Pen\\resources",
      userDataPath: "C:\\Users\\charles\\AppData\\Roaming\\KE Pen",
    }),
    "C:\\Program Files\\KE Pen\\resources\\mcp\\index.js",
  );
});
