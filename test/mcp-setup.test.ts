import assert from "node:assert/strict";
import test from "node:test";
import { createMcpHostConfig, packagedExecutablePath } from "../desktop/mcp-setup.js";

test("the copied MCP setup launches the server embedded in the installed app", () => {
  const config = JSON.parse(createMcpHostConfig("/Applications/KE Pen.app/Contents/MacOS/KE Pen"));
  assert.deepEqual(config, {
    mcpServers: {
      pen: {
        command: "/Applications/KE Pen.app/Contents/MacOS/KE Pen",
        args: ["--mcp-server"],
        env: {
          KE_PEN_MCP_SERVER: "1",
        },
      },
    },
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
