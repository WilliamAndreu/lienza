import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { screenshotFigNode } from '@figma-reader/fig-engine';
import type { OpenDocument } from './document.js';

export const PNG_MAX_SIDE = 1600;
// Rasterizing costs memory per output pixel, not per layer: about 16 bytes each at peak
// (RGBA buffer, PNG encoding, effect layers), so 50 Mpx is roughly 1 GB.
export const PNG_PIXEL_BUDGET = 50_000_000;
const PNG_BYTES_PER_PIXEL = 16;

export interface PngSize {
  maxWidth?: number;
  maxHeight?: number;
  scale?: number;
  allowLarge?: boolean;
}

/** Output scale for a PNG of a node whose design size is width × height, checked against the pixel budget. */
export function pngScale(width: number, height: number, size: PngSize = {}) {
  if (!width || !height) throw new Error('The node has no visible content');
  const requested = size.scale;
  if (requested !== undefined && !(requested > 0 && Number.isFinite(requested))) throw new Error('--scale must be a positive number');
  // Without --scale, fit within PNG_MAX_SIDE and never enlarge. --scale sizes from the design; --max-* still bound it.
  const side = requested ? Infinity : PNG_MAX_SIDE;
  const scale = Math.min(requested ?? 1, (size.maxWidth || side) / width, (size.maxHeight || side) / height);
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  const pixels = outWidth * outHeight;
  if (pixels > PNG_PIXEL_BUDGET && !size.allowLarge) {
    throw new Error(`The PNG would be ${outWidth}×${outHeight} px (${Math.round(pixels / 1e6)} Mpx, roughly `
      + `${(pixels * PNG_BYTES_PER_PIXEL / 1e9).toFixed(1)} GB of memory); the limit is ${PNG_PIXEL_BUDGET / 1e6} Mpx.\n`
      + 'Render a frame instead of the page, lower --max-width or --scale, or use --format svg. To render it anyway: --allow-large');
  }
  return scale;
}

export async function renderPng(document: OpenDocument, nodeId: string, size: PngSize = {}) {
  const design = document.workspace.render(nodeId);
  const scale = pngScale(design.width, design.height, size);
  const image = await screenshotFigNode(document.file, nodeId, { pixelPerfect: true, scale });
  return { bytes: Buffer.from(image.base64, 'base64'), width: image.width, height: image.height, scale,
    designWidth: design.width, designHeight: design.height };
}

/**
 * Rasterizes through `lienza render` in a child process. resvg aborts the whole process on some geometry,
 * so callers that must survive a failed frame (export, the interactive session) use this instead of renderPng.
 */
export function pngInChildProcess(cliMain: string, figPath: string) {
  const run = promisify(execFile);
  return async (nodeId: string, out: string, size: PngSize = { maxWidth: PNG_MAX_SIDE, maxHeight: PNG_MAX_SIDE }) => {
    const flags = [
      ...(size.maxWidth ? ['--max-width', String(size.maxWidth)] : []),
      ...(size.maxHeight ? ['--max-height', String(size.maxHeight)] : []),
      ...(size.scale ? ['--scale', String(size.scale)] : []),
      ...(size.allowLarge ? ['--allow-large'] : []),
    ];
    try {
      const { stdout } = await run(process.execPath, [...process.execArgv, cliMain, 'render', figPath, '--id', nodeId, '--format', 'png', ...flags, '--out', out]);
      return JSON.parse(stdout) as { out: string; width: number; height: number; scale: number };
    } catch (error) {
      const { stderr, signal } = error as { stderr?: string; signal?: string };
      const panic = stderr?.match(/panicked at [^\n]*\n([^\n]+)/)?.[1];
      if (panic) throw new Error(`The PNG renderer (resvg) crashed on this node: ${panic}. Its SVG renders fine: render svg`);
      throw new Error(stderr?.match(/^lienza: ([\s\S]*)$/m)?.[1]?.trim() ?? `PNG renderer exited${signal ? ` with ${signal}` : ''}`);
    }
  };
}
