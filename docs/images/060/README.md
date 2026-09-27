# KE Pen 0.6.0 visual capture provenance

Captured September 27, 2026 from `desktop/renderer.ts` at source commit
`b0486387a5f744f50b5e44a15b69118bba77f29a`.

- `01-freeze.png`: the actual frozen KE Shot renderer.
- `02-select.png`: a primary-button pointer drag selected a 319 × 190 region.
- `03-point.png`: the actual Pen renderer after a pointer-drawn red circle.
- `point-demo.gif`: 64 captured renderer frames at 12 fps, scaled to 960 × 600.
- `ke-pen-hero.png`: editorial layout in `hero.html` containing `03-point.png`.

The underlying Fieldnotes page is `demo-fixture.html`, a fictional static test
page with no personal data. The renderer was bundled with esbuild without source
changes and driven in a dedicated headless Chromium using Playwright mouse input.
The Electron bridge was replaced with an in-memory fixture. Its selection and
annotation callbacks were observed; no AI response, native screen capture,
native middle-button interception, upload, or real clipboard operation is shown.
The badge text is the renderer's own queued state, not evidence of an AI session.
Capture and annotation are separate workflows, not an automatic transition.

Screenshots contain no private desktop data. These visuals establish renderer
presentation only. Native runtime verification belongs to the release checks.
