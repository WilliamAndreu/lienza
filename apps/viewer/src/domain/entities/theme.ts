export interface ThemeExample { id: string; name: string; page: string }
export interface ThemeToken { count: number; examples: ThemeExample[] }
export interface ThemeColor extends ThemeToken { hex: string; alpha: number; css: string; fills: number; strokes: number; text: number; backgrounds: number }
export interface ThemeFont extends ThemeToken { family: string; declaredFamily: string; renderedFamily: string; substituted: boolean; sizes: Array<{ px: number; count: number }>; weights: Array<{ value: number; count: number }> }
export interface ThemeTextStyle extends ThemeToken { family: string; size: number; weight: number; lineHeight: number | null; letterSpacing: number }
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
