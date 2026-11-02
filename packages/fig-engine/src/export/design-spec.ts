/**
 * Design-spec export — condensed node tree + CSS/tokens for implementation handoff.
 */

import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import type { FigNode, SceneNode, SimplifiedNode, ImageStore } from "../parser/types.js";
import {
  simplifyNode,
  getNodeBounds,
  getPrimaryFillColor,
  getPrimaryStrokeColor,
  inferLayoutFromAutoLayout,
} from "../parser/layout-inference.js";
import { formatGUID } from "../parser/kiwi-parser.js";
import { renderScreen, generateScreenshot } from "../renderer/index.js";

export interface DesignSpecTokens {
  colors: string[];
  fonts: Array<{ family: string; size: number; weight: number }>;
}

export interface DesignSpecText {
  content: string;
  font?: string;
  size?: number;
  weight?: number;
  color?: string;
  letterSpacing?: number;
}

export interface DesignSpecLayout {
  direction?: string;
  gap?: number;
  padding?: { top: number; right: number; bottom: number; left: number };
  widthMode?: string;
  heightMode?: string;
  horizontalAlign?: string;
  verticalAlign?: string;
}

export interface DesignSpec {
  nodeId: string;
  name: string;
  type: string;
  bounds?: { x: number; y: number; width: number; height: number };
  css: Record<string, string | number>;
  tokens: DesignSpecTokens;
  layout?: DesignSpecLayout;
  tree: SimplifiedNode | null;
  text: DesignSpecText[];
}

function collectTokens(node: FigNode, tokens: DesignSpecTokens, textOut: DesignSpecText[]): void {
  const scene = node as SceneNode;

  const fill = getPrimaryFillColor(scene.fills);
  if (fill && !tokens.colors.includes(fill)) tokens.colors.push(fill);

  const stroke = getPrimaryStrokeColor(scene.strokes);
  if (stroke && !tokens.colors.includes(stroke)) tokens.colors.push(stroke);

  if (scene.type === "TEXT" && scene.characters !== undefined) {
    const style = scene.style;
    const entry: DesignSpecText = {
      content: scene.characters,
      font: style?.fontFamily,
      size: style?.fontSize,
      weight: style?.fontWeight,
      color: fill,
      letterSpacing: style?.letterSpacing,
    };
    textOut.push(entry);
    if (style?.fontFamily) {
      const exists = tokens.fonts.some(
        (f) =>
          f.family === style.fontFamily &&
          f.size === (style.fontSize ?? 0) &&
          f.weight === (style.fontWeight ?? 400),
      );
      if (!exists) {
        tokens.fonts.push({
          family: style.fontFamily,
          size: style.fontSize ?? 14,
          weight: style.fontWeight ?? 400,
        });
      }
    }
  }

  if (node.children) {
    for (const child of node.children) {
      collectTokens(child as FigNode, tokens, textOut);
    }
  }
}

function buildCss(node: SceneNode): Record<string, string | number> {
  const css: Record<string, string | number> = {};
  const bounds = getNodeBounds(node);
  if (bounds) {
    css.width = `${bounds.width}px`;
    css.height = `${bounds.height}px`;
  }
  const bg = getPrimaryFillColor(node.fills);
  if (bg) css.backgroundColor = bg;
  const border = getPrimaryStrokeColor(node.strokes);
  if (border) {
    css.borderColor = border;
    if (node.strokeWeight !== undefined) css.borderWidth = `${node.strokeWeight}px`;
  }
  if (typeof node.cornerRadius === "number") {
    css.borderRadius = `${node.cornerRadius}px`;
  } else if (node.cornerRadius && typeof node.cornerRadius === "object") {
    const c = node.cornerRadius;
    css.borderRadius = `${c.topLeft}px ${c.topRight}px ${c.bottomRight}px ${c.bottomLeft}px`;
  }
  if (node.opacity !== undefined && node.opacity < 1) {
    css.opacity = node.opacity;
  }
  if (node.type === "TEXT" && node.style) {
    css.fontFamily = node.style.fontFamily;
    css.fontSize = `${node.style.fontSize}px`;
    css.fontWeight = node.style.fontWeight;
    if (node.style.letterSpacing) {
      css.letterSpacing = `${node.style.letterSpacing}px`;
    }
    const textColor = getPrimaryFillColor(node.fills);
    if (textColor) css.color = textColor;
  }
  return css;
}

