/** Export and preview share the same SVG composition pipeline. */
import type { FigNode } from '../parser/types.js';
import type { ImageStore } from '../parser/fig-reader.js';
import type { BlobEntry } from '../renderer/render-types.js';
import { renderScreen } from '../renderer/render-screen.js';
import { prepareSvgFonts } from '../font-catalog.js';

export interface TrueSvgImageResolver {
  assetBase?: string;
  hashToPath?: Map<string, string>;
  allowBase64?: boolean;
}

export interface TrueSvgOptions {
  blobs?: BlobEntry[];
  images?: ImageStore | { get(hash: string): Uint8Array | undefined };
  nodeIndex?: Map<string, FigNode>;
  rawNodeIndex?: Map<string, Record<string, unknown>>;
  resolveInstances?: boolean;
  maxDepth?: number;
  imageResolver?: TrueSvgImageResolver;
  background?: string;
}

export interface TrueSvgResult {
  svg: string;
  width: number;
  height: number;
  warnings: string[];
  imageHashes: string[];
  usedTrueGeometry: boolean;
}

export function exportNodeTrueSvg(node: FigNode, options: TrueSvgOptions = {}): TrueSvgResult {
  const rendered = renderScreen(node, options.images, options.blobs, {
    nodeIndex: options.nodeIndex,
    rawNodeIndex: options.rawNodeIndex,
    resolveInstances: options.resolveInstances ?? true,
    maxDepth: options.maxDepth ?? 200,
    imageResolver: options.imageResolver,
    background: options.background,
    viewport: 'node',
  });
  return { ...rendered, svg: prepareSvgFonts(rendered.svg).svg };
}
