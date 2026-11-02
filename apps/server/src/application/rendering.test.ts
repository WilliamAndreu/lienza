import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportNodeTrueSvg, renderScreen, type FigNode } from '@figma-reader/fig-engine';
import { Resvg } from '@resvg/resvg-js';

const rect = (overrides: Record<string, unknown> = {}): FigNode => ({
  guid: { sessionID: 1, localID: 1 },
  type: 'RECTANGLE',
  name: 'Test rectangle',
  width: 100,
  height: 50,
  ...overrides,
} as FigNode);

test('gradients respect the file matrix and viewer/exporter share the composition', () => {
  const node = rect({
    fills: [{
      type: 'GRADIENT_LINEAR',
      transform: { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 },
      stops: [
        { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } },
      ],
    }],
  });
  const preview = renderScreen(node, undefined, undefined, { viewport: 'node' });
  const exported = exportNodeTrueSvg(node);
  assert.match(preview.svg, /gradientTransform="matrix\(0 50 -100 0 100 0\)"/);
  assert.match(preview.svg, /stop-opacity="0\.5"/);
  assert.equal(exported.svg, preview.svg);
});

test('multiple paints preserve order and layer opacity is applied only once', () => {
  const node = rect({
    opacity: 0.5,
    fills: [
      { type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } },
      { type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 0.5 } },
    ],
  });
  const { svg } = renderScreen(node);
  assert.equal((svg.match(/<rect /g) ?? []).length, 2);
  assert.equal((svg.match(/opacity="0\.5"/g) ?? []).length, 1);
  assert.ok(svg.indexOf('rgb(255, 0, 0)') < svg.indexOf('rgba(0, 0, 255, 0.50)'));
});

