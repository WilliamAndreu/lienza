/**
 * Shared types for the SVG renderer modules
 */

import type { FigNode } from "../parser/types.js";

export type TransformMatrix = {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
};

export type BlobEntry = {
  bytes: Uint8Array;
};

export type RenderContext = {
  defs: string[];
  clipCounter: number;
  shadowCounter: number;
  warnings: string[];
  imageHashes: Set<string>;
  usedTrueGeometry: boolean;
  imageResolver?: {
    assetBase?: string;
    hashToPath?: Map<string, string>;
    allowBase64?: boolean;
  };
};

export type PathCommand = {
  cmd: number;
  values: number[];
};

export type RenderScreenOptions = {
  maxDepth?: number;
  includeText?: boolean;
  includeFills?: boolean;
  includeStrokes?: boolean;
  includeImages?: boolean;
  includeShadows?: boolean;
  background?: string;
  includeCanvasBackground?: boolean;
  scale?: number;
  /** Node index for resolving INSTANCE references. Required to render INSTANCE children. */
  nodeIndex?: Map<string, FigNode>;
  /** Raw node index for accessing symbolOverrides data. Required for INSTANCE content resolution. */
  rawNodeIndex?: Map<string, Record<string, unknown>>;
  resolveInstances?: boolean;
  imageResolver?: RenderContext["imageResolver"];
  /** Keep the requested frame bounds for exported assets. */
  viewport?: "content" | "node";
};

export type RenderScreenResult = {
  svg: string;
  width: number;
  height: number;
  warnings: string[];
  imageHashes: string[];
  usedTrueGeometry: boolean;
};

export const DEFAULT_RENDER_OPTIONS: Required<Omit<RenderScreenOptions, 'nodeIndex' | 'rawNodeIndex' | 'imageResolver'>> & Pick<RenderScreenOptions, 'nodeIndex' | 'rawNodeIndex' | 'imageResolver'> = {
  maxDepth: 200,
  includeText: true,
  includeFills: true,
  includeStrokes: true,
  includeImages: true,
  includeShadows: true,
  background: "",
  includeCanvasBackground: true,
  scale: 1,
  nodeIndex: undefined,
  rawNodeIndex: undefined,
  resolveInstances: true,
  imageResolver: undefined,
  viewport: "content",
};

export const IDENTITY_TRANSFORM: TransformMatrix = {
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  e: 0,
  f: 0,
};
