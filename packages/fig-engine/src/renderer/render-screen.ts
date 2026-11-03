/**
 * Render Screen - Improved vector rendering
 *
 * Key improvements:
 * 1. For stroked vectors: Use vectorNetworkBlob or normalizedSize to get centerline, NOT strokeGeometry
 * 2. strokeGeometry contains pre-outlined stroke - only use as fallback
 * 3. Proper transform composition for rotated/positioned vectors
 * 4. Better detection of stroked vs filled vectors
 * 5. Mask rendering support (isMask flag handling)
 * 6. Image embedding support
 * 7. Full text styling (font-style, letter-spacing, etc.)
 */

import type {
  FigNode,
  CanvasNode,
  SceneNode,
  TextStyle,
  Paint,
  DerivedTextData,
  Effect,
  Color,
  GUID,
} from "../parser/types.js";
import { formatGUID } from "../parser/kiwi-parser.js";
import { iconFontFallback } from "./icon-font-fallbacks.js";
import { extractInstanceContent, resolveInstanceChildren, type ResolvedInstanceContent } from "../parser/instance-resolver.js";
import type {
  TransformMatrix,
  BlobEntry,
  RenderContext,
  RenderScreenOptions,
  RenderScreenResult,
} from "./render-types.js";
import { DEFAULT_RENDER_OPTIONS, IDENTITY_TRANSFORM } from "./render-types.js";
import {
  escapeXml,
  multiplyTransforms,
  getLocalTransform,
  transformPoint,
  clippedTextOverflowTop,
} from "./render-utils.js";
import {
  getPaints,
  getVisiblePaint,
  paintToColor,
  paintToImageHash,
  detectImageFormat,
  getMimeType,
} from "./paint-utils.js";
import {
  isStrokedVector,
  renderStrokedVector,
  renderFilledVector,
} from "./vector-renderer.js";
import { nodeFillStrokePaths } from "../export/geometry.js";
import { blendStyle, imagePaintTransform, paintToSvgFill, svgMatrix } from "./svg-paint.js";

// Re-export types for external consumers
export type {
  RenderScreenOptions,
  RenderScreenResult,
} from "./render-types.js";

// ============================================================================
// Shadow/Effect Rendering
// ============================================================================

/**
 * Convert a color to an rgba() string for SVG
 */
