# Security model

Pen intentionally has a narrow boundary:

- the native app requests macOS Screen Recording permission;
- captures and annotation records are local, user-owned files;
- the MCP server uses stdio only and opens no listening network port;
- tool inputs are schema-validated and annotation IDs cannot become paths;
- image reads are confined to Pen's data directory and capped at 16 MB;
- `pen_complete` can only change the current annotation's lifecycle state.

The AI host is a separate trust boundary. Review its tool-call UI and provider
policy before sharing sensitive screen content.

Report security issues privately to william@kestudios.dev.

