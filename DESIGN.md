---
name: Lienza
description: An editorial library for exploring local .fig files and sharing precise selections through MCP.
colors:
  paper: "#f5f4f6"
  warm-paper: "#faf9fa"
  cool-paper: "#eef3ef"
  white: "#ffffff"
  ink: "#16181a"
  muted-ink: "#52595b"
  hairline: "#c9c7c4"
  periwinkle-stamp: "#dcddf3"
  selection: "#57579d"
  annotation: "#7375ad"
  status-green: "#517d64"
typography:
  display:
    fontFamily: "Lienza Sans, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(3.75rem, 8.2vw, 6rem)"
    fontWeight: 400
    lineHeight: 0.91
    letterSpacing: "-.038em"
  headline:
    fontFamily: "Lienza Sans, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(2.2rem, 3.8vw, 4.2rem)"
    fontWeight: 400
    lineHeight: 0.98
    letterSpacing: "-.032em"
  title:
    fontFamily: "Lienza Sans, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.2rem"
    fontWeight: 600
  body:
    fontFamily: "Lienza Sans, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Lienza Sans, Helvetica Neue, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 600
  metadata:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "10px"
    fontWeight: 400
    letterSpacing: ".06em"
rounded:
  square: "0px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "20px"
  xl: "24px"
  xxl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.white}"
    rounded: "{rounded.square}"
    padding: ".58rem .9rem"
    height: "44px"
  button-primary-hover:
    backgroundColor: "#41434a"
    textColor: "{colors.white}"
  input:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.square}"
    padding: ".5rem .8rem"
    height: "45px"
  project-plate:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.square}"
  version-active:
    backgroundColor: "#dfebe0"
    textColor: "#345d3f"
---

# Design System: Lienza

## Overview

**Creative direction: “An archive of designs in use.”** Lienza presents each file as an editorial plate: a real preview, precise metadata, and dated versions. The interface supports inspection from the project library through layer selection on the canvas. The `.fig` image supplies variable color; the product UI remains stable, restrained, and editorial.

The system uses near-white paper, dark ink, fine rules, and small periwinkle marks. Headlines are large and light; operational data is compact and verifiable. This direction replaces an earlier generic interface.

**Defining traits:**

- A real project thumbnail leads each plate.
- Version numbers, dates, and status remain easy to read.
- The central canvas sits between the layer index and inspector, which act as work margins.
- Square surfaces, registration marks, and rules establish the layout.

## Colors

A mostly neutral palette lets the open file's colors remain prominent.

### Primary

- **Ink** (`#16181a`, `--fig-ink`): primary text, strong rules, main actions, and code blocks.
- **Periwinkle stamp** (`#dcddf3`, `--fig-accent`): selected text, active states, and navigation accents.
- **Selection** (`#57579d`, `--fig-selection`): selected layer outline, visible focus, and text-action hover.

### Neutral

- **Paper** (`#f5f4f6`, `--fig-paper`): library, reader, and theme backgrounds.
- **Warm paper** (`#faf9fa`, `--fig-warm`): headers and mobile navigation.
- **Cool paper** (`#eef3ef`, `--fig-cool`): optional tonal variant.
- **White** (`#ffffff`): plates, inputs, cells, and controls.
- **Muted ink** (`#52595b`, `--fig-muted`): help text, dates, descriptions, and metadata.
- **Hairline** (`#c9c7c4`, `--fig-hairline`): dividers, borders, and panel structure.

### Small signals

- **Annotation** (`#7375ad`): accented headline text, version numbers, and the brand dot.
- **Available status** (`#517d64`): local connection indicator.

**Canvas rule:** Periwinkle identifies Lienza interaction. It never recolors previews or values extracted from the `.fig`.

## Typography

**Reading font:** Lienza Sans, served locally from Source Sans Pro, with Helvetica Neue, Arial, and sans-serif fallbacks. **Metadata font:** `ui-monospace, SFMono-Regular, Menlo, monospace`.

The sans serif keeps operational information clear. Light headlines against compact labels create an editorial character without making layers or properties harder to read.

### Hierarchy

