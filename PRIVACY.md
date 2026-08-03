# Privacy

Pen has no account, cloud backend, analytics, ads, or telemetry.

When you activate the pen, the macOS app captures the visible display locally
so it can crop the area you mark. The crop and a small JSON record are stored
under `~/Library/Application Support/KE Pen/`. The MCP server reads those local
files and returns the selected image to the AI host you configured.

Pen itself does not upload the image. Your AI host may send MCP tool results to
its configured model provider, so that provider's privacy and retention terms
still apply. Do not circle secrets you would not send to that provider.

Use **Clear Pen History** from the menu-bar icon to delete locally retained
annotations.

