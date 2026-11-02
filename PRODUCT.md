# Lienza — Product

<!-- impeccable:product-schema 1 -->

## Platform

Web.

## Users

Developers who receive `.fig` files and build interfaces with agents such as Codex or Claude. Their primary task is to inspect designs and select layers quickly. Designers may also review the reader's visual fidelity and usability; the interface should work for them without requiring knowledge of development conventions.

## Product Purpose

Open local Figma designs, navigate their pages and layers, compare uploaded versions, and give an agent precise context for the current selection and project theme.

## Positioning

Lienza reads the `.fig` file on the user's machine and shares the reader's view and selection with a local MCP server. Reading that file does not require the official Figma API.

## Operating Context

The library contains projects with dated `.fig` versions. A developer opens a version, explores the canvas, selects or isolates a layer, and inspects its properties. A connected agent can read the selection, nodes, images, and theme report through MCP. The UI also supports opening older versions, keeping only the latest version, and deleting a whole project to free storage.

## Capabilities and Constraints

- Standalone Angular with Tailwind CSS, mobile-first composition, and responsive layouts for phones, tablets, and desktop screens.
- English and Spanish UI; the selected language persists in the browser. Content from the `.fig` keeps its original language.
- Node backend with a basic hexagonal architecture and a local Streamable HTTP MCP server.
- Canvas view, selection, inspector, and MCP state remain synchronized.
- The font declared by the `.fig` is distinct from any substitute used when rendering a preview.
- Theme analysis uses visible layers and reports colors, typography, radii, borders, shadows, spacing, and CSS variables. Inferred spacing requires visual review.
- The rendered result can differ from Figma for effects the engine still approximates.

## Brand Commitments

The product is named **Lienza**. Its interface needs a recognizable identity, strong presence, and enough visual quality and usability to satisfy both developers and designers. The generic earlier direction was rejected in favor of an editorial design language.

## Evidence on Hand

The local library contains uploaded versions of two real dashboard designs, with dates and files. The repository includes the reader, inspector, theme report, and version management flows that must continue to work.

## Product Principles

1. Keep the design visible ahead of the tool's decoration.
2. Minimize the steps between opening a version, selecting a layer, and reading it through an agent.
3. Show where each value came from and distinguish observation from inference.
4. Preserve `.fig` navigation and readability on small screens without hiding essential actions.
5. Give interaction states and details the same care as the overall visual composition.
