# Changelog

## 0.2.0 — 2026-11-03

- Add an experimental interactive CLI, one-shot commands, exports, and MCP over stdio.
- Improve Figma instance resolution, text overrides, and icon rendering against real designs.
- Select project covers only from explicitly named `Cover`, `#cover`, or `Thumbnail` compositions.
- Isolate cover rendering with time, memory, and output limits; use a bounded embedded thumbnail or placeholder when rendering fails.
- Keep canvas navigation and selection aligned when returning through the breadcrumb.

The CLI remains experimental. Check its output against the source design before implementation, especially for large files and PNG exports.