/**
 * Build a design-spec object for a node subtree.
 */
export function buildDesignSpec(node: FigNode, maxDepth = 8): DesignSpec {
  const scene = node as SceneNode;
  const tokens: DesignSpecTokens = { colors: [], fonts: [] };
  const text: DesignSpecText[] = [];
  collectTokens(node, tokens, text);

  let layout: DesignSpecLayout | undefined;
  try {
    const inferred = inferLayoutFromAutoLayout(scene);
    if (inferred) {
      layout = {
        direction: inferred.direction,
        gap: inferred.gap,
        padding: inferred.padding,
        widthMode: inferred.widthMode,
        heightMode: inferred.heightMode,
        horizontalAlign: inferred.horizontalAlign,
        verticalAlign: inferred.verticalAlign,
      };
    }
  } catch {
    layout = undefined;
  }

  return {
    nodeId: formatGUID(node.guid),
    name: node.name,
    type: node.type,
    bounds: getNodeBounds(scene),
    css: buildCss(scene),
    tokens,
    layout,
    tree: simplifyNode(node, 0, maxDepth),
    text,
  };
}

export interface SaveNodeAssetsOptions {
  outputDir: string;
  images?: ImageStore | Map<string, Uint8Array>;
  blobs?: Array<{ bytes: Uint8Array }>;
  writePng?: boolean;
  nodeIndex?: Map<string, FigNode>;
  rawNodeIndex?: Map<string, Record<string, unknown>>;
  scale?: number;
}

export interface SaveNodeAssetsResult {
  outputDir: string;
  written: string[];
  pngPath?: string;
  imageHashes: string[];
}

function collectImageHashes(node: FigNode, out: Set<string>): void {
  const scene = node as SceneNode;
  const paints = [...(scene.fills ?? []), ...(scene.strokes ?? [])];
  for (const paint of paints) {
    if (paint.type === "IMAGE" && paint.imageRef) {
      out.add(paint.imageRef.toLowerCase());
    }
  }
  if (node.children) {
    for (const child of node.children) {
      collectImageHashes(child as FigNode, out);
    }
  }
}

/**
 * Write referenced images (+ optional PNG render) for a node to outputDir.
 */
export async function saveNodeAssets(
  node: FigNode,
  options: SaveNodeAssetsOptions,
): Promise<SaveNodeAssetsResult> {
  const { outputDir, images, writePng = true } = options;
  await mkdir(outputDir, { recursive: true });

  const hashes = new Set<string>();
  collectImageHashes(node, hashes);
  const written: string[] = [];
  const imageHashes: string[] = [];

  if (images) {
    for (const hash of hashes) {
      const data =
        "get" in images
          ? images.get(hash) ?? images.get(hash.toLowerCase())
          : undefined;
      if (!data) continue;
      const ext = guessExt(data);
      const path = join(outputDir, `${hash}${ext}`);
      await writeFile(path, data);
      written.push(path);
      imageHashes.push(hash);
    }
  }

  let pngPath: string | undefined;
  if (writePng) {
    const result = renderScreen(node, images, options.blobs, {
      includeImages: true,
      includeText: true,
      includeFills: true,
      includeStrokes: true,
      includeShadows: true,
      scale: options.scale ?? 1,
      nodeIndex: options.nodeIndex,
      rawNodeIndex: options.rawNodeIndex,
    });
    const shot = await generateScreenshot(result.svg, {
      pixelPerfect: true,
      scale: options.scale ?? 1,
    });
    pngPath = join(outputDir, `${sanitizeName(node.name)}.png`);
    await writeFile(pngPath, Buffer.from(shot.base64, "base64"));
    written.push(pngPath);
  }

  return { outputDir, written, pngPath, imageHashes };
}

function sanitizeName(name: string): string {
  return name.replace(/[^\w.-]+/g, "_").slice(0, 80) || "node";
}

function guessExt(data: Uint8Array): string {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return ".jpg";
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return ".png";
  }
  if (data.length >= 4 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return ".gif";
  if (
    data.length >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46
  ) {
    return ".webp";
  }
  return ".bin";
}

