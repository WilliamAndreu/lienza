import type { Workspace } from './workspace.js';

export type ThemeSection = 'all' | 'colors' | 'typography' | 'radii' | 'borders' | 'shadows' | 'spacing' | 'css';

export function themeData(workspace: Workspace, section: ThemeSection = 'all', limit = 30): Record<string, unknown> {
  const theme = workspace.theme();
  const bounded = Math.max(1, Math.min(limit, 100));
  const observed = <T extends object>(items: T[]) => items.slice(0, bounded).map(item => ({ ...item,
    provenance: { value: 'fig', grouping: 'inferred' } }));
  const sections = {
    colors: observed(theme.colors),
    typography: { fonts: observed(theme.typography.fonts), styles: observed(theme.typography.styles) },
    radii: observed(theme.radii), borders: observed(theme.borders), shadows: observed(theme.shadows),
    spacing: theme.spacing.slice(0, bounded).map(item => ({ ...item,
      provenance: { value: item.source === 'auto-layout' ? 'fig' : 'inferred', grouping: 'inferred' } })),
  };
  const css = { cssVariables: theme.cssVariables, cssVariablesProvenance: 'inferred' };
  if (section === 'css') return { source: theme.source, ...css, notes: theme.notes };
  if (section !== 'all') return { source: theme.source, [section]: sections[section], notes: theme.notes };
  return { source: theme.source, ...sections, ...css, notes: theme.notes };
}