function colorToRgba(color: Color | undefined): string {
  if (!color) return "rgba(0,0,0,0.25)";
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = color.a ?? 1;
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

/**
 * Generate an SVG filter definition for a drop shadow effect.
 * Returns the filter ID.
 */
function generateDropShadowFilter(
  effect: Effect,
  ctx: RenderContext,
): string {
  const filterId = `shadow-${ctx.shadowCounter++}`;
  const x = effect.offset?.x ?? 0;
  const y = effect.offset?.y ?? 0;
  const blur = effect.radius ?? 0;
  const spread = effect.spread ?? 0;
  const color = colorToRgba(effect.color);

  // For SVG, we use feDropShadow or a combination of feGaussianBlur + feOffset + feFlood
  // feDropShadow is simpler but has less control over spread
  // We'll use a more complex filter to support spread

  if (spread === 0) {
    // Simple drop shadow without spread
    ctx.defs.push(
      `<filter id="${filterId}" x="-50%" y="-50%" width="200%" height="200%">` +
      `<feDropShadow dx="${x}" dy="${y}" stdDeviation="${blur / 2}" flood-color="${color}" />` +
      `</filter>`
    );
  } else {
    // Drop shadow with spread - use morphology to expand/contract
    // stdDeviation is blur/2 because SVG blur is roughly 2x CSS blur
    const stdDev = blur / 2;
    ctx.defs.push(
      `<filter id="${filterId}" x="-100%" y="-100%" width="300%" height="300%">` +
      // Create the shadow
      `<feGaussianBlur in="SourceAlpha" stdDeviation="${stdDev}" result="blur" />` +
      // Apply spread using morphology (dilate for positive, erode for negative)
      (spread !== 0
        ? `<feMorphology in="blur" operator="${spread > 0 ? 'dilate' : 'erode'}" radius="${Math.abs(spread)}" result="spread" />`
        : `<feOffset in="blur" result="spread" />`) +
      // Offset the shadow
      `<feOffset in="spread" dx="${x}" dy="${y}" result="offsetBlur" />` +
      // Color the shadow
      `<feFlood flood-color="${color}" result="color" />` +
      `<feComposite in="color" in2="offsetBlur" operator="in" result="shadow" />` +
      // Merge with original
      `<feMerge>` +
      `<feMergeNode in="shadow" />` +
      `<feMergeNode in="SourceGraphic" />` +
      `</feMerge>` +
      `</filter>`
    );
  }

  return filterId;
}

/**
 * Generate an SVG filter definition for an inner shadow effect.
 * Returns the filter ID.
 */
function generateInnerShadowFilter(
  effect: Effect,
  ctx: RenderContext,
): string {
  const filterId = `inner-shadow-${ctx.shadowCounter++}`;
  const x = effect.offset?.x ?? 0;
  const y = effect.offset?.y ?? 0;
  const blur = effect.radius ?? 0;
  const color = colorToRgba(effect.color);
  const stdDev = blur / 2;

  // Inner shadow is created by:
  // 1. Invert the alpha of the source
  // 2. Apply blur and offset
  // 3. Clip to original shape
  ctx.defs.push(
    `<filter id="${filterId}" x="-50%" y="-50%" width="200%" height="200%">` +
    // Invert the source alpha to get the "outside" shape
    `<feComponentTransfer in="SourceAlpha" result="inverse">` +
    `<feFuncA type="table" tableValues="1 0" />` +
    `</feComponentTransfer>` +
    // Blur the inverted shape
    `<feGaussianBlur in="inverse" stdDeviation="${stdDev}" result="blur" />` +
    // Offset the blur
    `<feOffset in="blur" dx="${x}" dy="${y}" result="offsetBlur" />` +
    // Color the shadow
    `<feFlood flood-color="${color}" result="color" />` +
    `<feComposite in="color" in2="offsetBlur" operator="in" result="shadow" />` +
    // Clip to original shape
    `<feComposite in="shadow" in2="SourceAlpha" operator="in" result="innerShadow" />` +
    // Merge with original
    `<feMerge>` +
    `<feMergeNode in="SourceGraphic" />` +
    `<feMergeNode in="innerShadow" />` +
    `</feMerge>` +
    `</filter>`
  );

  return filterId;
}

/**
 * Generate SVG filter(s) for a node's effects.
 * Returns the filter ID to apply, or undefined if no filters needed.
 */
function generateEffectFilters(
  node: SceneNode,
  ctx: RenderContext,
  includeShadows: boolean,
  worldTransform: TransformMatrix,
): string | undefined {
  if (!includeShadows || !node.effects || node.effects.length === 0) {
    return undefined;
  }

  // Collect visible shadow effects
  const dropShadows = node.effects.filter(
    (e) => e.type === "DROP_SHADOW" && e.visible !== false
  );
  const innerShadows = node.effects.filter(
    (e) => e.type === "INNER_SHADOW" && e.visible !== false
  );

  const layerBlur = node.effects.find(
    (e) => (e.type === "LAYER_BLUR" || e.type === "FOREGROUND_BLUR") && e.visible !== false && e.radius > 0
  );

  if (dropShadows.length === 0 && innerShadows.length === 0 && !layerBlur) {
    return undefined;
  }

  // For simplicity, we'll handle the first drop shadow and first inner shadow
  // A more complete implementation would combine multiple effects
  if (dropShadows.length > 0) {
    return generateDropShadowFilter(dropShadows[0], ctx);
  }
  if (innerShadows.length > 0) {
    return generateInnerShadowFilter(innerShadows[0], ctx);
  }

  if (layerBlur) {
    if (!node.width || !node.height) return undefined;
    const corners = [
      transformPoint(0, 0, worldTransform),
      transformPoint(node.width, 0, worldTransform),
      transformPoint(node.width, node.height, worldTransform),
      transformPoint(0, node.height, worldTransform),
    ];
    const padding = layerBlur.radius * 3;
    const left = Math.min(...corners.map(point => point.x)) - padding;
    const top = Math.min(...corners.map(point => point.y)) - padding;
    const width = Math.max(...corners.map(point => point.x)) - left + padding;
    const height = Math.max(...corners.map(point => point.y)) - top + padding;
    const filterId = `layer-blur-${ctx.shadowCounter++}`;
    ctx.defs.push(`<filter id="${filterId}" filterUnits="userSpaceOnUse" x="${left}" y="${top}" width="${width}" height="${height}"><feGaussianBlur in="SourceGraphic" stdDeviation="${layerBlur.radius}" /></filter>`);
    return filterId;
  }

  return undefined;
}

/** Baked .fig geometry is already in node coordinates; preserve its paths and winding rule. */
function renderBakedGeometry(
  node: SceneNode,
  transform: TransformMatrix,
  images: { get(hash: string): Uint8Array | undefined } | undefined,
  blobs: BlobEntry[] | undefined,
  ctx: RenderContext,
  includeFills: boolean,
  includeStrokes: boolean,
  includeImages: boolean,
  output: string[],
): boolean {
  const entries = nodeFillStrokePaths(node, blobs, transform);
  const strokePaint = getVisiblePaint(getPaints(node as FigNode, "strokes"));
  const insideStrokeColor = paintToColor(strokePaint);
  const isFullEllipse = entries.some(entry => entry.kind === "fill"
    && entry.commands.length === 6
    && entry.commands[0]?.cmd === 1
    && entry.commands.slice(1, 5).every(command => command.cmd === 4)
    && entry.commands[5]?.cmd === 0);
  const insideEllipseStroke = node.type === "ELLIPSE"
    && node.strokeAlign === "INSIDE"
    && isFullEllipse
    && !!node.width && !!node.height
    && (node.strokeWeight ?? 0) > 0
    && !!insideStrokeColor
    && !node.strokeDashes?.length;
  let rendered = false;
  for (const entry of entries) {
    if (entry.kind === "fill" && !includeFills && !(includeImages && entry.paints?.some(paint => paint.type === "IMAGE"))) continue;
    if (entry.kind === "stroke" && !includeStrokes) continue;
    // Figma's expanded stroke geometry can extend beyond an ellipse's frame.
    // When the frame clips its children, this creates a squared-off ring.
    if (entry.kind === "stroke" && insideEllipseStroke) continue;
    const evenOdd = ["ODD", "EVENODD", "EVEN_ODD"].includes(entry.windingRule ?? "");
    for (const paint of entry.paints ?? (entry.paint ? [entry.paint] : [])) {
      if (paint.visible === false) continue;
      if (paint.type === "IMAGE") {
        if (includeImages && renderImagePaint(
          paint, node, transform, images, ctx,
          `<path d="${entry.d}" fill-rule="${evenOdd ? "evenodd" : "nonzero"}" />`,
          output,
        )) rendered = true;
        continue;
      }
      if (entry.kind === "fill" && !includeFills) continue;
      const fill = paintToSvgFill(paint, node, transform, ctx);
      if (!fill) continue;
      output.push(`<path d="${entry.d}" fill="${fill}" fill-rule="${evenOdd ? "evenodd" : "nonzero"}"${blendStyle(paint.blendMode)} />`);
      rendered = true;
    }
  }
  if (rendered) ctx.usedTrueGeometry = true;
  if (includeStrokes && insideEllipseStroke) {
    const weight = node.strokeWeight!;
    const rx = Math.max(0, node.width! / 2 - weight / 2);
    const ry = Math.max(0, node.height! / 2 - weight / 2);
    const matrix = `matrix(${transform.a} ${transform.b} ${transform.c} ${transform.d} ${transform.e} ${transform.f})`;
    output.push(`<ellipse cx="${node.width! / 2}" cy="${node.height! / 2}" rx="${rx}" ry="${ry}" transform="${matrix}" fill="none" stroke="${insideStrokeColor}" stroke-width="${weight}" />`);
    rendered = true;
  }
  return rendered;
}

/** Clip image paints to the actual Figma shape, including vector and ellipse paths. */
function renderImagePaint(
  paint: Paint,
  node: SceneNode,
  transform: TransformMatrix,
  images: { get(hash: string): Uint8Array | undefined } | undefined,
  ctx: RenderContext,
  shape: string,
  output: string[],
): boolean {
  const hash = paintToImageHash(paint);
  if (!hash) return false;
  ctx.imageHashes.add(hash);
  const mapped = ctx.imageResolver?.hashToPath?.get(hash) ?? ctx.imageResolver?.hashToPath?.get(hash.toLowerCase());
  const data = !mapped && ctx.imageResolver?.allowBase64 !== false ? images?.get(hash) : undefined;
  const base = ctx.imageResolver?.assetBase;
  const href = mapped
    ? base ? `${base.replace(/\/$/, "")}/${mapped}` : mapped
    : data ? `data:${getMimeType(detectImageFormat(data))};base64,${Buffer.from(data).toString("base64")}` : undefined;
  if (!href) {
    ctx.warnings.push(`Imagen no disponible: ${hash.slice(0, 12)}…`);
    return false;
  }

  const width = node.width ?? 0;
  const height = node.height ?? 0;
  const clipId = `image-clip-${ctx.clipCounter++}`;
  ctx.defs.push(`<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse">${shape}</clipPath>`);
  const mode = paint.imageScaleMode ?? paint.scaleMode ?? "FILL";
  const alpha = paint.opacity !== undefined && paint.opacity < 1 ? ` opacity="${paint.opacity}"` : "";
  if (mode === "TILE") {
    const raw = paint as Paint & { originalImageWidth?: number; originalImageHeight?: number };
    const factor = paint.scalingFactor ?? paint.scale ?? 1;
    const tileWidth = Math.max(1, (raw.originalImageWidth || width) * factor);
    const tileHeight = Math.max(1, (raw.originalImageHeight || height) * factor);
    const patternId = `image-pattern-${ctx.clipCounter++}`;
    ctx.defs.push(`<pattern id="${patternId}" patternUnits="userSpaceOnUse" width="${tileWidth}" height="${tileHeight}" patternTransform="${svgMatrix(transform)}"><image href="${escapeXml(href)}" width="${tileWidth}" height="${tileHeight}" /></pattern>`);
    output.push(`<g clip-path="url(#${clipId})"><path d="M 0 0 H ${width} V ${height} H 0 Z" transform="${svgMatrix(transform)}" fill="url(#${patternId})"${alpha}${blendStyle(paint.blendMode)} /></g>`);
  } else {
    const custom = mode === "CROP" || mode === "STRETCH";
    const imageTransform = custom ? imagePaintTransform(paint, node, transform) : transform;
    const preserve = mode === "FIT" ? "xMidYMid meet" : custom ? "none" : "xMidYMid slice";
    const rotation = paint.rotation ? ` rotate(${paint.rotation} ${width / 2} ${height / 2})` : "";
    output.push(`<g clip-path="url(#${clipId})"><image x="0" y="0" width="${width}" height="${height}" transform="${svgMatrix(imageTransform)}${rotation}" preserveAspectRatio="${preserve}" href="${escapeXml(href)}"${alpha}${blendStyle(paint.blendMode)} /></g>`);
  }
  return true;
}

// ============================================================================
// Text Rendering
// ============================================================================

function renderText(
  node: SceneNode,
  transform: TransformMatrix,
  rawNodeIndex: Map<string, Record<string, unknown>> | undefined,
  output: string[],
): boolean {
  const text = node.characters;
  if (!text) return false;

  const fills = getPaints(node as FigNode, "fills");
  const fillColor = paintToColor(getVisiblePaint(fills)) ?? "#000";

  const style = node.style as TextStyle | undefined;
  const applyTextCase = (value: string, start: number, textCase = style?.textCase): string => {
    switch (textCase) {
      case "UPPER":
        return value.toLocaleUpperCase();
      case "LOWER":
        return value.toLocaleLowerCase();
      case "TITLE":
        return value.replace(/\p{L}+/gu, (word, offset: number) => {
          const previous = text[start + offset - 1];
          return previous && /[\p{L}\p{N}]/u.test(previous)
            ? word
            : word[0]!.toLocaleUpperCase() + word.slice(1).toLocaleLowerCase();
        });
      default:
        return value;
    }
  };
  const fontSize = style?.fontSize ?? 14;
  const icon = iconFontFallback(style?.fontFamily, text, node.width ?? 0, fontSize);
  if (icon) {
    const scaleX = (node.width ?? fontSize) / 24;
    const scaleY = (node.height ?? fontSize) / 24;
    const paint = icon.filled ? `fill="${fillColor}"` : `fill="none" stroke="${fillColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
    output.push(`<g transform="${svgMatrix(transform)}" data-font-fallback="${escapeXml(style?.fontFamily ?? '')}" data-source-ligature="${escapeXml(text)}"><g transform="scale(${scaleX} ${scaleY})" ${paint}>${icon.markup}</g></g>`);
    return true;
  }
  const fontFamily = escapeXml(style?.fontFamily ?? "Inter");
  const fontWeight = style?.fontWeight ?? 400;
  const fontStyle = style?.fontStyle ?? "normal";
  const defaultLineHeight = style?.lineHeightPx ?? fontSize * 1.2;
  const letterSpacing = style?.letterSpacing ?? 0;

  // Handle text alignment
  const anchor = style?.textAlignHorizontal?.toLowerCase() ?? "left";
  const textAnchor =
    anchor === "center" ? "middle" : anchor === "right" ? "end" : "start";
  const width = node.width ?? 0;
  const baseX = textAnchor === "middle" ? width / 2 : textAnchor === "end" ? width : 0;

  const attrs: string[] = [
    `x="${baseX}"`,
    `y="0"`,
    `transform="${svgMatrix(transform)}"`,
    `font-family="${fontFamily}"`,
    `font-size="${fontSize}"`,
    `font-weight="${fontWeight}"`,
    `font-style="${fontStyle}"`,
    `fill="${fillColor}"`,
    `text-anchor="${textAnchor}"`,
  ];

  if (letterSpacing !== 0) {
    attrs.push(`letter-spacing="${letterSpacing}"`);
  }

  if (style?.fontPostScriptName) {
    attrs.push(`data-postscript="${escapeXml(style.fontPostScriptName)}"`);
  }

  // Use derivedTextData.baselines for wrapped text if available
  const derivedTextData = node.derivedTextData as DerivedTextData | undefined;
  const raw = rawNodeIndex?.get(formatGUID(node.guid));
  const textData = raw?.["textData"] as {
    characterStyleIDs?: number[];
    styleOverrideTable?: Array<{
      styleID: number;
      fillPaints?: Paint[];
      styleIdForFill?: { guid?: GUID };
      fontName?: { family?: string; style?: string };
      fontWeight?: number;
      fontSize?: number;
      letterSpacing?: number;
      textCase?: TextStyle["textCase"];
    }>;
  } | undefined;
  const styleById = new Map(textData?.styleOverrideTable?.map(item => [item.styleID, item]) ?? []);
  const styleIds = textData?.characterStyleIDs;

  const styledLine = (start: number, end: number, baselineY: number, suffix = ""): string => {
    if (!styleIds || !styleById.size || start >= end) {
      return `<tspan x="${baseX}" y="${baselineY}">${escapeXml(applyTextCase(text.slice(start, end), start) + suffix)}</tspan>`;
    }
    const parts: string[] = [];
    for (let cursor = start; cursor < end;) {
      const id = styleIds[cursor];
      let next = cursor + 1;
      while (next < end && styleIds[next] === id) next++;
      const override = styleById.get(id ?? -1);
      let runFill = fillColor;
      if (override?.fillPaints?.length) {
        runFill = paintToColor(getVisiblePaint(override.fillPaints)) ?? runFill;
      } else if (override?.styleIdForFill?.guid) {
        const ref = rawNodeIndex?.get(formatGUID(override.styleIdForFill.guid));
        const refPaints = ref?.["fillPaints"] as Paint[] | undefined;
        runFill = paintToColor(getVisiblePaint(refPaints)) ?? runFill;
      }
      const runFamily = override?.fontName?.family ?? style?.fontFamily ?? "Inter";
      const fontName = override?.fontName?.style?.toLowerCase() ?? "";
      const runWeight = override?.fontWeight ?? (fontName.includes("bold") ? 700 : fontName.includes("medium") ? 500 : fontName.includes("light") ? 300 : fontName ? 400 : fontWeight);
      const runSize = override?.fontSize ?? fontSize;
      const runSpacing = override?.letterSpacing ?? letterSpacing;
      const position = cursor === start ? ` x="${baseX}" y="${baselineY}"` : "";
      parts.push(`<tspan${position} fill="${runFill}" font-family="${escapeXml(runFamily)}" font-weight="${runWeight}" font-size="${runSize}" letter-spacing="${runSpacing}">${escapeXml(applyTextCase(text.slice(cursor, next), cursor, override?.textCase ?? style?.textCase))}</tspan>`);
      cursor = next;
    }
    return parts.join("") + (suffix ? `<tspan>${escapeXml(suffix)}</tspan>` : "");
  };
  let spans: string;
  const lineLimit = node.maxLines && node.maxLines > 0 ? Math.floor(node.maxLines) : undefined;

  if (derivedTextData?.baselines && derivedTextData.baselines.length > 0) {
    // Use baselines for proper text wrapping
    const baselines = lineLimit ? derivedTextData.baselines.slice(0, lineLimit) : derivedTextData.baselines;
    spans = baselines
      .map((baseline, index) => {
        // Extract the substring for this line
        const lineText = text.substring(
          baseline.firstCharacter,
          baseline.endCharacter,
        );
        const leading = lineText.length - lineText.trimStart().length;
        const trailing = lineText.length - lineText.trimEnd().length;
        const lineStart = baseline.firstCharacter + leading;
        const lineEnd = baseline.endCharacter - trailing;

        // Figma's derived baseline is an absolute node-local position.
        const baselineY = baseline.position?.y ?? baseline.lineY + baseline.lineAscent;
        const truncated = index === baselines.length - 1 && baseline.endCharacter < text.length;
        return styledLine(lineStart, lineEnd, baselineY,
          truncated && node.textTruncation === "ENDING" ? "…" : "");
      })
      .join("");
  } else {
    // Fallback: split by newlines (for text with explicit line breaks)
    const lines = text.split(/\r?\n/);
    const visibleLines = lineLimit ? lines.slice(0, lineLimit) : lines;
    let lineStart = 0;
    spans = visibleLines
      .map((line, index) => {
        const baselineY = fontSize + index * defaultLineHeight;
        const truncated = index === visibleLines.length - 1 && visibleLines.length < lines.length;
        const content = styledLine(lineStart, lineStart + line.length, baselineY,
          truncated && node.textTruncation === "ENDING" ? "…" : "");
        lineStart += line.length + 1;
        return content;
      })
      .join("");
  }

  output.push(`<text ${attrs.join(" ")}>${spans}</text>`);
  return true;
}

// ============================================================================
// Rectangle Rendering
// ============================================================================

function renderRectangle(
  node: SceneNode,
  transform: TransformMatrix,
  images: { get(hash: string): Uint8Array | undefined } | undefined,
  includeImages: boolean,
  ctx: RenderContext,
  output: string[],
): boolean {
  const width = node.width ?? 0;
  const height = node.height ?? 0;
  if (width <= 0 || height <= 0) return false;
  const radius = typeof node.cornerRadius === "number"
    ? Math.max(0, Math.min(node.cornerRadius, width / 2, height / 2)) : 0;
  const shape = `x="0" y="0" width="${width}" height="${height}" rx="${radius}" ry="${radius}" transform="${svgMatrix(transform)}"`;
  const fills = getPaints(node as FigNode, "fills") ?? [];
  let rendered = false;

  // Each paint is a separate compositing layer in its authored order.
  for (const paint of fills) {
    if (paint.visible === false) continue;
    if (paint.type === "IMAGE") {
      if (!includeImages) continue;
      if (renderImagePaint(paint, node, transform, images, ctx, `<rect ${shape} />`, output)) rendered = true;
      continue;
    }
    // The rect already carries `transform`; its user-space gradient stays local.
    const fill = paintToSvgFill(paint, node, IDENTITY_TRANSFORM, ctx);
    if (!fill) continue;
    output.push(`<rect ${shape} fill="${fill}"${blendStyle(paint.blendMode)} />`);
    rendered = true;
  }

  for (const paint of getPaints(node as FigNode, "strokes") ?? []) {
    if (paint.visible === false) continue;
    const stroke = paintToSvgFill(paint, node, IDENTITY_TRANSFORM, ctx);
    if (!stroke) continue;
    const weight = node.strokeWeight ?? 1;
    const inset = node.strokeAlign === "INSIDE" ? weight / 2 : node.strokeAlign === "OUTSIDE" ? -weight / 2 : 0;
    const strokeShape = `x="${inset}" y="${inset}" width="${Math.max(0, width - inset * 2)}" height="${Math.max(0, height - inset * 2)}" rx="${Math.max(0, radius - inset)}" ry="${Math.max(0, radius - inset)}" transform="${svgMatrix(transform)}"`;
    output.push(`<rect ${strokeShape} fill="none" stroke="${stroke}" stroke-width="${weight}"${blendStyle(paint.blendMode)} />`);
    rendered = true;
  }
  return rendered;
}

// ============================================================================
// Main Node Rendering
// ============================================================================

const VECTOR_TYPES = new Set([
  "VECTOR",
  "LINE",
  "STAR",
  "REGULAR_POLYGON",
  "ELLIPSE",
  "BOOLEAN_OPERATION",
]);
const CONTAINER_TYPES = new Set(["FRAME", "GROUP", "COMPONENT", "INSTANCE", "SECTION"]);

/**
 * Render a mask node to create a clipPath definition.
 * Returns the clip path content for the mask.
 */
function renderMaskContent(
  node: SceneNode,
  transform: TransformMatrix,
  blobs: BlobEntry[] | undefined,
  images: { get(hash: string): Uint8Array | undefined } | undefined,
  ctx: RenderContext,
): string {
  const width = node.width ?? 0;
  const height = node.height ?? 0;

  const paths = nodeFillStrokePaths(node, blobs, transform)
    .filter(entry => entry.kind === "fill")
    .map(entry => {
      const alpha = Math.max(0, Math.min(1, (node.opacity ?? 1) * (entry.paint?.opacity ?? 1) * (entry.paint?.color?.a ?? 1)));
      const rawColor = entry.paint?.color;
      const color = node.maskType === "LUMINANCE" && rawColor
        ? `rgb(${Math.round(rawColor.r * 255)}, ${Math.round(rawColor.g * 255)}, ${Math.round(rawColor.b * 255)})`
        : "white";
      return `<path d="${entry.d}" fill="${color}" fill-opacity="${alpha}" fill-rule="${["ODD", "EVENODD", "EVEN_ODD"].includes(entry.windingRule ?? "") ? "evenodd" : "nonzero"}" />`;
    });
  if ((getPaints(node as FigNode, "fills") ?? []).some(paint => paint.visible !== false && paint.type === "IMAGE")) {
    const imageOutput: string[] = [];
    renderRectangle(node, transform, images, true, ctx, imageOutput);
    if (imageOutput.length) {
      const imageMarkup = `<g opacity="${node.opacity ?? 1}">${imageOutput.join("")}</g>`;
      if (!paths.length) return imageMarkup;
      const clipId = `mask-image-clip-${ctx.clipCounter++}`;
      ctx.defs.push(`<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse">${paths.join("")}</clipPath>`);
      return `<g clip-path="url(#${clipId})">${imageMarkup}</g>`;
    }
  }
  if (paths.length > 0) return paths.join("");

  // Some Figma masks are a FRAME wrapping a vector shape.
  if (node.children?.length) {
    const children = (node.children as SceneNode[]).map(child => renderMaskContent(
      child,
      multiplyTransforms(transform, getLocalTransform(child)),
      blobs,
      images,
      ctx,
    ));
    if (children.length > 0) return children.join("");
  }

  // Fallback to simple rectangle
  return `<rect x="0" y="0" width="${width}" height="${height}" transform="${svgMatrix(transform)}" fill="white" opacity="${node.opacity ?? 1}" />`;
}

