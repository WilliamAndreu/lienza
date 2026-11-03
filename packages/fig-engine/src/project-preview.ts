import type { CanvasNode, FigNode } from './parser/types.js';
import { getRenderBounds } from './renderer/render-screen.js';

const MAX_NODES = 3_000;
const MAX_SIDE = 4_000;
const MAX_AREA = 12_000_000;

const visible = (node: FigNode) => node.visible !== false && node.opacity !== 0;
const named = (node: FigNode, name: string) => new RegExp(`^#?\\s*${name}$`, 'i').test(node.name.trim());

/** Never infer a cover from an unrelated page's aspect ratio. */
export function selectProjectPreviewTarget(pages: FigNode[]): FigNode | undefined {
  const candidates = pages.filter((page): page is CanvasNode => page.type === 'CANVAS' && visible(page) && (page.children ?? []).some(visible));
  const cover = candidates.find(page => named(page, 'cover'));
  if (cover) {
    const children = cover.children.filter(visible);
    return children.find(child => named(child, 'thumbnail'))
      ?? children.find(child => named(child, 'cover'))
      ?? cover;
  }
  const thumbnailPage = candidates.find(page => named(page, 'thumbnail'));
  if (thumbnailPage) return thumbnailPage;
  for (const name of ['thumbnail', 'cover']) {
    for (const page of candidates) {
      const layer = page.children.find(child => visible(child) && named(child, name));
      if (layer) return layer;
    }
  }
  return undefined;
}

/** Validate the whole subtree before SVG generation or rasterization. */
export function isSafeProjectPreviewTarget(target: FigNode): boolean {
  const stack = [target];
  let count = 0;
  while (stack.length) {
    const node = stack.pop()!;
    if (!visible(node)) continue;
    if (++count > MAX_NODES) return false;
    stack.push(...(node.children ?? []));
  }
  const bounds = getRenderBounds(target);
  if (!bounds) return false;
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  return Number.isFinite(width) && Number.isFinite(height)
    && width > 0 && height > 0
    && width <= MAX_SIDE && height <= MAX_SIDE
    && width * height <= MAX_AREA;
}