- **Display** (400, `clamp(3.75rem, 8.2vw, 6rem)`, 0.91, `-.038em`): library and theme openings; scales down on mobile.
- **Plate headline** (400, `clamp(2.2rem, 3.8vw, 4.2rem)`, 0.98, `-.032em`): project name.
- **Section heading** (400–600, `1.2rem` to `clamp(2.3rem, 4.5vw, 4rem)`): report indexes and sections.
- **Body** (400, 14px, 1.5): short instructions and explanations.
- **Label** (600, 11–12px): navigation, buttons, and panel headings; spaced uppercase is reserved for classification labels.
- **Metadata** (monospace, 10–12px): file names, plate numbers, counts, and measurements.

**Font provenance:** Distinguish the UI font from the family declared by a text node in the `.fig`. If the reader uses a substitute, display both.

## Layout

The library and theme report use a centered container with `max-width: 1520px`, horizontal margins of 20px, 32px from `sm`, and 48px from `lg`. Horizontal rules organize the header, index, and sections. The lead plate pairs image and details at roughly 1.35:0.65. Below 650px, they stack and the preview is 265px tall. Version lists move from three columns to two below 650px.

The reader occupies `100dvh`. The canvas takes the remaining width between the layer and inspector panels. Side panels are 258px and 286px, growing to 282px and 300px from 1280px. Below 768px, Layers, Canvas, and Inspector become switchable full-width views through bottom navigation. The design is never squeezed into three tiny columns.

Spacing typically uses 8, 12, 16, 20, 24, and 32px, with larger gaps between plates and sections. Version and inspector numbers use tabular figures.

## Elevation and Depth

Surfaces are flat by default. Rules and the shift from paper to white separate them. Theme cards and plates have no shadow. Only controls floating above the canvas receive a subtle shadow (`0 2px 10px rgb(22 24 26 / 5%)`) to remain legible over file content. Selection adds `0 0 0 1px rgb(87 87 157 / 15%)`.

## Shapes

Controls, cards, inputs, labels, and panels are rectangular (`border-radius: 0`). One-pixel lines and registration marks define their silhouette. Status dots and the spinner stay circular because they convey status rather than form surfaces. Project images are cropped within a plate; the UI does not round or recolor their content.

## Components

### Brand

“Lienza” combines a compact wordmark, annotation dot, and 32×32 framing glyph. Its central circle uses periwinkle. The brand links back to projects.

### Language switcher

The ES/EN switcher appears in the header of all three views. Both choices have at least a 44×44px target, use full language names for assistive technology, and show the active state through ink contrast. The choice persists between visits. UI text is translated; layer names, design content, and extracted `.fig` values retain their original language.

### Buttons and links

- **Primary action:** rectangular, ink on white, 1px border, minimum height 44px, `.58rem .9rem` padding; hover uses `#41434a` with a 180ms color transition.
- **Text action:** no background, 1px bottom border as underline; hover uses the selection color.
- **Focus:** global 2px outline in `--fig-selection`, offset 2px. Disabled actions have reduced emphasis.

### Project plate

Includes a `FIG 01` index, real thumbnail, name, file, latest delivery, and direct access. A rule separates each block; four small registration crosses frame the thumbnail. Version rows below show number, date, size, and status. “Latest” uses a periwinkle stamp; “In MCP” uses soft green.

### Fields

Import form fields have a white background, 1px `--fig-hairline` border, zero radius, and a minimum height of 45px. Layer search is 38px tall. Labels sit above fields. The file picker retains an accessible input and a visible surface for the chosen file name.

### Navigation and selection

Header links underline on hover. Page tabs use a 2px ink bottom rule for the active state. On mobile, bottom navigation selects one full-screen panel. Selectable canvas areas reveal a periwinkle border and translucent fill on hover or keyboard focus. The selected area keeps a visible outline and label.

### Theme report

Every section starts with a strong rule and large title. Section navigation is sticky and scrolls horizontally. Color swatches show values observed in the file and link to a sample layer. Inferred spacing is labeled as geometry and requires visual review.

## Design rules

- Use real `.fig` thumbnails as the library's focus and preserve their colors.
- Show the active version's name, date, and state before opening the reader.
- Structure surfaces with `--fig-hairline` and tonal backgrounds; reserve shadows for controls floating over the canvas.
- Keep focus visible and respect `prefers-reduced-motion` in every interaction.
- Avoid a decorative card grid that competes with the imported design.
- Keep plates, controls, and panels square.
- Never present inferred `.fig` values as a confirmed official scale.
- On mobile, always expose a visible way to switch between Layers, Canvas, and Inspector.
