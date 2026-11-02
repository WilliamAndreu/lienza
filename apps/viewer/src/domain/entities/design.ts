export interface Layer {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  childCount: number;
  children?: Layer[];
  backgroundColor?: { r: number; g: number; b: number; a: number } | null;
  backgroundEnabled?: boolean;
  backgroundOpacity?: number;
}

export interface DocumentStatus {
  loaded: boolean;
  name: string | null;
  parser: string | null;
  version: number | null;
  nodeCount: number;
  imageCount: number;
  pages: Layer[];
  suggestedNodeId: string | null;
  selectedId: string | null;
  viewingNodeId: string | null;
  viewingPath: Layer[];
  revision: number;
  renderKey: string;
}

export interface NodeDetails extends Layer {
  x: number | null; y: number | null; width: number | null; height: number | null;
  text: string | null; opacity: number; fills: unknown[]; strokes: unknown[]; layout: unknown;
  typography: { family: string | null; declaredFamily: string | null; renderedFamily: string; postscript: string | null; size: number | null; weight: number | null; lineHeight: number | null; letterSpacing: number | null; substituted: boolean } | null;
}

export interface HitArea { id: string; x: number; y: number; width: number; height: number; depth: number; }
