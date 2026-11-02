import { Resvg } from '@resvg/resvg-js';

export interface ScreenshotOptions {
  fontFiles?: string[];
  maxWidth?: number;  // Default: 800 (ignored when pixelPerfect)
  maxHeight?: number; // Default: 600 (ignored when pixelPerfect)
  /** When true, skip 800×600 clamp; scale by options.scale (default 1). */
  pixelPerfect?: boolean;
  /** Explicit scale multiplier (default 1). Used with pixelPerfect or as fit scale cap. */
  scale?: number;
}

function isUnlimited(n: number | undefined): boolean {
  return n === 0 || n === Infinity || (typeof n === "number" && !Number.isFinite(n) && n > 0);
}

export async function generateScreenshot(
  svgString: string,
  options: ScreenshotOptions = {}
): Promise<{ base64: string; width: number; height: number; mimeType: string; bytes: number }> {
  const pixelPerfect =
    options.pixelPerfect === true ||
    isUnlimited(options.maxWidth) ||
    isUnlimited(options.maxHeight);

  const userScale = typeof options.scale === "number" && options.scale > 0 ? options.scale : 1;

  // Parse SVG dimensions from the string
  const widthMatch = svgString.match(/width="([\d.]+)"/);
  const heightMatch = svgString.match(/height="([\d.]+)"/);
  const svgWidth = widthMatch ? parseFloat(widthMatch[1]!) : 800;
  const svgHeight = heightMatch ? parseFloat(heightMatch[1]!) : 600;

  let targetWidth: number;
  if (pixelPerfect) {
    targetWidth = Math.max(1, Math.round(svgWidth * userScale));
  } else {
    const maxWidth = options.maxWidth ?? 800;
    const maxHeight = options.maxHeight ?? 600;
    const fitScale = Math.min(maxWidth / svgWidth, maxHeight / svgHeight, 1) * userScale;
    targetWidth = Math.max(1, Math.round(svgWidth * fitScale));
  }

  const resvg = new Resvg(svgString, {
    font: options.fontFiles ? { fontFiles: options.fontFiles, loadSystemFonts: false, defaultFontFamily: 'Rubik' } : undefined,
    fitTo: {
      mode: 'width',
      value: targetWidth,
    },
  });

  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  return {
    base64: pngBuffer.toString('base64'),
    width: pngData.width,
    height: pngData.height,
    mimeType: 'image/png',
    bytes: pngBuffer.length,
  };
}
