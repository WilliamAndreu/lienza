import type { LoadedFig } from '@figma-reader/fig-engine';

export interface FigLoader {
  load(path: string): Promise<LoadedFig>;
  thumbnail(path: string): Promise<Uint8Array | undefined>;
  preview(path: string): Promise<Uint8Array | undefined>;
}

export interface LayerSummary {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  childCount: number;
  children?: LayerSummary[];
  backgroundColor?: { r: number; g: number; b: number; a: number } | null;
  backgroundEnabled?: boolean;
  backgroundOpacity?: number;
}
