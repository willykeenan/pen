// Custom macOS signing for electron-builder (mac.sign). Runs after the Electron
// fuses are flipped, so the final signature covers the flipped binary.
//
// Identity: KE_PEN_MAC_SIGN_IDENTITY when set (a local, stable certificate
// keeps macOS privacy approvals across updates), otherwise ad hoc ("-").
// Order matters: the bundle is signed deep first, then the hold helper is
// re-signed with its own identifier and hardened runtime, then the outer
// bundle is sealed again so its resource seal covers the helper's signature.
"use strict";

const { execFileSync } = require("node:child_process");
const path = require("node:path");

const HELPER_IDENTIFIER = "dev.kestudios.pen.hold-helper";

function codesign(args) {
  execFileSync("codesign", args, { stdio: ["ignore", "inherit", "inherit"] });
}

module.exports = async function signMac(options) {
  const app = options.app;
  if (!app || !app.endsWith(".app")) throw new Error(`sign-mac: unexpected target ${app}`);
  const identity = process.env.KE_PEN_MAC_SIGN_IDENTITY || "-";
  const helper = path.join(app, "Contents", "MacOS", "ke-pen-hold-helper");
  codesign(["--force", "--deep", "--sign", identity, "--timestamp=none", app]);
  codesign([
    "--force",
    "--sign",
    identity,
    "--timestamp=none",
    "--identifier",
    HELPER_IDENTIFIER,
    "--options",
    "runtime",
    helper,
  ]);
  codesign(["--force", "--sign", identity, "--timestamp=none", app]);
  codesign(["--verify", "--deep", "--strict", "--verbose=2", app]);
  process.stdout.write(`  • signed ${path.basename(app)} and its hold helper (${identity === "-" ? "ad hoc" : identity})\n`);
};
