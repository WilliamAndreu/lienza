import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { isSafeProjectPreviewTarget, readFigThumbnail, selectProjectPreviewTarget, type CanvasNode, type SceneNode } from '@figma-reader/fig-engine';

let nextId = 1;
const frame = (name: string, width: number, height: number, children: SceneNode[] = []): SceneNode => ({
  guid: { sessionID: 1, localID: nextId++ }, type: 'FRAME', name, width, height, children,
});
const page = (name: string, children: SceneNode[]): CanvasNode => ({
  guid: { sessionID: 1, localID: nextId++ }, type: 'CANVAS', name, children,
});

test('preview selects the declared Cover composition, never a similarly shaped UI page', () => {
  const unrelated = page('UI', [frame('Dashboard', 18_715, 21_157)]);
  const thumbnail = frame('Thumbnail', 960, 480);
  const cover = page('Cover', [frame('Decoration', 400, 400), thumbnail]);
  assert.equal(selectProjectPreviewTarget([unrelated, cover]), thumbnail);
  assert.equal(isSafeProjectPreviewTarget(thumbnail), true);
  assert.equal(selectProjectPreviewTarget([unrelated, page('#cover', [frame('#cover', 960, 480)])])?.name, '#cover');
});

test('preview falls back when no cover is declared or the declared cover exceeds its budget', () => {
  assert.equal(selectProjectPreviewTarget([page('UI', [frame('Dashboard', 960, 480)])]), undefined);
  assert.equal(isSafeProjectPreviewTarget(frame('Cover', 18_715, 21_157)), false);
  const manyChildren = frame('Cover', 960, 480, Array.from({ length: 3_001 }, () => frame('pixel', 1, 1)));
  assert.equal(isSafeProjectPreviewTarget(manyChildren), false);
});

test('embedded thumbnail reads the bounded ZIP entry without parsing canvas.fig', async () => {
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/sZkAAAAASUVORK5CYII=', 'base64');
  const name = Buffer.from('thumbnail.png');
  const compressed = deflateRawSync(image);
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(image.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(image.length, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + compressed.length, 16);
  const dir = await mkdtemp(join(tmpdir(), 'lienza-preview-'));
  try {
    const file = join(dir, 'thumbnail.fig');
    await writeFile(file, Buffer.concat([local, compressed, central, eocd]));
    assert.deepEqual(Buffer.from((await readFigThumbnail(file))!), image);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
