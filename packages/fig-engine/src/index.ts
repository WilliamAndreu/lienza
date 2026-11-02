import { parseFigBinary } from 'openfig-core';
import { readFigFile } from './parser/fig-reader.js';
import { extractDocumentTree, formatGUID, parseCanvasFig } from './parser/kiwi-parser.js';
import { buildNodeIdIndex, buildRawNodeIndex } from './parser/index.js';
import { resolveLinkedPaintStyles } from './parser/linked-styles.js';
import { getRenderBounds, renderScreen } from './renderer/render-screen.js';
import { generateScreenshot } from './renderer/screenshot.js';
import { IDENTITY_TRANSFORM } from './renderer/render-types.js';
import { getLocalTransform, multiplyTransforms, transformPoint } from './renderer/render-utils.js';
import { prepareSvgFonts } from './font-catalog.js';
import type { FigNode, SceneNode, ImageStore } from './parser/types.js';
import type { TransformMatrix } from './renderer/render-types.js';

export type { FigNode, SceneNode } from './parser/types.js';
export type { ImageStore } from './parser/fig-reader.js';
export { formatGUID } from './parser/kiwi-parser.js';
export { resolveFontFamily } from './font-catalog.js';
export { paintToImageHash, detectImageFormat, getMimeType } from './renderer/paint-utils.js';
export async function readFigThumbnail(filePath: string): Promise<Uint8Array | undefined> {
  return (await readFigFile(filePath)).thumbnail;
}

/** Rebuild the page used by Figma's thumbnail at a resolution suitable for a large project plate. */
export async function renderFigProjectPreview(filePath: string): Promise<Uint8Array | undefined> {
  const file = await loadFig(filePath);
  const source = file.thumbnail;
  const sourceSize = source && source.length >= 24
    && source.subarray(0, 8).every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index])
    ? { width: new DataView(source.buffer, source.byteOffset + 16, 8).getUint32(0), height: new DataView(source.buffer, source.byteOffset + 16, 8).getUint32(4) }
    : null;
  const sourceRatio = sourceSize && sourceSize.height > 0 ? sourceSize.width / sourceSize.height : null;
  const candidates = (file.document.children ?? [])
    .filter(page => page.visible !== false && (page.children?.length ?? 0) > 0)
    .map(page => {
      const bounds = getRenderBounds(page);
      const width = bounds ? bounds.maxX - bounds.minX : 0;
      const height = bounds ? bounds.maxY - bounds.minY : 0;
      return { page, width, height, difference: sourceRatio && width > 0 && height > 0 ? Math.abs(Math.log(width / height / sourceRatio)) : Infinity };
    })
    .filter(candidate => candidate.width > 0 && candidate.height > 0);
  const selected = sourceRatio
    ? candidates.sort((a, b) => a.difference - b.difference)[0]
    : candidates.find(candidate => /^cover$/i.test(candidate.page.name ?? ''));
  // A custom thumbnail may not represent any page. Keep Figma's image in that case.
  if (!selected || (sourceRatio && selected.difference > 0.04)) return undefined;
  const rendered = renderFigNode(file, formatGUID(selected.page.guid));
  if (!rendered.svg || !rendered.width || !rendered.height) return undefined;
  const scale = Math.min(2, 1800 / rendered.width, 2000 / rendered.height);
  const prepared = prepareSvgFonts(rendered.svg);
  const image = await generateScreenshot(rendered.svg, { pixelPerfect: true, scale, fontFiles: prepared.fontFiles });
  return Buffer.from(image.base64, 'base64');
}
export { renderScreen } from './renderer/render-screen.js';
export { exportNodeTrueSvg } from './export/true-svg.js';
export { analyzeTheme } from './theme/analyze-theme.js';
export type { ThemeReport } from './theme/analyze-theme.js';

export interface LoadedFig {
  name: string;
  filePath: string;
  version: number;
  parser: 'openfig-core' | 'echobt-fallback';
  document: FigNode;
  nodeIndex: Map<string, FigNode>;
  rawNodeIndex: Map<string, Record<string, unknown>>;
  images: ImageStore;
  thumbnail?: Uint8Array;
  blobs: Array<{ bytes: Uint8Array }>;
}