test('a frame with a gradient fill retains its paint', () => {
  const node = { ...rect(), type: 'FRAME', fills: [{
    type: 'GRADIENT_LINEAR',
    stops: [
      { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
      { position: 1, color: { r: 0, g: 1, b: 0, a: 1 } },
    ],
  }] } as FigNode;
  assert.match(renderScreen(node).svg, /<linearGradient/);
});

test('layer blur applies to the content and reaches neighboring pixels', () => {
  const blurred = rect({
    x: 30, y: 30, width: 40, height: 40,
    fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
    effects: [{ type: 'FOREGROUND_BLUR', radius: 6, visible: true }],
  });
  const frame = { ...rect({ width: 100, height: 100 }), type: 'FRAME', children: [blurred] } as FigNode;
  const png = new Resvg(renderScreen(frame, undefined, undefined, { viewport: 'node' }).svg).render();
  const outside = (50 * png.width + 25) * 4;
  assert.ok(png.pixels[outside] > 0);
  assert.ok(png.pixels[outside + 3] > 0);
});

test('a gradient keeps its colors inside a translated rectangle', () => {
  const node = rect({
    width: 200, height: 40,
    fills: [{ type: 'SOLID', color: { r: 0.07, g: 0.08, b: 0.11, a: 1 } }],
    children: [rect({
      guid: { sessionID: 1, localID: 2 }, x: 100, width: 100, height: 40,
      fills: [{
        type: 'GRADIENT_LINEAR',
        transform: { m00: -1, m01: 0, m02: 1, m10: 0, m11: 1, m12: 0 },
        stops: [
          { position: 0, color: { r: 0.24, g: 0.38, b: 0.91, a: 1 } },
          { position: 1, color: { r: 0.07, g: 0.08, b: 0.11, a: 1 } },
        ],
      }],
    })],
  });
  const image = new Resvg(renderScreen(node, undefined, undefined, { viewport: 'node' }).svg).render();
  const pixel = (x: number) => image.pixels.subarray((20 * image.width + x) * 4, (20 * image.width + x) * 4 + 4);
  assert.ok(pixel(190)[2]! > 170, 'el extremo derecho debe ser azul');
  assert.ok(pixel(110)[2]! < 80, 'el extremo izquierdo debe seguir oscuro');
});

test('transformed images are clipped to the shape', () => {
  const node = rect({ fills: [{
    type: 'IMAGE', imageRef: 'abc123', imageScaleMode: 'STRETCH',
    transform: { m00: 0.5, m01: 0, m02: 0.25, m10: 0, m11: 1, m12: 0 },
  }] });
  const images = { get: (hash: string) => hash === 'abc123' ? Uint8Array.from([137, 80, 78, 71]) : undefined };
  const result = renderScreen(node, images);
  assert.match(result.svg, /<clipPath id="image-clip-/);
  assert.match(result.svg, /<image[^>]+transform="matrix\(2 0 0 1 -50 0\)"/);
  assert.deepEqual(result.imageHashes, ['abc123']);
});

test('a vertical Figma crop enlarges the photo inside the avatar', () => {
  const node = rect({ width: 24, height: 24, fills: [
    { type: 'SOLID', color: { r: 0.4, g: 0.4, b: 0.4, a: 1 } },
    {
      type: 'IMAGE', imageRef: 'avatar', imageScaleMode: 'STRETCH',
      transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 2 / 3, m12: 0.05 },
    },
  ] });
  const source = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="36"><path fill="red" d="M0 0h24v36H0z"/></svg>').render().asPng();
  const images = { get: (hash: string) => hash === 'avatar' ? source : undefined };
  const { svg } = renderScreen(node, images);
  const image = new Resvg(svg).render();
  const bottom = image.pixels.subarray((22 * image.width + 12) * 4, (22 * image.width + 12) * 4 + 4);
  assert.deepEqual([...bottom], [255, 0, 0, 255], 'the photo must also cover the bottom of the avatar');
});

test('an image over vector geometry preserves the silhouette', () => {
  const node = { ...rect(), type: 'ELLIPSE', fills: [
    { type: 'SOLID', color: { r: 0.3, g: 0.3, b: 0.3, a: 1 } },
    { type: 'IMAGE', imageRef: 'avatar' },
  ], fillGeometry: [{ commands: ['M', 50, 0, 'L', 100, 25, 'L', 50, 50, 'L', 0, 25, 'Z'] }] } as FigNode;
  const images = { get: (hash: string) => hash === 'avatar' ? Uint8Array.from([137, 80, 78, 71]) : undefined };
  const result = renderScreen(node, images);
  assert.match(result.svg, /<clipPath id="image-clip-\d+"[^>]*><path d="M 50 0 L 100 25 L 50 50 L 0 25 Z"/);
  assert.match(result.svg, /<image[^>]+href="data:image\/png;base64,/);
  assert.deepEqual(result.imageHashes, ['avatar']);
});

test('text uses baselines derived from Figma', () => {
  const node = {
    ...rect(), type: 'TEXT', characters: 'ABCD',
    style: { fontFamily: 'Rubik', fontSize: 16, fontWeight: 400, textAlignHorizontal: 'LEFT', letterSpacing: 0, lineHeightPx: 20 },
    derivedTextData: { baselines: [
      { firstCharacter: 0, endCharacter: 2, position: { x: 0, y: 15 }, lineY: 0, lineAscent: 15, lineHeight: 20 },
      { firstCharacter: 2, endCharacter: 4, position: { x: 0, y: 35 }, lineY: 20, lineAscent: 15, lineHeight: 20 },
    ] },
  } as FigNode;
  const { svg } = renderScreen(node);
  assert.match(svg, /<tspan x="0" y="15">AB<\/tspan>/);
  assert.match(svg, /<tspan x="0" y="35">CD<\/tspan>/);
});

test('translucent masks preserve alpha instead of only clipping', () => {
  const mask = rect({ guid: { sessionID: 1, localID: 2 }, isMask: true, opacity: 0.5 });
  const content = rect({ guid: { sessionID: 1, localID: 3 }, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }] });
  const frame = { ...rect(), type: 'FRAME', children: [mask, content] } as FigNode;
  const { svg } = renderScreen(frame);
  assert.match(svg, /<mask id="mask-/);
  assert.match(svg, /mask="url\(#mask-/);
  assert.match(svg, /opacity="0\.5"/);
});
