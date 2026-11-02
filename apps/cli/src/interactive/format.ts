import type { ThemeReport } from '@figma-reader/fig-engine';
import type { Workspace } from '@figma-reader/server/workspace';
import type { ImplementationContext } from '../references.js';

let colorEnabled = false;
/** Colors only when writing to a terminal and NO_COLOR is unset. */
export function useColor(enabled: boolean) { colorEnabled = enabled && !process.env.NO_COLOR; }

export const colorOn = () => colorEnabled;
/** 24-bit foreground color from #RRGGBB. */
export const rgb = (value: string) => (text: string) => colorEnabled
  ? `\x1b[38;2;${[1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16)).join(';')}m${text}\x1b[39m` : text;
const ansi = (open: number, close: number) => (text: string) => colorEnabled ? `\x1b[${open}m${text}\x1b[${close}m` : text;
export const style = {
  bold: ansi(1, 22), dim: ansi(2, 22), italic: ansi(3, 23),
  red: ansi(31, 39), green: ansi(32, 39), yellow: ansi(33, 39), blue: ansi(34, 39),
  magenta: ansi(35, 39), cyan: ansi(36, 39), gray: ansi(90, 39),
};

type Rgba = { r: number; g: number; b: number; a?: number };
const channel = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 255);
export const hex = (color: Rgba) => `#${[color.r, color.g, color.b].map(value => channel(value).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

/** A block in the color itself (24-bit terminals), or nothing without color. */
export function swatch(value: Rgba | string) {
  if (!colorEnabled) return '';
  const [r, g, b] = typeof value === 'string'
    ? [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16))
    : [value.r, value.g, value.b].map(channel);
  return `\x1b[38;2;${r};${g};${b}m■\x1b[39m `;
}

const TYPE_STYLE: Record<string, (text: string) => string> = {
  CANVAS: style.bold, FRAME: style.cyan, SECTION: style.cyan, GROUP: style.blue, TEXT: style.yellow,
  COMPONENT: style.magenta, COMPONENT_SET: style.magenta, INSTANCE: style.magenta,
};
export const typeLabel = (type: string, width = 0) => (TYPE_STYLE[type] ?? style.gray)(type.padEnd(width));

export const truncate = (text: string, length: number) => text.length > length ? `${text.slice(0, length - 1)}…` : text;
const round = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
export const size = (width?: number | null, height?: number | null) => width == null || height == null ? '' : `${round(width)}×${round(height)}`;
const row = (label: string, value: string) => `  ${style.gray(label.padEnd(12))}${value}`;
const percent = (value: number) => `${Math.round(value * 100)} %`;

type Paint = { type: string; visible?: boolean; opacity?: number; color?: Rgba | null; imageHash?: string | null; gradientStops?: unknown[] };
export function paint(item: Paint) {
  const hidden = item.visible === false ? style.dim(' (hidden)') : '';
  const opacity = item.opacity !== undefined && item.opacity < 1 ? style.gray(` ${percent(item.opacity)}`) : '';
  if (item.type === 'SOLID' && item.color) return `${swatch(item.color)}${hex(item.color)}${item.color.a !== undefined && item.color.a < 1 ? style.gray(` α${round(item.color.a)}`) : ''}${opacity}${hidden}`;
  if (item.type === 'IMAGE') return `image${item.imageHash ? ` ${style.gray(item.imageHash.slice(0, 10))}` : ''}${opacity}${hidden}`;
  if (item.type.startsWith('GRADIENT')) return `${item.type.replace('GRADIENT_', '').toLowerCase()} gradient${opacity}${hidden}`;
  return `${item.type.toLowerCase()}${hidden}`;
}
const paints = (items: Paint[]) => items.length ? items.map(paint).join(style.gray(' · ')) : style.gray('—');

/** Layout fields read from the .fig, with the `stack` prefix dropped for reading. */
function fields(values: Record<string, unknown>) {
  return Object.entries(values)
    .map(([key, value]) => `${key.replace(/^stack/, '').replace(/^./, letter => letter.toLowerCase())}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join(' ');
}

export function pathLine(path: Array<{ name: string }>) {
  return path.length ? path.map(item => item.name).join(style.gray(' › ')) : style.gray('(document)');
}

export function nodeInfo(node: ReturnType<Workspace['node']>, path: Array<{ name: string }>) {
  const lines = [`${typeLabel(node.type)}  ${style.bold(node.name)}  ${style.gray(node.id)}${node.visible ? '' : style.dim('  hidden')}`, row('path', pathLine(path))];
  if (node.width != null) lines.push(row('box', `${size(node.width, node.height)}${node.x != null ? style.gray(`  at (${round(node.x)}, ${round(node.y ?? 0)})`) : ''}`));
  if (node.text != null) lines.push(row('text', `"${truncate(node.text.replace(/\s+/g, ' '), 90)}"`));
  if (node.typography) {
    const type = node.typography;
    lines.push(row('font', `${type.declaredFamily ?? type.family ?? '?'} ${type.weight ?? ''} · ${type.size ?? '?'} px`
      + `${type.lineHeight ? ` / ${round(type.lineHeight)} px` : ''}${type.letterSpacing ? style.gray(` · tracking ${round(type.letterSpacing)}`) : ''}`
      + `${type.substituted ? style.gray(`  (preview uses ${type.renderedFamily})`) : ''}`));
  }
  if (node.type !== 'CANVAS' && node.type !== 'DOCUMENT') {
    lines.push(row('fills', paints(node.fills as Paint[])));
    if ((node.strokes as Paint[]).length) lines.push(row('strokes', paints(node.strokes as Paint[])));
  }
  if (node.opacity !== 1) lines.push(row('opacity', percent(node.opacity)));
  if (node.layout && typeof node.layout === 'object' && (node.layout as { mode?: string }).mode !== 'NONE') lines.push(row('layout', fields(node.layout as Record<string, unknown>)));
  lines.push(row('children', String(node.childCount)));
  return lines.join('\n');
}

// implementationContext describes nodes as Record<string, unknown>; this is the shape it builds.
type ContextNode = {
  id: string; name: string; type: string; childCount: number;
  layout?: { autoLayout: { format: string; fields: Record<string, unknown> } | null; constraints: { fields: Record<string, unknown> } | null };
  component?: { role: string; definitionName: string | null; definitionId: string; instanceCount: number; overrideCount: number; variantProperties: Array<{ value: unknown }> } | null;
  visualStyle?: { opacity: number; cornerRadius: number | null; strokeWeight: number | null; fills: Paint[]; strokes: Paint[]; effects: unknown[] };
  text?: { value: string }; typography?: { declaredFamily: string | null; size: number | null; weight: number | null };
  bounds?: { width: number | null; height: number | null };
  children?: ContextNode[];
};

function contextLine(node: ContextNode) {
  const parts: string[] = [];
  if (node.layout?.autoLayout) parts.push(`auto layout ${node.layout.autoLayout.fields.stackMode ?? (node.layout.autoLayout.fields as { mode?: string }).mode ?? ''}`.trim());
  if (node.component) parts.push(node.component.role === 'instance' ? `instance of "${node.component.definitionName ?? node.component.definitionId}"` : 'component');
  if (node.text) parts.push(`"${truncate(node.text.value.replace(/\s+/g, ' '), 40)}"`);
  return parts.join(style.gray(' · '));
}

export function contextSummary(context: ImplementationContext) {
  const node = context.node as unknown as ContextNode;
  const lines = [`${typeLabel(node.type)}  ${style.bold(node.name)}  ${style.gray(node.id)}  ${size(node.bounds?.width, node.bounds?.height)}`];
  const autoLayout = node.layout?.autoLayout;
  lines.push(row('auto layout', autoLayout ? fields(autoLayout.fields) : style.gray('none declared')));
  if (node.layout?.constraints) lines.push(row('constraints', fields(node.layout.constraints.fields)));
  if (node.component) {
    const component = node.component;
    lines.push(row('component', component.role === 'instance'
      ? `instance of "${component.definitionName ?? component.definitionId}" ${style.gray(`(${component.instanceCount} uses, ${component.overrideCount} overrides)`)}`
      : `definition ${style.gray(`(${component.instanceCount} instances)`)}`));
    if (component.variantProperties.length) lines.push(row('variants', component.variantProperties.map(item => String(item.value)).join(', ')));
  }
  const visual = node.visualStyle;
  if (visual) {
    const extras = [visual.cornerRadius ? `radius ${round(visual.cornerRadius)}` : '', visual.strokeWeight ? `stroke ${round(visual.strokeWeight)}` : '',
      visual.effects.length ? `${visual.effects.length} effect${visual.effects.length > 1 ? 's' : ''}` : ''].filter(Boolean);
    lines.push(row('fills', paints(visual.fills)));
    if (extras.length) lines.push(row('style', extras.join(style.gray(' · '))));
  }
  if (node.typography) lines.push(row('font', `${node.typography.declaredFamily ?? '?'} ${node.typography.weight ?? ''} · ${node.typography.size ?? '?'} px`));
  if (node.text) lines.push(row('text', `"${truncate(node.text.value.replace(/\s+/g, ' '), 90)}"`));
  const children = node.children ?? [];
  if (children.length) {
    lines.push(row('children', `${node.childCount}${context.hierarchy.truncated ? style.gray(' (truncated)') : ''}`));
    for (const child of children.slice(0, 40)) {
      lines.push(`    ${typeLabel(child.type, 9)} ${truncate(child.name, 32).padEnd(32)} ${style.gray(size(child.bounds?.width, child.bounds?.height).padEnd(11))} ${contextLine(child)}`);
    }
  }
  const images = context.assets.images;
  if (images.length) lines.push(row('images', `${context.assets.total} ${style.gray(`(${images.slice(0, 3).map(image => image.hash.slice(0, 10)).join(', ')}${images.length > 3 ? ', …' : ''})`)}`));
  lines.push('', style.gray('  json on  shows the full context with provenance (fig vs inferred)'));
  return lines.join('\n');
}

export function themeSummary(theme: ThemeReport, section: string, limit = section === 'all' ? 8 : 20) {
  const show = (name: string) => section === 'all' || section === name;
  const lines: string[] = [];
  const more = (total: number, name: string) => total > limit ? style.gray(`    … ${total - limit} more (theme ${name} ${total})`) : '';
  const heading = (title: string, total: number) => lines.push('', `  ${style.bold(title)} ${style.gray(`(${total})`)}`);
  if (show('colors')) {
    heading('Colors', theme.colors.length);
    for (const color of theme.colors.slice(0, limit)) {
      const uses = [color.fills && `${color.fills} fill`, color.text && `${color.text} text`, color.strokes && `${color.strokes} stroke`, color.backgrounds && `${color.backgrounds} bg`].filter(Boolean).join(', ');
      lines.push(`    ${swatch(color.hex)}${color.css.padEnd(24)} ${String(color.count).padStart(5)}×  ${style.gray(uses)}`);
    }
    lines.push(more(theme.colors.length, 'colors'));
  }
  if (show('typography')) {
    heading('Fonts', theme.typography.fonts.length);
    for (const font of theme.typography.fonts.slice(0, limit)) {
      const sizes = font.sizes.slice(0, 6).map(item => item.px).join(', ');
      lines.push(`    ${font.declaredFamily.padEnd(24)} ${String(font.count).padStart(5)}×  ${style.gray(`${sizes} px · weights ${font.weights.map(item => item.value).join(', ')}`)}`
        + `${font.substituted ? style.gray(`  (preview: ${font.renderedFamily})`) : ''}`);
    }
    lines.push(more(theme.typography.fonts.length, 'typography'));
    heading('Text styles', theme.typography.styles.length);
    for (const text of theme.typography.styles.slice(0, limit)) {
      lines.push(`    ${`${text.family} ${text.weight} · ${text.size}${text.lineHeight ? `/${round(text.lineHeight)}` : ''} px`.padEnd(40)} ${String(text.count).padStart(5)}×`);
    }
    lines.push(more(theme.typography.styles.length, 'typography'));
  }
  if (show('radii')) {
    heading('Radii', theme.radii.length);
    for (const radius of theme.radii.slice(0, limit)) lines.push(`    ${radius.css.padEnd(24)} ${String(radius.count).padStart(5)}×`);
    lines.push(more(theme.radii.length, 'radii'));
  }
  if (show('borders')) {
    heading('Borders', theme.borders.length);
    for (const border of theme.borders.slice(0, limit)) lines.push(`    ${swatch(border.color)}${`${round(border.width)} px ${border.color}`.padEnd(24)} ${String(border.count).padStart(5)}×  ${style.gray(border.align.toLowerCase())}`);
    lines.push(more(theme.borders.length, 'borders'));
  }
  if (show('shadows')) {
    heading('Shadows', theme.shadows.length);
    for (const shadow of theme.shadows.slice(0, limit)) lines.push(`    ${truncate(shadow.css, 48).padEnd(48)} ${String(shadow.count).padStart(5)}×`);
    lines.push(more(theme.shadows.length, 'shadows'));
  }
  if (show('spacing')) {
    heading('Spacing', theme.spacing.length);
    lines.push(`    ${theme.spacing.slice(0, limit * 2).map(space => `${round(space.px)}${style.gray(space.source === 'auto-layout' ? '' : '*')}`).join('  ')}`);
    lines.push(style.gray('    * measured from geometry; the rest are declared auto layout gaps and padding'));
  }
  if (section === 'css') lines.push(theme.cssVariables);
  else lines.push('', style.gray('  Inferred from observed values, not declared Figma variables. theme css prints CSS variables.'));
  return lines.filter(line => line !== '').length ? lines.join('\n').replace(/\n{3,}/g, '\n\n') : style.gray('Nothing found');
}
