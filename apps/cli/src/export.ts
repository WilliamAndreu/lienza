import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderFigNode } from '@figma-reader/fig-engine';
import type { LoadedFig } from '@figma-reader/fig-engine';
import type { Workspace } from '@figma-reader/server/workspace';
import { documentSummary, rewriteReferences, safeFileName } from './references.js';

const FRAME_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'SECTION', 'INSTANCE', 'GROUP']);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export interface ExportOptions {
  /** Rasterizes one node to a PNG file. Run it out of process: resvg can abort the process on some geometry. */
  png?: (nodeId: string, path: string) => Promise<unknown>;
  log?: (line: string) => void;
}

/**
 * Writes every query the MCP answers to a directory, one file per page and per top-level frame.
 * Each file is written as soon as it is produced, so the output never accumulates in memory.
 */
export async function exportDocument(workspace: Workspace, file: LoadedFig, out: string, options: ExportOptions = {}) {
  const log = options.log ?? (() => {});
  for (const directory of ['pages', 'frames', 'renders', 'assets']) await mkdir(join(out, directory), { recursive: true });
  const json = (path: string, data: unknown) => writeFile(join(out, path), `${JSON.stringify(data, null, 2)}\n`);
  const status = workspace.status();

  const assetFiles = new Map<string, string>();
  const assets: Record<string, unknown>[] = [];
  for (const hash of file.images.listHashes().map(item => item.toLowerCase())) {
    try {
      const asset = workspace.asset(hash);
      const path = `assets/${hash}.${asset.format}`;
      await writeFile(join(out, path), asset.bytes);
      assetFiles.set(hash, path);
      assets.push({ hash, source: 'fig', format: asset.format, bytes: asset.bytes.length, file: path });
    } catch (error) { assets.push({ hash, source: 'fig', file: null, error: message(error) }); }
  }
  log(`${assetFiles.size}/${assets.length} assets`);

  const pages: Record<string, unknown>[] = [];
  const frames: Array<{ id: string; name: string; type: string; pageId: string }> = [];
  for (const page of status.pages) {
    const path = `pages/${safeFileName(page.id)}.json`;
    const tree = workspace.tree(page.id, 20);
    await json(path, tree);
    pages.push({ id: page.id, name: page.name, visible: page.visible, childCount: page.childCount, layers: path });
    if (!page.visible) continue;
    for (const child of tree.children ?? []) {
      if (child.visible && FRAME_TYPES.has(child.type)) frames.push({ id: child.id, name: child.name, type: child.type, pageId: page.id });
    }
  }

  const frameEntries: Record<string, unknown>[] = [];
  for (const [index, frame] of frames.entries()) {
    log(`[${index + 1}/${frames.length}] ${frame.name}`);
    const base = safeFileName(frame.id);
    const entry: Record<string, unknown> = { ...frame, svg: null, png: null };
    try {
      // Same renderer as Workspace.render, without its cache: every frame is visited once.
      const rendered = renderFigNode(file, frame.id);
      if (rendered.svg) {
        await writeFile(join(out, `renders/${base}.svg`), rendered.svg);
        Object.assign(entry, { svg: `renders/${base}.svg`, width: rendered.width, height: rendered.height, warnings: rendered.warnings });
        if (options.png) {
          try { await options.png(frame.id, join(out, `renders/${base}.png`)); entry.png = `renders/${base}.png`; }
          catch (error) { entry.pngError = message(error); }
        }
      }
    } catch (error) { entry.renderError = message(error); }
    try {
      const context = rewriteReferences(workspace.implementationContext(frame.id, 2, 100), {
        render: (_nodeId, extension) => ({ [`${extension}File`]: entry[extension] ? `../${entry[extension]}` : null }),
        asset: hash => ({ file: assetFiles.has(hash) ? `../${assetFiles.get(hash)}` : null }),
      });
      await json(`frames/${base}.json`, context);
      entry.context = `frames/${base}.json`;
    } catch (error) { entry.contextError = message(error); }
    frameEntries.push(entry);
  }

  await json('theme.json', workspace.theme());
  await json('components.json', workspace.components(200));
  const manifest = {
    generator: 'lienza-cli',
    document: documentSummary(status),
    provenance: { fig: 'Value or relationship read from the .fig', inferred: 'Statistical grouping derived from observed values; not a declared variable' },
    files: { theme: 'theme.json', components: 'components.json' },
    pages, frames: frameEntries, assets,
  };
  await json('manifest.json', manifest);
  return { out, pages: pages.length, frames: frameEntries.length, assets: assetFiles.size,
    failures: frameEntries.filter(entry => entry.renderError || entry.contextError || entry.pngError).length };
}
