import type { LoadedFig } from '../index.js';
import type { Color, Effect, FigNode, Paint, SceneNode } from '../parser/types.js';
import { formatGUID } from '../parser/kiwi-parser.js';
import { resolveFontFamily } from '../font-catalog.js';

export interface ThemeExample { id: string; name: string; page: string }
export interface ThemeToken { count: number; examples: ThemeExample[] }
export interface ThemeColor extends ThemeToken {
  hex: string; alpha: number; css: string;
  fills: number; strokes: number; text: number; backgrounds: number;
}
export interface ThemeFont extends ThemeToken {
  family: string; declaredFamily: string; renderedFamily: string; substituted: boolean;
  sizes: Array<{ px: number; count: number }>;
  weights: Array<{ value: number; count: number }>;
}
export interface ThemeTextStyle extends ThemeToken {
  family: string; size: number; weight: number;
  lineHeight: number | null; letterSpacing: number;
}
export interface ThemeRadius extends ThemeToken { css: string; values: [number, number, number, number] }
export interface ThemeBorder extends ThemeToken { width: number; color: string; alpha: number; align: string }
export interface ThemeShadow extends ThemeToken { type: string; css: string; color: string; alpha: number; x: number; y: number; blur: number; spread: number }
export interface ThemeSpacing extends ThemeToken { px: number; source: 'auto-layout' | 'geometry' }

export interface ThemeReport {
  source: { file: string; analyzedNodes: number; pages: number; method: 'inferred-from-fig' };
  colors: ThemeColor[];
  typography: { fonts: ThemeFont[]; styles: ThemeTextStyle[] };
  radii: ThemeRadius[];
  borders: ThemeBorder[];
  shadows: ThemeShadow[];
  spacing: ThemeSpacing[];
  cssVariables: string;
  notes: string[];
}

const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const channel = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 255);
const hexByte = (value: number) => channel(value).toString(16).padStart(2, '0').toUpperCase();
const colorHex = (color: Color) => `#${hexByte(color.r)}${hexByte(color.g)}${hexByte(color.b)}`;
const colorAlpha = (color: Color, opacity = 1) => round(Math.max(0, Math.min(1, (color.a ?? 1) * opacity)), 3);
const colorCss = (hex: string, alpha: number) => alpha === 1 ? hex : `rgb(${parseInt(hex.slice(1, 3), 16)} ${parseInt(hex.slice(3, 5), 16)} ${parseInt(hex.slice(5, 7), 16)} / ${alpha})`;

function addExample(entry: ThemeToken, node: FigNode, page: string) {
  entry.count++;
  if (entry.examples.length < 3) entry.examples.push({ id: formatGUID(node.guid), name: node.name || node.type, page });
}

function add<T extends ThemeToken>(map: Map<string, T>, key: string, values: Omit<T, 'count' | 'examples'>, node: FigNode, page: string): T {
  let entry = map.get(key);
  if (!entry) { entry = { ...values, count: 0, examples: [] } as unknown as T; map.set(key, entry); }
  addExample(entry, node, page);
  return entry;
}