function needsSvgMask(node: SceneNode): boolean {
  if (node.maskType === "LUMINANCE") return true;
  if ((node.opacity ?? 1) < 1) return true;
  if ((getPaints(node as FigNode, "fills") ?? []).some(paint =>
    paint.type === "IMAGE" || (paint.opacity ?? 1) < 1 || (paint.color?.a ?? 1) < 1)) return true;
  return (node.children ?? []).some(child => needsSvgMask(child as SceneNode));
}

// ============================================================================
// Instance Content Rendering
// ============================================================================

/**
 * Convert Color to CSS rgba string
 */
function colorToCss(color: Color | undefined): string | undefined {
  if (!color) return undefined;
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = color.a ?? 1;
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

/**
 * Render content extracted from an INSTANCE's symbolOverrides.
 * This renders text and visual elements based on the override data.
 */
function renderInstanceContent(
  resolved: ResolvedInstanceContent,
  transform: TransformMatrix,
  options: ResolvedOptions,
  output: string[],
): boolean {
  const instance = resolved.instance as SceneNode;
  const width = instance.width ?? 0;
  const height = instance.height ?? 0;

  if (width === 0 || height === 0) return false;

  const pos = transformPoint(0, 0, transform);
  let rendered = false;

  // Render text content from overrides
  // We arrange text vertically within the instance bounds
  if (options.includeText && resolved.textContent.length > 0) {
    let yOffset = 0;
    const lineHeight = 20; // Default line height

    for (const textItem of resolved.textContent) {
      const fillColor = colorToCss(textItem.fillColor) ?? "#fff";
      const fontSize = textItem.fontSize ?? 14;
      const fontFamily = escapeXml(textItem.fontFamily ?? "Inter");

      const textY = pos.y + yOffset + fontSize;

      output.push(
        `<text x="${pos.x}" y="${textY}" ` +
        `font-family="${fontFamily}" font-size="${fontSize}" ` +
        `fill="${fillColor}" dominant-baseline="text-before-edge">` +
        `${escapeXml(textItem.text)}</text>`
      );

      yOffset += lineHeight;
      rendered = true;
    }
  }

  // Render rectangle elements
  if (options.includeFills) {
    for (const el of resolved.elements) {
      if (el.type === "rectangle" && el.fillColor) {
        const elSize = el.size ?? { x: width, y: 30 };
        const fillColor = colorToCss(el.fillColor);
        const strokeColor = el.strokeColor ? colorToCss(el.strokeColor) : undefined;
        const radius = el.cornerRadius ?? 0;

        const attrs: string[] = [
          `x="${pos.x}"`,
          `y="${pos.y}"`,
          `width="${elSize.x}"`,
          `height="${elSize.y}"`,
        ];

        if (fillColor) attrs.push(`fill="${fillColor}"`);
        else attrs.push(`fill="none"`);

        if (strokeColor) {
          attrs.push(`stroke="${strokeColor}"`);
          attrs.push(`stroke-width="1"`);
        }

        if (radius > 0) {
          attrs.push(`rx="${radius}"`);
          attrs.push(`ry="${radius}"`);
        }

        output.push(`<rect ${attrs.join(" ")} />`);
        rendered = true;
      }
    }
  }

  return rendered;
}

type ResolvedOptions = typeof DEFAULT_RENDER_OPTIONS;

function renderNode(
  node: FigNode,
  parentTransform: TransformMatrix,
  depth: number,
  options: ResolvedOptions,
  images: { get(hash: string): Uint8Array | undefined } | undefined,
  blobs: BlobEntry[] | undefined,
  ctx: RenderContext,
  output: string[],
): void {
  if (depth > options.maxDepth) return;
  if (node.visible === false) return;

  const sceneNode = node as SceneNode;
  const localTransform = getLocalTransform(sceneNode);
  const worldTransform = multiplyTransforms(parentTransform, localTransform);

  // Generate shadow filter if this node has effects
  const filterId = generateEffectFilters(sceneNode, ctx, options.includeShadows, worldTransform);

  // Keep a whole node subtree together for layer opacity and blend modes.
  const nodeOutput: string[] = [];
  let rendered = false;

  // Handle different node types
  if (node.type === "TEXT" && options.includeText) {
    rendered = renderText(sceneNode, worldTransform, options.rawNodeIndex, nodeOutput);
  } else if (VECTOR_TYPES.has(node.type ?? "")) {
    if (options.includeFills || options.includeStrokes || options.includeImages) {
      rendered = renderBakedGeometry(sceneNode, worldTransform, images, blobs, ctx, options.includeFills, options.includeStrokes, options.includeImages, nodeOutput);
    }
    if (!rendered && options.includeStrokes && isStrokedVector(sceneNode)) {
      rendered = renderStrokedVector(
        sceneNode,
        worldTransform,
        blobs,
        ctx,
        nodeOutput,
      );
    }
    if (!rendered && options.includeFills) {
      rendered = renderFilledVector(
        sceneNode,
        worldTransform,
        blobs,
        ctx,
        nodeOutput,
      );
    }
  } else if (node.type === "RECTANGLE") {
    if (
      options.includeFills ||
      options.includeStrokes ||
      options.includeImages
    ) {
      rendered = renderRectangle(
        sceneNode,
        worldTransform,
        images,
        options.includeImages,
        ctx,
        nodeOutput,
      );
    }
  } else if (CONTAINER_TYPES.has(node.type ?? "")) {
    if (options.includeFills || options.includeImages || options.includeStrokes) {
      const fills = getPaints(node, "fills");
      const hasFill = (fills ?? []).some(paint => paint.visible !== false &&
        (paint.type !== "IMAGE" || options.includeImages));
      const hasStroke = (getPaints(node, "strokes") ?? []).some(paint => paint.visible !== false);
      if (
        (hasFill || (options.includeStrokes && hasStroke)) &&
        sceneNode.width &&
        sceneNode.height
      ) {
        const rawNode = options.rawNodeIndex?.get(formatGUID(node.guid));
        const independentCorners = rawNode?.rectangleCornerRadiiIndependent === true
          && [
            "rectangleTopLeftCornerRadius", "rectangleTopRightCornerRadius",
            "rectangleBottomRightCornerRadius", "rectangleBottomLeftCornerRadius",
          ].some(key => Number(rawNode[key]) > 0);
        // A plain <rect> cannot preserve Figma's individually rounded corners.
        rendered = independentCorners && sceneNode.fillGeometry?.length && blobs?.length
          ? renderBakedGeometry(
            sceneNode, worldTransform, images, blobs, ctx,
            options.includeFills, options.includeStrokes, options.includeImages, nodeOutput,
          )
          : renderRectangle(
            sceneNode, worldTransform, images, options.includeImages, ctx, nodeOutput,
          );
      }
    }
  }

  // Render children with mask support
  const baseOutput = nodeOutput;

  // For INSTANCE nodes, resolve children from SYMBOL definition
  // The SYMBOL provides proper layout structure; symbolOverrides have values but no positions
  let resolvedChildren: FigNode[] | undefined = node.children as FigNode[] | undefined;
  if (
    options.resolveInstances &&
    node.type === "INSTANCE" &&
    (!node.children || node.children.length === 0) &&
    sceneNode.symbolData?.symbolID &&
    options.nodeIndex
  ) {
    const symbolId = formatGUID(sceneNode.symbolData.symbolID as GUID | null);
    const symbolNode = options.nodeIndex.get(symbolId);
    if (symbolNode?.children) {
      if (options.rawNodeIndex) {
        const resolved = resolveInstanceChildren(node, symbolNode, options.rawNodeIndex, options.nodeIndex);
        if (resolved && resolved.length > 0) {
          resolvedChildren = resolved;
        } else {
          resolvedChildren = symbolNode.children as FigNode[];
        }
      } else {
        resolvedChildren = symbolNode.children as FigNode[];
      }
    }
  }

  // If no SYMBOL children could be resolved, try rendering extracted instance content
  // This is a fallback that stacks text vertically (not ideal but better than nothing)
  let instanceContentRendered = false;
  if (
    options.resolveInstances &&
    node.type === "INSTANCE" &&
    (!resolvedChildren || resolvedChildren.length === 0) &&
    sceneNode.symbolData?.symbolID &&
    options.rawNodeIndex
  ) {
    const nodeId = formatGUID(node.guid);
    const rawNode = options.rawNodeIndex.get(nodeId);
    if (rawNode) {
      const resolved = extractInstanceContent(node, rawNode);
      if (resolved && (resolved.textContent.length > 0 || resolved.elements.length > 0)) {
        instanceContentRendered = renderInstanceContent(resolved, worldTransform, options, nodeOutput);
      }
    }
  }

  // The baked boolean path already represents the merged result. Its source
  // operands must not be painted again on top of it.
  if (node.type === "BOOLEAN_OPERATION" && rendered) resolvedChildren = [];

  if (resolvedChildren && resolvedChildren.length > 0) {
    const children = resolvedChildren;
    const instanceScale = node.type === "INSTANCE" ? sceneNode.symbolData?.uniformScaleFactor : undefined;
    const childWorldTransform = instanceScale && Number.isFinite(instanceScale) && instanceScale > 0 && instanceScale !== 1
      ? multiplyTransforms(worldTransform, { a: instanceScale, b: 0, c: 0, d: instanceScale, e: 0, f: 0 })
      : worldTransform;
    const childOutput: string[] = [];
    const targetOutput = sceneNode.clipsContent ? childOutput : baseOutput;

    let index = 0;
    while (index < children.length) {
      const child = children[index] as FigNode;
      const childScene = child as SceneNode;

      // Handle mask nodes
      if (childScene.isMask) {
        const maskId = `mask-${ctx.clipCounter++}`;
        const childTransform = multiplyTransforms(
          childWorldTransform,
          getLocalTransform(childScene),
        );

        // Opaque vector masks can use a clip path; translucent and luminance
        // masks need actual SVG masks to retain their alpha.
        const maskContent = renderMaskContent(
          childScene,
          childTransform,
          blobs,
          images,
          ctx,
        );
        const alphaMask = needsSvgMask(childScene);
        ctx.defs.push(alphaMask
          ? `<mask id="${maskId}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" style="mask-type:${childScene.maskType === "LUMINANCE" ? "luminance" : "alpha"}">${maskContent}</mask>`
          : `<clipPath id="${maskId}" clipPathUnits="userSpaceOnUse">${maskContent}</clipPath>`);

        // Collect all siblings until the next mask
        const groupOutput: string[] = [];
        index += 1;
        while (index < children.length) {
          const sibling = children[index] as FigNode;
          const siblingScene = sibling as SceneNode;
          if (siblingScene.isMask) break;
          renderNode(
            sibling,
            childWorldTransform,
            depth + 1,
            options,
            images,
            blobs,
            ctx,
            groupOutput,
          );
          index += 1;
        }

        // Wrap masked content in a group with the clip-path
        targetOutput.push(
          `<g ${alphaMask ? "mask" : "clip-path"}="url(#${maskId})">${groupOutput.join("")}</g>`,
        );
        continue;
      }

      renderNode(
        child,
        childWorldTransform,
        depth + 1,
        options,
        images,
        blobs,
        ctx,
        targetOutput,
      );
      index += 1;
    }

    // Handle clipping - wrap childOutput in clip-path if needed
    if (sceneNode.clipsContent && sceneNode.width && sceneNode.height) {
      const clipId = `clip-${ctx.clipCounter++}`;
      const clipTop = clippedTextOverflowTop(sceneNode);
      const p0 = transformPoint(0, clipTop, worldTransform);
      const p1 = transformPoint(sceneNode.width, clipTop, worldTransform);
      const p2 = transformPoint(sceneNode.width, sceneNode.height, worldTransform);
      const p3 = transformPoint(0, sceneNode.height, worldTransform);
      ctx.defs.push(
        `<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"><path d="M ${p0.x} ${p0.y} L ${p1.x} ${p1.y} L ${p2.x} ${p2.y} L ${p3.x} ${p3.y} Z" /></clipPath>`,
      );
      baseOutput.push(`<g clip-path="url(#${clipId})">${childOutput.join("")}</g>`);
    }
  }

  if (nodeOutput.length > 0) {
    const filtered = filterId ? `<g filter="url(#${filterId})">${nodeOutput.join("")}</g>` : nodeOutput.join("");
    const opacity = sceneNode.opacity !== undefined && sceneNode.opacity < 1
      ? ` opacity="${sceneNode.opacity}"` : "";
    output.push(`<g${opacity}${blendStyle(sceneNode.blendMode)}>${filtered}</g>`);
  }
}

// ============================================================================
// Bounds Calculation
// ============================================================================

function collectBounds(
  node: FigNode,
  parentTransform: TransformMatrix,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (node.visible === false) return null;

  const sceneNode = node as SceneNode;
  const localTransform = getLocalTransform(sceneNode);
  const worldTransform = multiplyTransforms(parentTransform, localTransform);

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  // Skip CANVAS/DOCUMENT bounds - they represent pages, not visual content
  // Only include actual content node bounds
  const isPageNode = node.type === "CANVAS" || node.type === "DOCUMENT";

  if (
    !isPageNode &&
    sceneNode.width !== undefined &&
    sceneNode.height !== undefined
  ) {
    const corners = [
      transformPoint(0, 0, worldTransform),
      transformPoint(sceneNode.width, 0, worldTransform),
      transformPoint(sceneNode.width, sceneNode.height, worldTransform),
      transformPoint(0, sceneNode.height, worldTransform),
    ];
    for (const p of corners) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }

  // Descendants outside a clipped frame are not visible and must not expand
  // the SVG viewBox (especially for component variants inside instances).
  if (sceneNode.clipsContent && Number.isFinite(minX)) {
    const clipTop = clippedTextOverflowTop(sceneNode);
    if (clipTop < 0 && sceneNode.width !== undefined) {
      for (const p of [transformPoint(0, clipTop, worldTransform), transformPoint(sceneNode.width, clipTop, worldTransform)]) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    return { minX, minY, maxX, maxY };
  }

  // Include children bounds
  if (node.children) {
    for (const child of node.children as FigNode[]) {
      const childBounds = collectBounds(child, worldTransform);
      if (childBounds) {
        minX = Math.min(minX, childBounds.minX);
        minY = Math.min(minY, childBounds.minY);
        maxX = Math.max(maxX, childBounds.maxX);
        maxY = Math.max(maxY, childBounds.maxY);
      }
    }
  }

  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/** The same origin used by the SVG viewBox and canvas hit targets. */
export function getRenderBounds(node: FigNode) {
  return collectBounds(node, IDENTITY_TRANSFORM);
}

// ============================================================================
// Main Export
// ============================================================================

function collectOwnBounds(node: FigNode) {
  return collectBounds({ ...node, children: [] } as FigNode, IDENTITY_TRANSFORM);
}

/**
 * Render a node subtree to SVG.
 *
 * @param node - The root node to render
 * @param images - Optional map of image hash -> image data for embedding
 * @param blobs - Optional array of blob data for vector paths
 * @param options - Rendering options
 * @returns The rendered SVG and metadata
 */
export function renderScreen(
  node: FigNode,
  images?: { get(hash: string): Uint8Array | undefined },
  blobs?: BlobEntry[],
  options: RenderScreenOptions = {},
): RenderScreenResult {
  const resolved = { ...DEFAULT_RENDER_OPTIONS, ...options };
  const ctx: RenderContext = {
    defs: [], clipCounter: 0, shadowCounter: 0, warnings: [],
    imageHashes: new Set(), usedTrueGeometry: false,
    imageResolver: resolved.imageResolver,
  };

  // Calculate bounds
  const bounds = resolved.viewport === "node" && (node as SceneNode).width && (node as SceneNode).height
    ? collectOwnBounds(node)
    : getRenderBounds(node);

  if (!bounds) {
    ctx.warnings.push("No bounds found for node subtree");
    return { svg: "", width: 0, height: 0, warnings: ctx.warnings, imageHashes: [], usedTrueGeometry: false };
  }

  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);

  // Offset transform to bring content to origin
  const offsetTransform: TransformMatrix = {
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    e: -bounds.minX,
    f: -bounds.minY,
  };

  // Render
  const output: string[] = [];
  if (resolved.background) {
    output.push(
      `<rect width="100%" height="100%" fill="${resolved.background}" />`,
    );
  } else if (resolved.includeCanvasBackground && node.type === "CANVAS") {
    const canvas = node as CanvasNode;
    if (canvas.backgroundEnabled !== false && canvas.backgroundColor) {
      const opacity = Math.max(0, Math.min(1, canvas.backgroundOpacity ?? 1));
      output.push(`<rect width="100%" height="100%" fill="${colorToRgba({ ...canvas.backgroundColor, a: (canvas.backgroundColor.a ?? 1) * opacity })}" />`);
    }
  }

  renderNode(node, offsetTransform, 0, resolved, images, blobs, ctx, output);

  // Build SVG
  const defs = ctx.defs.length > 0 ? `<defs>${ctx.defs.join("")}</defs>` : "";
  const scaledWidth = width * resolved.scale;
  const scaledHeight = height * resolved.scale;

  const svg =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${scaledWidth}" height="${scaledHeight}" viewBox="0 0 ${width} ${height}">` +
    `${defs}${output.join("")}</svg>`;

  return { svg, width, height, warnings: ctx.warnings, imageHashes: [...ctx.imageHashes], usedTrueGeometry: ctx.usedTrueGeometry };
}
