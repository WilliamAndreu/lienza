import type { Color, Paint, SceneNode, Transform } from "../parser/types.js";
import type { RenderContext, TransformMatrix } from "./render-types.js";
import { IDENTITY_TRANSFORM } from "./render-types.js";
import { multiplyTransforms } from "./render-utils.js";
import { paintToColor } from "./paint-utils.js";

function matrix(value: Transform | undefined): TransformMatrix {
  return value ? {
    a: value.m00, b: value.m10, c: value.m01,
    d: value.m11, e: value.m02, f: value.m12,
  } : IDENTITY_TRANSFORM;
}

function inverse(value: TransformMatrix): TransformMatrix | undefined {
  const determinant = value.a * value.d - value.b * value.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return undefined;
  return {
    a: value.d / determinant, b: -value.b / determinant,
    c: -value.c / determinant, d: value.a / determinant,
    e: (value.c * value.f - value.d * value.e) / determinant,
    f: (value.b * value.e - value.a * value.f) / determinant,
  };
}

export function svgMatrix(value: TransformMatrix): string {
  return `matrix(${value.a} ${value.b} ${value.c} ${value.d} ${value.e} ${value.f})`;
}

function opacity(value: number | undefined): number {
  return Math.max(0, Math.min(1, value ?? 1));
}

function stopColor(color: Color): string {
  return `rgb(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)})`;
}

/** Figma paint transforms map layer space into normalized paint space. */
export function paintToSvgFill(
  paint: Paint,
  node: SceneNode,
  world: TransformMatrix,
  ctx: RenderContext,
): string | undefined {
  if (paint.visible === false) return undefined;
  if (paint.type === "SOLID") return paintToColor(paint);
  if (!paint.type.startsWith("GRADIENT_")) return undefined;
  const stops = paint.stops ?? paint.gradientStops ?? [];
  if (!stops.length) return undefined;

  const id = `gradient-${ctx.defs.length}`;
  const width = node.width ?? 1;
  const height = node.height ?? 1;
  const localSize: TransformMatrix = { a: width, b: 0, c: 0, d: height, e: 0, f: 0 };
  const source = matrix(paint.transform ?? paint.gradientTransform);
  const paintToLayer = inverse(source);
  if (!paintToLayer) ctx.warnings.push(`Gradient with singular matrix: ${node.name}`);
  const gradientMatrix = multiplyTransforms(world, multiplyTransforms(localSize, paintToLayer ?? IDENTITY_TRANSFORM));
  const stopMarkup = stops.map(stop => {
    const alpha = opacity(stop.color.a) * opacity(paint.opacity);
    return `<stop offset="${stop.position * 100}%" stop-color="${stopColor(stop.color)}" stop-opacity="${alpha}" />`;
  }).join("");

  if (paint.type === "GRADIENT_LINEAR") {
    ctx.defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" gradientTransform="${svgMatrix(gradientMatrix)}" x1="0" y1="0" x2="1" y2="0">${stopMarkup}</linearGradient>`);
  } else {
    if (paint.type === "GRADIENT_ANGULAR" || paint.type === "GRADIENT_DIAMOND") {
      ctx.warnings.push(`Gradient ${paint.type} approximated as radial: ${node.name}`);
    }
    ctx.defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" gradientTransform="${svgMatrix(gradientMatrix)}" cx="0" cy="0" r="1">${stopMarkup}</radialGradient>`);
  }
  return `url(#${id})`;
}

/** Figma maps layer coordinates into image coordinates; SVG places the image in layer space. */
export function imagePaintTransform(paint: Paint, node: SceneNode, world: TransformMatrix): TransformMatrix {
  const raw = paint.transform;
  if (!raw) return world;
  const width = Math.max(node.width ?? 1, 1);
  const height = Math.max(node.height ?? 1, 1);
  const imageToLayer = inverse(matrix(raw));
  if (!imageToLayer) return world;
  const size: TransformMatrix = { a: width, b: 0, c: 0, d: height, e: 0, f: 0 };
  const inverseSize: TransformMatrix = { a: 1 / width, b: 0, c: 0, d: 1 / height, e: 0, f: 0 };
  return multiplyTransforms(world, multiplyTransforms(size, multiplyTransforms(imageToLayer, inverseSize)));
}

const BLEND_MODES: Record<string, string> = {
  MULTIPLY: "multiply", SCREEN: "screen", OVERLAY: "overlay",
  DARKEN: "darken", LIGHTEN: "lighten", COLOR_BURN: "color-burn",
  COLOR_DODGE: "color-dodge", HARD_LIGHT: "hard-light",
  SOFT_LIGHT: "soft-light", DIFFERENCE: "difference",
  EXCLUSION: "exclusion", HUE: "hue", SATURATION: "saturation",
  COLOR: "color", LUMINOSITY: "luminosity",
};

export function blendStyle(mode: string | undefined): string {
  const css = mode && BLEND_MODES[mode];
  return css ? ` style="mix-blend-mode:${css}"` : "";
}
