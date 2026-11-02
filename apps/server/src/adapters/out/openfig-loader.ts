import { loadFig, readFigThumbnail, renderFigProjectPreview } from '@figma-reader/fig-engine';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { FigLoader } from '../../domain/ports.js';

const inFlight = new Map<string, Promise<Uint8Array | undefined>>();

async function cachedPreview(path: string): Promise<Uint8Array | undefined> {
  const cachePath = `${path}.preview-v1.png`;
  try { return await readFile(cachePath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

  const existing = inFlight.get(path);
  if (existing) return existing;
  const pending = (async () => {
    const image = await renderFigProjectPreview(path);
    if (!image) return undefined;
    const temporary = `${cachePath}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, image); await rename(temporary, cachePath); }
    finally { await rm(temporary, { force: true }); }
    return image;
  })();
  inFlight.set(path, pending);
  try { return await pending; }
  finally { inFlight.delete(path); }
}

export const openFigLoader: FigLoader = {
  load: loadFig,
  thumbnail: readFigThumbnail,
  preview: cachedPreview,
};