export interface HitArea {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
}

/** Keep the fork's lazy ZIP image store while using OpenFig to decode canvas.fig. */
export async function loadFig(filePath: string): Promise<LoadedFig> {
  const archive = await readFigFile(filePath);
  let version: number;
  let message: Record<string, unknown>;
  let parser: LoadedFig['parser'];

  try {
    const parsed = parseFigBinary(archive.canvasFig);
    version = parsed.header.version;
    message = parsed.message as Record<string, unknown>;
    parser = 'openfig-core';
  } catch (error) {
    // Retain compatibility with a .fig revision OpenFig has not handled yet.
    const parsed = parseCanvasFig(archive.canvasFig);
    version = parsed.version;
    message = parsed.message;
    parser = 'echobt-fallback';
    console.warn('OpenFig parser failed; using the fork parser:', error);
  }

  const document = extractDocumentTree(message);
  if (!document) throw new Error('Could not reconstruct the .fig document tree');

  const rawNodeIndex = buildRawNodeIndex(message);
  resolveLinkedPaintStyles(document, rawNodeIndex);

  return {
    name: archive.meta.name ?? filePath.split('/').pop() ?? 'Untitled design',
    filePath,
    version,
    parser,
    document,
    nodeIndex: buildNodeIdIndex(document),
    rawNodeIndex,
    images: archive.images,
    thumbnail: archive.thumbnail,
    blobs: (message.blobs as Array<{ bytes: Uint8Array }> | undefined) ?? [],
  };
}

export function renderFigNode(file: LoadedFig, nodeId: string, options: { includeCanvasBackground?: boolean } = {}) {
  const node = file.nodeIndex.get(nodeId);
  if (!node) throw new Error(`Node ${nodeId} not found`);
  const rendered = renderScreen(node, file.images, file.blobs, {
    nodeIndex: file.nodeIndex,
    rawNodeIndex: file.rawNodeIndex,
    includeCanvasBackground: options.includeCanvasBackground ?? true,
  });
  const prepared = prepareSvgFonts(rendered.svg);
  return { ...rendered, svg: prepared.svg };
}

export async function screenshotFigNode(file: LoadedFig, nodeId: string, options: { pixelPerfect?: boolean; maxWidth?: number; maxHeight?: number } = { pixelPerfect: true }) {
  const rendered = renderFigNode(file, nodeId);
  if (!rendered.svg) throw new Error('The node has no visible content');
  const prepared = prepareSvgFonts(rendered.svg);
  return generateScreenshot(rendered.svg, { ...options, fontFiles: prepared.fontFiles });
}

/** Bounding boxes aligned with renderScreen's viewBox, used for canvas hit targets. */
export function getHitAreas(root: FigNode): HitArea[] {
  const areas: HitArea[] = [];
  const bounds = getRenderBounds(root);
  if (!bounds) return areas;

  function walk(node: FigNode, parent: TransformMatrix, depth: number): void {
    if (node.visible === false || node.locked === true || node.opacity === 0) return;
    const scene = node as SceneNode;
    const world = multiplyTransforms(parent, getLocalTransform(scene));
    if (node.type !== 'DOCUMENT' && node.type !== 'CANVAS' && scene.width && scene.height) {
      const corners = [
        transformPoint(0, 0, world),
        transformPoint(scene.width, 0, world),
        transformPoint(scene.width, scene.height, world),
        transformPoint(0, scene.height, world),
      ];
      const xs = corners.map(point => point.x);
      const ys = corners.map(point => point.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      const width = Math.max(...xs) - x;
      const height = Math.max(...ys) - y;
      if (Number.isFinite(x + y + width + height) && width > 0 && height > 0) {
        areas.push({ id: formatGUID(node.guid), x, y, width, height, depth });
      }
    }
    for (const child of node.children ?? []) walk(child as FigNode, world, depth + 1);
  }

  walk(root, IDENTITY_TRANSFORM, 0);
  return areas.map(area => ({ ...area, x: area.x - bounds.minX, y: area.y - bounds.minY }));
}