function ordered<T extends ThemeToken>(map: Map<string, T>) {
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function spacingFromChildren(parent: FigNode, page: string, map: Map<string, ThemeSpacing>) {
  const children = (parent.children ?? []).filter(child => child.visible !== false) as SceneNode[];
  if (children.length < 2 || children.length > 40) return;
  const boxes = children.filter(node => finite(node.x) && finite(node.y) && finite(node.width) && finite(node.height)
    && node.width! > 2 && node.height! > 2 && !node.rotation && node.type !== 'TEXT');
  if (boxes.length < 2) return;
  for (const a of boxes) {
    let horizontal = Infinity;
    let vertical = Infinity;
    for (const b of boxes) {
      if (a === b) continue;
      const overlapY = Math.min(a.y! + a.height!, b.y! + b.height!) - Math.max(a.y!, b.y!);
      const overlapX = Math.min(a.x! + a.width!, b.x! + b.width!) - Math.max(a.x!, b.x!);
      const dx = b.x! - (a.x! + a.width!);
      const dy = b.y! - (a.y! + a.height!);
      if (dx > 0 && dx <= 96 && overlapY >= Math.min(a.height!, b.height!) * .5) horizontal = Math.min(horizontal, dx);
      if (dy > 0 && dy <= 96 && overlapX >= Math.min(a.width!, b.width!) * .5) vertical = Math.min(vertical, dy);
    }
    for (const gap of [horizontal, vertical]) {
      if (!Number.isFinite(gap)) continue;
      const px = round(gap);
      add(map, `geometry:${px}`, { px, source: 'geometry' as const }, parent, page);
    }
  }
}

/** Extract observed design values. These are inferred tokens, not declared Figma variables. */
export function analyzeTheme(file: LoadedFig): ThemeReport {
  const colors = new Map<string, ThemeColor>();
  const fonts = new Map<string, ThemeFont>();
  const styles = new Map<string, ThemeTextStyle>();
  const radii = new Map<string, ThemeRadius>();
  const borders = new Map<string, ThemeBorder>();
  const shadows = new Map<string, ThemeShadow>();
  const spacing = new Map<string, ThemeSpacing>();
  let analyzedNodes = 0;
  let hasAutoLayout = false;

  function recordColor(color: Color, opacity: number, role: 'fills' | 'strokes' | 'text' | 'backgrounds', node: FigNode, page: string) {
    const hex = colorHex(color);
    const alpha = colorAlpha(color, opacity);
    if (alpha === 0) return;
    const key = `${hex}:${alpha}`;
    const entry = add(colors, key, { hex, alpha, css: colorCss(hex, alpha), fills: 0, strokes: 0, text: 0, backgrounds: 0 }, node, page);
    entry[role]++;
  }

  function paintColors(paints: Paint[] | undefined, role: 'fills' | 'strokes' | 'text', node: FigNode, page: string) {
    for (const paint of paints ?? []) {
      if (paint.visible === false) continue;
      if (paint.type === 'SOLID' && paint.color) recordColor(paint.color, paint.opacity ?? 1, role, node, page);
      for (const stop of paint.gradientStops ?? paint.stops ?? []) recordColor(stop.color, (paint.opacity ?? 1), role, node, page);
    }
  }

  function recordShadow(effect: Effect, node: FigNode, page: string) {
    if (effect.visible === false || !effect.color || !['DROP_SHADOW', 'INNER_SHADOW'].includes(effect.type)) return;
    const color = colorHex(effect.color);
    const alpha = colorAlpha(effect.color);
    const x = round(effect.offset?.x ?? 0), y = round(effect.offset?.y ?? 0);
    const blur = round(effect.radius), spread = round(effect.spread ?? 0);
    const css = `${effect.type === 'INNER_SHADOW' ? 'inset ' : ''}${x}px ${y}px ${blur}px ${spread}px ${colorCss(color, alpha)}`;
    add(shadows, `${effect.type}:${css}`, { type: effect.type, css, color, alpha, x, y, blur, spread }, node, page);
  }

  function walk(node: FigNode, page: string) {
    if (node.visible === false) return;
    if (node.type === 'CANVAS') {
      page = node.name;
      const background = (node as FigNode & { backgroundColor?: Color }).backgroundColor;
      if (background) recordColor(background, 1, 'backgrounds', node, page);
    }
    if (node.type !== 'DOCUMENT' && node.type !== 'CANVAS') {
      analyzedNodes++;
      const scene = node as SceneNode;
      paintColors(scene.fills, node.type === 'TEXT' ? 'text' : 'fills', node, page);
      paintColors(scene.strokes, 'strokes', node, page);

      if (node.type === 'TEXT' && scene.style && scene.style.fontFamilyDeclared !== false
        && scene.style.fontFamily && finite(scene.style.fontSize) && scene.style.fontSize > 0) {
        const style = scene.style;
        const family = style.fontFamily;
        const size = round(style.fontSize);
        const weight = finite(style.fontWeight) ? style.fontWeight : 400;
        const lineHeight = finite(style.lineHeightPx) ? round(style.lineHeightPx) : null;
        const letterSpacing = finite(style.letterSpacing) ? round(style.letterSpacing) : 0;
        const renderedFamily = resolveFontFamily(family);
        const font = add(fonts, family, { family, declaredFamily: family, renderedFamily, substituted: renderedFamily !== family, sizes: [], weights: [] }, node, page);
        const sizeEntry = font.sizes.find(value => value.px === size);
        if (sizeEntry) sizeEntry.count++; else font.sizes.push({ px: size, count: 1 });
        const weightEntry = font.weights.find(value => value.value === weight);
        if (weightEntry) weightEntry.count++; else font.weights.push({ value: weight, count: 1 });
        add(styles, `${family}:${size}:${weight}:${lineHeight}:${letterSpacing}`, { family, size, weight, lineHeight, letterSpacing }, node, page);
      }

      if (scene.cornerRadius !== undefined) {
        const radius = scene.cornerRadius;
        const values: [number, number, number, number] = typeof radius === 'number'
          ? [radius, radius, radius, radius]
          : [radius.topLeft, radius.topRight, radius.bottomRight, radius.bottomLeft];
        if (values.every(value => finite(value) && value >= 0)) {
          const rounded = values.map(value => round(value)) as [number, number, number, number];
          const css = rounded.every(value => value === rounded[0]) ? `${rounded[0]}px` : rounded.map(value => `${value}px`).join(' ');
          add(radii, css, { css, values: rounded }, node, page);
        }
      }

      const width = scene.strokeWeight;
      if (finite(width) && width > 0) {
        for (const paint of scene.strokes ?? []) {
          if (paint.visible === false || paint.type !== 'SOLID' || !paint.color) continue;
          const color = colorHex(paint.color), alpha = colorAlpha(paint.color, paint.opacity ?? 1);
          const align = scene.strokeAlign ?? 'CENTER';
          add(borders, `${round(width)}:${color}:${alpha}:${align}`, { width: round(width), color, alpha, align }, node, page);
        }
      }
      for (const effect of scene.effects ?? []) recordShadow(effect, node, page);

      const raw = file.rawNodeIndex.get(formatGUID(node.guid));
      if (raw?.stackMode === 'HORIZONTAL' || raw?.stackMode === 'VERTICAL') {
        hasAutoLayout = true;
        for (const value of [raw.stackSpacing, raw.stackHorizontalPadding, raw.stackVerticalPadding, raw.stackPaddingRight, raw.stackPaddingBottom]) {
          if (finite(value) && value > 0 && value <= 128) {
            const px = round(value);
            add(spacing, `auto-layout:${px}`, { px, source: 'auto-layout' as const }, node, page);
          }
        }
      } else if (scene.layoutMode?.mode && scene.layoutMode.mode !== 'NONE') {
        hasAutoLayout = true;
        const layout = scene.layoutMode;
        for (const value of [layout.itemSpacing, layout.paddingTop, layout.paddingRight, layout.paddingBottom, layout.paddingLeft]) {
          if (finite(value) && value > 0 && value <= 128) {
            const px = round(value);
            add(spacing, `auto-layout:${px}`, { px, source: 'auto-layout' as const }, node, page);
          }
        }
      } else spacingFromChildren(node, page, spacing);
    }
    for (const child of node.children ?? []) walk(child, page);
  }

  walk(file.document, '');
  const orderedColors = ordered(colors);
  const orderedFonts = ordered(fonts).map(font => ({ ...font,
    sizes: font.sizes.sort((a, b) => b.count - a.count),
    weights: font.weights.sort((a, b) => b.count - a.count),
  }));
  const orderedStyles = ordered(styles);
  const orderedRadii = ordered(radii);
  const orderedBorders = ordered(borders);
  const orderedShadows = ordered(shadows);
  const orderedSpacing = ordered(spacing);
  const variables = [':root {'];
  orderedColors.slice(0, 24).forEach((token, index) => variables.push(`  --fig-color-${String(index + 1).padStart(2, '0')}: ${token.css};`));
  orderedFonts.slice(0, 6).forEach((token, index) => variables.push(`  --fig-font-${String(index + 1).padStart(2, '0')}: '${token.family.replaceAll("'", "\\'")}'${token.substituted ? `, '${token.renderedFamily.replaceAll("'", "\\'")}'` : ''}, sans-serif;`));
  orderedStyles.slice(0, 12).forEach((token, index) => {
    const rendered = resolveFontFamily(token.family);
    const fallback = rendered !== token.family ? `, '${rendered.replaceAll("'", "\\'")}'` : '';
    variables.push(`  --fig-type-${String(index + 1).padStart(2, '0')}: ${token.weight} ${token.size}px/${token.lineHeight ? `${token.lineHeight}px` : 'normal'} '${token.family.replaceAll("'", "\\'")}'${fallback}, sans-serif;`);
  });
  orderedRadii.slice(0, 10).forEach((token, index) => variables.push(`  --fig-radius-${String(index + 1).padStart(2, '0')}: ${token.css};`));
  orderedBorders.slice(0, 8).forEach((token, index) => variables.push(`  --fig-border-${String(index + 1).padStart(2, '0')}: ${token.width}px solid ${colorCss(token.color, token.alpha)};`));
  orderedShadows.slice(0, 6).forEach((token, index) => variables.push(`  --fig-shadow-${String(index + 1).padStart(2, '0')}: ${token.css};`));
  orderedSpacing.slice(0, 10).forEach((token, index) => variables.push(`  --fig-space-${String(index + 1).padStart(2, '0')}: ${token.px}px;`));
  variables.push('}');
  return {
    source: { file: file.name, analyzedNodes, pages: file.document.children?.length ?? 0, method: 'inferred-from-fig' },
    colors: orderedColors,
    typography: { fonts: orderedFonts, styles: orderedStyles },
    radii: orderedRadii,
    borders: orderedBorders,
    shadows: orderedShadows,
    spacing: orderedSpacing,
    cssVariables: variables.join('\n'),
    notes: [
      'Values observed in visible layers are not declared Figma variables.',
      hasAutoLayout ? 'Spacing combines declared Auto Layout values and geometry between sibling layers.' : 'Spacing is inferred from geometry between sibling layers; validate it before using it as tokens.',
      'Colors inside raster images are not included.',
      'In typography.fonts, declaredFamily is the family specified by the .fig; renderedFamily identifies only the configured preview substitute. Use declaredFamily when implementing the design.',
    ],
  };
}
