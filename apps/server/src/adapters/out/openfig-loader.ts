import { loadFig, readFigThumbnail } from '@figma-reader/fig-engine';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FigLoader } from '../../domain/ports.js';

const inFlight = new Map<string, Promise<Uint8Array | undefined>>();
let previewQueue: Promise<void> = Promise.resolve();
const CACHE_VERSION = 4;
const MAX_PREVIEW_BYTES = 12_000_000;
const MAX_WORKER_RSS_KB = 512 * 1024;

function safePng(image: Uint8Array | undefined): image is Uint8Array {
  if (!image || image.length < 24 || image.length > MAX_PREVIEW_BYTES) return false;
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => image[index] === byte)) return false;
  const data = new DataView(image.buffer, image.byteOffset + 16, 8);
  const width = data.getUint32(0);
  const height = data.getUint32(4);
  return width > 0 && height > 0 && width <= 8_000 && height <= 8_000 && width * height <= 16_000_000;
}

async function embeddedThumbnail(path: string): Promise<Uint8Array | undefined> {
  try {
    const image = await readFigThumbnail(path);
    return safePng(image) ? image : undefined;
  } catch { return undefined; }
}

function renderPreviewInChild(path: string): Promise<Uint8Array | undefined> {
  const run = previewQueue.then(async () => {
    const output = `${path}.preview-${randomUUID()}.tmp`;
    const source = import.meta.url.endsWith('.ts');
    const worker = fileURLToPath(new URL(`./preview-worker.${source ? 'ts' : 'js'}`, import.meta.url));
    try {
      const succeeded = await new Promise<boolean>(resolve => {
        const child = spawn(process.execPath, [
          ...(source ? ['--import', 'tsx'] : []), '--max-old-space-size=384', worker, path, output,
        ], { stdio: 'ignore' });
        let finished = false;
        const timer = setTimeout(() => child.kill('SIGKILL'), 12_000);
        const monitor = setInterval(async () => {
          if (finished || !child.pid) return;
          try {
            const status = await readFile(`/proc/${child.pid}/status`, 'utf8');
            const rss = Number(status.match(/^VmRSS:\s+(\d+) kB/m)?.[1] ?? 0);
            if (!finished && rss > MAX_WORKER_RSS_KB) child.kill('SIGKILL');
          } catch { /* /proc is available in Docker; the timeout still covers other hosts. */ }
        }, 250);
        const finish = (succeeded: boolean) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          clearInterval(monitor);
          resolve(succeeded);
        };
        child.once('error', () => finish(false));
        child.once('close', code => finish(code === 0));
      });
      if (!succeeded || (await stat(output)).size > MAX_PREVIEW_BYTES) return undefined;
      const image = await readFile(output);
      return safePng(image) ? image : undefined;
    } finally { await rm(output, { force: true }); }
  });
  previewQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function cachedPreview(path: string): Promise<Uint8Array | undefined> {
  const cachePath = `${path}.preview-v${CACHE_VERSION}.png`;
  const emptyPath = `${path}.preview-v${CACHE_VERSION}.empty`;
  try {
    const cached = await readFile(cachePath);
    if (safePng(cached)) return cached;
    await rm(cachePath, { force: true });
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { await stat(emptyPath); return undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

  const existing = inFlight.get(path);
  if (existing) return existing;
  const pending = (async () => {
    // A failed preview is cached too, so a pathological file is never retried
    // on every library visit. The version changes when the policy changes.
    let image: Uint8Array | undefined;
    try { image = await renderPreviewInChild(path); }
    catch { /* Fall back to the embedded image. */ }
    if (!safePng(image)) image = await embeddedThumbnail(path);
    const clearOldCaches = () => Promise.all([1, 2, 3].map(version => rm(`${path}.preview-v${version}.png`, { force: true })));
    if (!image) { await writeFile(emptyPath, ''); await clearOldCaches(); return undefined; }
    const temporary = `${cachePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, image);
      await rename(temporary, cachePath);
      await clearOldCaches();
    }
    finally { await rm(temporary, { force: true }); }
    return image;
  })();
  inFlight.set(path, pending);
  try { return await pending; }
  finally { inFlight.delete(path); }
}

export const openFigLoader: FigLoader = {
  load: loadFig,
  thumbnail: embeddedThumbnail,
  preview: cachedPreview,
};
