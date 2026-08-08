# Privacy

KE Pen has no account, cloud backend, analytics, ads, or telemetry.

When you activate the pen, the desktop app captures the visible display locally
so it can crop the area you mark. The crop and a small JSON record are stored in
your user data directory:

- macOS: `~/Library/Application Support/KE Pen/`
- Windows: `%APPDATA%\KE Pen\`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/ke-pen/`

Set `KE_PEN_HOME` to use another local directory. The MCP server reads those
files and returns the selected image to the AI host you configured.

KE Pen itself does not upload the image. Your AI host may send MCP tool results
to its configured model provider, so that provider's privacy and retention
terms still apply. Do not circle secrets you would not send to that provider.

Use **Clear local Pen history** from the tray menu to delete retained
annotations.
