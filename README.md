# Lienza — Local Figma Reader and MCP Server

![Lienza cover: from local designs to agent-ready context](docs/lienza-cover.svg)

Lienza opens local `.fig` files so you can inspect pages, select layers, and share precise design context with AI agents such as Codex and Claude. It reads the file on your machine without using the official Figma API.

The viewer supports English and Spanish. Its language switcher is available in the project library, reader, and theme report. Interface translations live in `apps/viewer/public/i18n/`; names and content from the `.fig` file remain exactly as they appear in the design.

## What you can do

- Keep multiple dated versions of each project, open an earlier version, retain only the latest one, or delete a project and its files.
- Explore every page, select a layer, inspect its properties, and isolate a node on the canvas.
- Review a generated theme report with colors, typography, radii, borders, shadows, spacing, and CSS variables.
- Give an MCP client the current selection, original layout rules and constraints, component references, embedded assets, and visual references. The response marks values read from the file separately from inferred values.

## Quick start

Requires Node.js 22.12 or 24 and npm.

```bash
npm install
npm run build
npm run dev
```

Open [http://localhost:4200](http://localhost:4200), create a project by uploading a `.fig` file, and open a version. To import a file on the first local run:

```bash
FIGMA_FILE="/path/to/design.fig" npm run dev
```

For an integration test using your own file:

```bash
FIGMA_TEST_FILE="/path/to/design.fig" npm test
```

### Docker Compose

With Docker Desktop or another running Docker daemon:

```bash
docker compose up --build -d
```

Open [http://localhost:4200](http://localhost:4200). The MCP endpoint is `http://127.0.0.1:3210/mcp`. Nginx serves the Angular viewer and forwards `/api` and `/mcp` to the same Node process, so canvas selection and MCP state stay in sync.

A fresh Docker volume starts with an **empty project library**. The `lienza-projects` volume is separate from `apps/server/data/projects`, which is used by the local npm workflow. Uploaded versions survive `docker compose down` and rebuilds. `docker compose down -v` also deletes the volume and its projects.

If ports 4200 or 3210 are already in use:

```bash
VIEWER_PORT=14200 MCP_PORT=13210 docker compose up --build -d
```

Then open `http://localhost:14200` and connect the MCP client to `http://127.0.0.1:13210/mcp`. Use `docker compose ps` to inspect the services, `docker compose down` to stop them, and `docker compose up --build -d` after code changes.

### Prebuilt Docker images

Once the GitHub Container Registry packages are public, deploy without cloning or building the source. Download [`compose.prebuilt.yaml`](compose.prebuilt.yaml) and run it in an empty directory:

```bash
docker compose -f compose.prebuilt.yaml up -d
```

This pulls the latest `server` and `viewer` images for your CPU architecture, including `linux/arm64` on M1 and later Macs and `linux/amd64` on Intel/AMD machines. To use a specific release or different local ports:

```bash
LIENZA_VERSION=v0.1.0 VIEWER_PORT=14200 MCP_PORT=13210 docker compose -f compose.prebuilt.yaml up -d
```

The viewer is at `http://localhost:4200` by default; MCP is at `http://127.0.0.1:3210/mcp`. The named volume begins empty and keeps uploaded projects across container updates. Run `docker compose -f compose.prebuilt.yaml pull && docker compose -f compose.prebuilt.yaml up -d` to update to the newest images.

Maintainers publish both images to GHCR by pushing a version tag such as `v0.1.0`. The workflow publishes that tag and `latest` for `linux/amd64` and `linux/arm64`. New GHCR packages may initially be private; set both package visibilities to **Public** in GitHub before offering anonymous pulls.

### Storage and versions

The local npm workflow stores projects in `apps/server/data/projects`. Set `FIGMA_LIBRARY_DIR=/path/to/library` to choose another directory. `FIGMA_FILE` seeds a project only when no catalog exists; deleting the final project does not import it again on restart. Each version stores its file, number, and actual upload time.

“Keep only the latest version” removes older version files. “Delete project” removes all versions and previews. If that project was active, the reader and MCP selection are cleared.

The project library displays the thumbnail embedded in each `.fig` version. Thumbnail requests do not activate another version or change the shared selection. The viewer bundles Source Sans Pro under the [SIL Open Font License](apps/viewer/public/fonts/OFL.txt).

## Connect an agent

The MCP server uses Streamable HTTP at `http://127.0.0.1:3210/mcp`. With current Codex and Claude Code CLIs:

```bash
codex mcp add lienza --url http://127.0.0.1:3210/mcp
claude mcp add --transport http lienza http://127.0.0.1:3210/mcp
```

Available tools: `get_document_status`, `get_selection`, `list_layers`, `search_nodes`, `get_node_context`, `get_implementation_context`, `list_components`, `get_image_asset`, `render_node`, `get_node_image`, and `get_theme`.

`get_implementation_context` accepts optional `node_id` (defaults to the selection or open view), `depth` from 0 to 2, and `limit` from 1 to 100. It returns a bounded node tree, `stack*` fields and constraints declared in the `.fig`, component references, embedded image references, a token summary, and local SVG/PNG URLs. Original fields carry `source: "fig"`; token groupings and geometric measurements carry `source: "inferred"`. `autoLayout: null` means no active mode was declared; stored padding alone does not establish auto layout. `list_components` includes referenced definitions and definitions with a `componentKey`, even if they have no instances. `get_image_asset` returns the original bytes for a hash listed in the context.

The implementer decides breakpoints, responsive behavior, and any translation to Tailwind, SwiftUI, Jetpack Compose, or Flutter. Lienza does not present generated code as a faithful implementation.

### Theme report

Opening a version analyzes visible layers and generates a **Theme** page that is separate from the `.fig`. It shows observed colors and roles, declared and preview font families, typography combinations, radii, borders, shadows, spacing, and copyable CSS variables. `GET /api/theme` returns the full report.

The MCP `get_theme` tool accepts `section` (`all`, `colors`, `typography`, `radii`, `borders`, `shadows`, `spacing`, or `css`) and `limit`. In `typography.fonts`, `declaredFamily` is the family found in the `.fig`; `renderedFamily` is the configured preview substitute. Use the declared family when implementing the design. `get_node_context` makes the same distinction for individual nodes. Check geometrically inferred values before adopting them as official design tokens.

## Architecture

```text
apps/viewer/src/
  core/           shared application services
  domain/         entities, repository contracts, and use cases
  data/           HTTP adapters
  presentation/   Angular views and signal-based ViewModels

apps/server/src/
  domain/         domain contracts
  application/    document state and operations
  adapters/in/    MCP and HTTP
  adapters/out/   .fig engine adapter

packages/fig-engine/
  parser/         ZIP parsing and lazy images adapted from echobt/figma-mcp
  renderer/       SVG and PNG composition shared by the viewer and exports
  theme/          visible-style analysis and token generation
  index.ts        openfig-core integration
```

The frontend uses standalone Angular and Tailwind CSS with a mobile-first layout: tabbed panels on phones and three simultaneous panels on desktop. The backend uses Fastify and the official MCP SDK. `openfig-core` decodes `canvas.fig`; the parser adapted from `echobt/figma-mcp` provides a fallback. Embedded images are loaded lazily.

On a page, the white canvas shows all views and fits them to the viewport. Click a layer to select it and share that selection with the inspector and MCP. Double-click a container to enter it; double-click a leaf layer to focus it within the current view. The breadcrumb path returns to an ancestor while preserving the previous framing. “Isolate layer on canvas” opens only the selected node; “Full page” restores the page. Scroll to pan; use Ctrl/Cmd + scroll or pinch to zoom around the pointer or fingers. Space + drag, the middle mouse button, or one finger on a touch screen pans the design. The zoom buttons scale from the panel center; clicking the percentage fits the view.

`get_selection` and `get_document_status` distinguish `selectedId` from `viewingNodeId` and return `viewingPath`. Focusing a layer keeps `viewingNodeId`; entering or isolating it changes that value.

## Local API

- `GET /api/status`, `/api/tree`, `/api/nodes/:id`, `/api/search`, `/api/selection`
- `GET /api/theme` for the active version's theme report
- `GET /api/projects` for projects, versions, and the active version
- `GET /api/projects/:id/versions/:versionId/thumbnail` for a high-resolution preview without activating the version; the result is cached per version and falls back to the embedded thumbnail when reconstruction is unreliable
- `POST /api/projects?name=Name` with a multipart `file` field to create a project
- `POST /api/projects/:id/versions` with a multipart `file` field to add a version
- `POST /api/projects/:id/versions/:versionId/open` to activate a version in the viewer and MCP
- `DELETE /api/projects/:id/versions?keep=latest` to retain only the latest version
- `DELETE /api/projects/:id` to delete a project and its files
- `POST /api/documents` for older clients (`.fig`, maximum 100 MB)
- `POST /api/selection` with `{ "id": "session:local" }`
- `POST /api/view` with `{ "id": "session:local" }` to share the open view with MCP
- `GET /api/nodes/:id/path` for ancestors from the page
- `GET /api/render/:id.svg`, `/api/render/:id.png`, `/api/hit-areas/:id`
- `GET /api/assets/:hash?v=:renderKey` for embedded image bytes

The server listens on `127.0.0.1` only. The Angular development server proxies `/api` and `/mcp`.

## MVP scope and rendering limits

Visual fidelity depends on parser and renderer coverage; some complex effects or components may differ from Figma. Projects and versions persist on disk, while the selected layer lives in memory. `render_node` returns metadata by default. Request `include_svg: true` only when you need the full vector markup.

The renderer uses vector paths stored in the `.fig` and shares composition across the viewer, exported PNGs, and SVGs. It supports linear and radial gradient matrices, fill order, layer opacity, SVG blend modes, translucent masks, and image transforms. For text, it uses baseline positions calculated by Figma and available per-run styles. It also applies linked color styles in instances. Angular and diamond gradients are approximated as radial gradients; untested effects and image modes can still differ.

The engine embeds the available open-source fonts so SVG and PNG previews do not depend on locally installed fonts. The commercial `Raptor V3 Premium` font is not bundled; previews use Rubik temporarily while node metadata keeps the declared family.

The local server has no authentication. Keep it on your machine and do not expose it on a public network.

For reused code and bundled font licenses, see [THIRD_PARTY.md](packages/fig-engine/THIRD_PARTY.md).
