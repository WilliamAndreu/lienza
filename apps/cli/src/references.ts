import type { ThemeReport } from '@figma-reader/fig-engine';
import type { Workspace } from '@figma-reader/server/workspace';

export type ImplementationContext = ReturnType<Workspace['implementationContext']>;

/** Replaces the server's `/api/...` URLs, which do not exist without HTTP, with CLI commands or exported files. */
export function rewriteReferences(context: ImplementationContext, references: {
  render: (nodeId: string, extension: 'svg' | 'png') => Record<string, string | null>;
  asset: (hash: string) => Record<string, string | null>;
}) {
  const visual: Record<string, unknown> = { ...context.visualReferences };
  delete visual.svgUrl;
  delete visual.pngUrl;
  delete visual.renderTool;
  const nodeId = context.file.nodeId;
  return {
    ...context,
    assets: { ...context.assets, images: context.assets.images.map(image => {
      const asset: Record<string, unknown> = { ...image };
      delete asset.url;
      delete asset.assetTool;
      return { ...asset, ...references.asset(image.hash) };
    }) },
    visualReferences: { ...visual, ...references.render(nodeId, 'svg'), ...references.render(nodeId, 'png') },
  };
}

const quote = (value: string) => /^[\w./:@-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
export const safeFileName = (id: string) => id.replace(/[^\w.-]/g, '-');

export function commandReferences(context: ImplementationContext, figPath: string) {
  const fig = quote(figPath);
  return rewriteReferences(context, {
    render: (nodeId, extension) => ({ [`${extension}Command`]:
      `lienza render ${fig} --id ${quote(nodeId)} --format ${extension} --out ${safeFileName(nodeId)}.${extension}` }),
    asset: hash => ({ command: `lienza asset ${fig} --hash ${hash} --out ${hash}` }),
  });
}

export function documentSummary(status: ReturnType<Workspace['status']>) {
  const { name, parser, version, nodeCount, imageCount, pages, suggestedNodeId } = status;
  return { name, parser, version, nodeCount, imageCount, suggestedNodeId, pages };
}

export const THEME_SECTIONS = ['all', 'colors', 'typography', 'radii', 'borders', 'shadows', 'spacing', 'css'] as const;

export function themeSection(theme: ThemeReport, section: string) {
  if (section === 'all') return theme;
  if (section === 'css') return { source: theme.source, cssVariables: theme.cssVariables, notes: theme.notes };
  if (!(THEME_SECTIONS as readonly string[]).includes(section)) throw new Error(`Unknown theme section ${section}`);
  return { source: theme.source, [section]: theme[section as keyof ThemeReport], notes: theme.notes };
}
