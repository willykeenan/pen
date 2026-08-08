# Security model

KE Pen intentionally has a narrow boundary:

- the desktop app requests only the operating system's screen-capture access;
- the renderer is sandboxed, context-isolated, and loads packaged local content;
- navigation and new renderer windows are denied;
- captures and annotation records remain local, user-owned files;
- the MCP server uses stdio only and opens no listening network port;
- tool inputs, annotation IDs, normalized strokes, PNG signatures, checksums,
  and paths are validated;
- image reads are confined to KE Pen's data directory and capped at 16 MB;
- `pen_complete` can change only the current annotation's lifecycle state.

The AI host and model provider are separate trust boundaries. Review their
tool-call UI, network behavior, and privacy policy before sharing sensitive
screen content.

The initial macOS and Windows downloads are not commercially code-signed, and
the macOS build is not notarized. Verify the published SHA-256 manifest or
build from the public source if this warning is unacceptable.

Report security issues privately to william@kestudios.dev.
