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

test('text case declared in the .fig is applied without changing source characters', () => {
  const node = rect({
    type: 'TEXT', name: 'serie', characters: 'serie', width: 33, height: 13,
    style: { fontFamily: 'Roboto Mono', fontSize: 10, fontWeight: 700, textCase: 'UPPER' },
  });
  const { svg } = renderScreen(node);
  assert.equal((node as FigNode & { characters?: string }).characters, 'serie');
  assert.match(svg, /<tspan[^>]*>SERIE<\/tspan>/);
});

test('missing icon-font ligatures stay within their glyph box without covering adjacent text', () => {
  const node = rect({
    type: 'TEXT', name: 'Title', characters: 'rocket-l', width: 24, height: 24,
    style: { fontFamily: 'icons-deliveroo', fontSize: 24, fontWeight: 400 },
  });
  const { svg } = renderScreen(node);
  assert.match(svg, /data-font-fallback="icons-deliveroo"/);
  assert.match(svg, /data-source-ligature="rocket-l"/);
  assert.doesNotMatch(svg, /<tspan[^>]*>rocket-l<\/tspan>/);
  assert.equal((node as FigNode & { characters?: string }).characters, 'rocket-l');
});

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

test('component text assignments use the effective varValue in current .fig files', () => {
  const label = rect({
    guid: { sessionID: 1, localID: 3 }, type: 'TEXT', name: 'Label',
    characters: 'Label', width: 180, height: 24,
    style: { fontFamily: 'Inter', fontSize: 16, fontWeight: 400 },
  });
  const symbol = { ...rect({ guid: { sessionID: 1, localID: 2 }, width: 180, height: 40 }),
    type: 'FRAME', children: [label] } as FigNode;
  const instance = { ...rect({ guid: { sessionID: 1, localID: 1 }, width: 180, height: 40 }),
    type: 'INSTANCE', symbolData: { symbolID: symbol.guid } } as FigNode;
  const nodeIndex = new Map([['1:1', instance], ['1:2', symbol], ['1:3', label]]);
  const rawNodeIndex = new Map<string, Record<string, unknown>>([
    ['1:1', { componentPropAssignments: [{ defID: { sessionID: 1, localID: 4 }, value: {},
      varValue: { value: { textDataValue: { characters: 'Exportar resultados' } } } }] }],
    ['1:3', { componentPropRefs: [{ defID: { sessionID: 1, localID: 4 }, componentPropNodeField: 'TEXT_DATA' }] }],
  ]);
  const { svg } = renderScreen(instance, undefined, undefined, { nodeIndex, rawNodeIndex, viewport: 'node' });
  assert.match(svg, /Exportar resultados/);
  assert.doesNotMatch(svg, />Label</);
});

test('instance textData overrides replace declared component text', () => {
  const value = rect({ guid: { sessionID: 7, localID: 3 }, type: 'TEXT',
    name: 'Value', characters: '999 cm', width: 120, height: 24,
    style: { fontFamily: 'Inter', fontSize: 16, fontWeight: 400 } });
  const symbol = { ...rect({ guid: { sessionID: 7, localID: 2 } }),
    type: 'FRAME', children: [value] } as FigNode;
  const instance = { ...rect({ guid: { sessionID: 7, localID: 1 } }),
    type: 'INSTANCE', symbolData: { symbolID: symbol.guid } } as FigNode;
  const rawNodeIndex = new Map<string, Record<string, unknown>>([
    ['7:1', { symbolData: { symbolOverrides: [{
      guidPath: { guids: [value.guid] }, textData: { characters: '176 cm' },
    }] } }],
  ]);
  const nodeIndex = new Map([['7:1', instance], ['7:2', symbol], ['7:3', value]]);
  const svg = renderScreen(instance, undefined, undefined, { nodeIndex, rawNodeIndex, viewport: 'node' }).svg;
  assert.match(svg, /176 cm/);
  assert.doesNotMatch(svg, /999 cm/);
});

test('instance maxLines hides wrapped baselines after the allowed line', () => {
  const value = rect({ guid: { sessionID: 11, localID: 3 }, type: 'TEXT',
    characters: 'First second', width: 90, height: 40,
    style: { fontFamily: 'Inter', fontSize: 16, fontWeight: 400 },
    derivedTextData: { baselines: [
      { firstCharacter: 0, endCharacter: 5, position: { x: 0, y: 16 }, lineY: 0, lineAscent: 16, lineHeight: 20 },
      { firstCharacter: 6, endCharacter: 12, position: { x: 0, y: 36 }, lineY: 20, lineAscent: 16, lineHeight: 20 },
    ] },
  });
  const symbol = { ...rect({ guid: { sessionID: 11, localID: 2 } }),
    type: 'FRAME', children: [value] } as FigNode;
  const instance = { ...rect({ guid: { sessionID: 11, localID: 1 } }),
    type: 'INSTANCE', symbolData: { symbolID: symbol.guid } } as FigNode;
  const rawNodeIndex = new Map<string, Record<string, unknown>>([
    ['11:1', { symbolData: { symbolOverrides: [{
      guidPath: { guids: [value.guid] }, maxLines: 1, textTruncation: 'ENDING',
    }] } }],
  ]);
  const nodeIndex = new Map([['11:1', instance], ['11:2', symbol], ['11:3', value]]);
  const svg = renderScreen(instance, undefined, undefined, { nodeIndex, rawNodeIndex, viewport: 'node' }).svg;
  assert.match(svg, />First…</);
  assert.doesNotMatch(svg, /second/);
});

test('nested instances retain their own text assignments and direct variant overrides', () => {
  const innerText = rect({ guid: { sessionID: 2, localID: 2 }, type: 'TEXT',
    characters: 'Label', width: 120, height: 24,
    style: { fontFamily: 'Inter', fontSize: 16, fontWeight: 400 } });
  const innerSymbol = { ...rect({ guid: { sessionID: 2, localID: 1 } }),
    type: 'FRAME', children: [innerText] } as FigNode;
  const alternateText = rect({ guid: { sessionID: 2, localID: 5 }, type: 'TEXT',
    characters: 'Alternate', width: 120, height: 24,
    style: { fontFamily: 'Inter', fontSize: 16, fontWeight: 400 } });
  const alternateSymbol = { ...rect({ guid: { sessionID: 2, localID: 4 } }),
    type: 'FRAME', children: [alternateText] } as FigNode;
  const nested = { ...rect({ guid: { sessionID: 2, localID: 3 } }),
    type: 'INSTANCE', symbolData: { symbolID: innerSymbol.guid } } as FigNode;
  const outerSymbol = { ...rect({ guid: { sessionID: 3, localID: 1 } }),
    type: 'FRAME', children: [nested] } as FigNode;
  const outer = { ...rect({ guid: { sessionID: 3, localID: 2 } }),
    type: 'INSTANCE', symbolData: { symbolID: outerSymbol.guid } } as FigNode;
  const nodeIndex = new Map([['2:1', innerSymbol], ['2:2', innerText], ['2:3', nested],
    ['2:4', alternateSymbol], ['2:5', alternateText], ['3:1', outerSymbol], ['3:2', outer]]);
  const rawNodeIndex = new Map<string, Record<string, unknown>>([
    ['2:3', { componentPropAssignments: [{ defID: { sessionID: 2, localID: 6 },
      varValue: { value: { textDataValue: { characters: 'Fuera GFT' } } } }] }],
    ['2:2', { componentPropRefs: [{ defID: { sessionID: 2, localID: 6 }, componentPropNodeField: 'TEXT_DATA' }] }],
  ]);
  const original = renderScreen(outer, undefined, undefined, { nodeIndex, rawNodeIndex, viewport: 'node' }).svg;
  assert.match(original, /Fuera GFT/);
  assert.doesNotMatch(original, />Label</);

  rawNodeIndex.set('3:2', { symbolData: { symbolOverrides: [{
    guidPath: { guids: [{ sessionID: 2, localID: 3 }] },
    overriddenSymbolID: alternateSymbol.guid,
  }, {
    guidPath: { guids: [{ sessionID: 2, localID: 3 }, alternateText.guid] },
    textData: { characters: 'Variant content' },
  }] } });
  const variant = renderScreen(outer, undefined, undefined, { nodeIndex, rawNodeIndex, viewport: 'node' }).svg;
  assert.match(variant, /Variant content/);
  assert.doesNotMatch(variant, /Alternate/);
  assert.doesNotMatch(variant, /Fuera GFT/);
  assert.deepEqual((nested as FigNode & { symbolData?: { symbolID?: unknown } }).symbolData?.symbolID, innerSymbol.guid);
  rawNodeIndex.delete('3:2');
  const afterVariant = renderScreen(outer, undefined, undefined, { nodeIndex, rawNodeIndex, viewport: 'node' }).svg;
  assert.match(afterVariant, /Fuera GFT/);
  assert.doesNotMatch(afterVariant, /Alternate/);
});

test('nested component properties target the variant selected by the parent', () => {
  const baseLabel = rect({ guid: { sessionID: 15, localID: 2 }, type: 'TEXT',
    characters: 'Label', style: { fontFamily: 'Inter', fontSize: 14, fontWeight: 400 } });
  const selectedLabel = rect({ guid: { sessionID: 15, localID: 4 }, type: 'TEXT',
    characters: 'Label', style: { fontFamily: 'Inter', fontSize: 14, fontWeight: 400 } });
  const base = { ...rect({ guid: { sessionID: 15, localID: 1 } }), type: 'FRAME',
    children: [baseLabel] } as FigNode;
  const selected = { ...rect({ guid: { sessionID: 15, localID: 3 } }), type: 'FRAME',
    children: [selectedLabel] } as FigNode;
  const nested = { ...rect({ guid: { sessionID: 15, localID: 5 } }), type: 'INSTANCE',
    symbolData: { symbolID: base.guid } } as FigNode;
  const wrapper = { ...rect({ guid: { sessionID: 15, localID: 6 } }), type: 'FRAME',
    children: [nested] } as FigNode;
  const outer = { ...rect({ guid: { sessionID: 15, localID: 7 } }), type: 'INSTANCE',
    symbolData: { symbolID: wrapper.guid } } as FigNode;
  const defId = { sessionID: 15, localID: 8 };
  const nodeIndex = new Map([['15:1', base], ['15:2', baseLabel], ['15:3', selected],
    ['15:4', selectedLabel], ['15:5', nested], ['15:6', wrapper], ['15:7', outer]]);
  const rawNodeIndex = new Map<string, Record<string, unknown>>([
    ['15:7', { symbolData: { symbolOverrides: [{
      guidPath: { guids: [nested.guid] }, overriddenSymbolID: selected.guid,
      componentPropAssignments: [{ defID: defId,
        varValue: { value: { textDataValue: { characters: 'Emitidas' } } } }],
    }] } }],
    ['15:4', { componentPropRefs: [{ defID: defId, componentPropNodeField: 'TEXT_DATA' }] }],
  ]);
  const svg = renderScreen(outer, undefined, undefined, { nodeIndex, rawNodeIndex, viewport: 'node' }).svg;
  assert.match(svg, />Emitidas</);
  assert.doesNotMatch(svg, />Label</);
});

test('reused nested components keep independent labels and direct visibility', () => {
  const label = rect({ guid: { sessionID: 16, localID: 2 }, type: 'TEXT',
    characters: 'Label', style: { fontFamily: 'Inter', fontSize: 14, fontWeight: 400 } });
  const item = { ...rect({ guid: { sessionID: 16, localID: 1 } }), type: 'FRAME',
    children: [label] } as FigNode;
  const items = [3, 4, 5].map(localID => ({ ...rect({ guid: { sessionID: 16, localID } }),
    type: 'INSTANCE', symbolData: { symbolID: item.guid } } as FigNode));
  const wrapper = { ...rect({ guid: { sessionID: 16, localID: 6 } }), type: 'FRAME',
    children: items } as FigNode;
  const outer = { ...rect({ guid: { sessionID: 16, localID: 7 } }), type: 'INSTANCE',
    symbolData: { symbolID: wrapper.guid } } as FigNode;
  const defId = { sessionID: 16, localID: 8 };
  const assign = (guid: FigNode['guid'], characters: string) => ({
    guidPath: { guids: [guid] }, componentPropAssignments: [{ defID: defId,
      varValue: { value: { textDataValue: { characters } } } }],
  });
  const rawNodeIndex = new Map<string, Record<string, unknown>>([
    ['16:7', { symbolData: { symbolOverrides: [
      assign(items[0]!.guid, 'Emitidas'), assign(items[1]!.guid, 'Recibidas'),
      { guidPath: { guids: [items[2]!.guid] }, visible: false },
    ] } }],
    ['16:2', { componentPropRefs: [{ defID: defId, componentPropNodeField: 'TEXT_DATA' }] }],
  ]);
  const nodeIndex = new Map([['16:1', item], ['16:2', label], ['16:3', items[0]!],
    ['16:4', items[1]!], ['16:5', items[2]!], ['16:6', wrapper], ['16:7', outer]]);
  const svg = renderScreen(outer, undefined, undefined, { nodeIndex, rawNodeIndex, viewport: 'node' }).svg;
  assert.match(svg, />Emitidas</);
  assert.match(svg, />Recibidas</);
  assert.doesNotMatch(svg, />Label</);
});

test('uniform instance scale positions nested vector content inside its frame', () => {
  const shape = rect({ guid: { sessionID: 17, localID: 2 }, x: 50, y: 10,
    width: 100, height: 20, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }] });
  const symbol = { ...rect({ guid: { sessionID: 17, localID: 1 }, width: 200, height: 50 }),
    type: 'FRAME', children: [shape] } as FigNode;
  const instance = { ...rect({ guid: { sessionID: 17, localID: 3 }, width: 40, height: 10 }),
    type: 'INSTANCE', symbolData: { symbolID: symbol.guid, uniformScaleFactor: 0.2 } } as FigNode;
  const nodeIndex = new Map([['17:1', symbol], ['17:2', shape], ['17:3', instance]]);
  const svg = renderScreen(instance, undefined, undefined, { nodeIndex, viewport: 'node' }).svg;
  assert.match(svg, /transform="matrix\(0\.2 0 0 0\.2 10 2\)"/);
});

test('unbound boolean properties hide named component parts in exported .fig versions', () => {
  const helper = rect({ guid: { sessionID: 4, localID: 3 }, type: 'TEXT',
    name: 'Helper text', characters: 'Helper text', width: 100, height: 20,
    style: { fontFamily: 'Inter', fontSize: 14, fontWeight: 400 } });
  const content = rect({ guid: { sessionID: 4, localID: 4 }, type: 'TEXT',
    name: 'Content', characters: 'Hospital general', width: 140, height: 20,
    style: { fontFamily: 'Inter', fontSize: 14, fontWeight: 400 } });
  const symbol = { ...rect({ guid: { sessionID: 4, localID: 2 } }),
    type: 'FRAME', children: [helper, content] } as FigNode;
  const instance = { ...rect({ guid: { sessionID: 4, localID: 1 } }),
    type: 'INSTANCE', symbolData: { symbolID: symbol.guid } } as FigNode;
  const rawNodeIndex = new Map<string, Record<string, unknown>>([
    ['4:1', { componentPropAssignments: [{ defID: { sessionID: 4, localID: 6 },
      varValue: { value: { boolValue: false } } }] }],
    ['4:2', { componentPropDefs: [{ id: { sessionID: 4, localID: 6 },
      parentPropDefId: { sessionID: 4, localID: 5 } }] }],
    ['4:9', { componentPropDefs: [{ id: { sessionID: 4, localID: 5 }, name: 'Show helper' }] }],
  ]);
  const nodeIndex = new Map([['4:1', instance], ['4:2', symbol], ['4:3', helper], ['4:4', content]]);
  const svg = renderScreen(instance, undefined, undefined, { nodeIndex, rawNodeIndex, viewport: 'node' }).svg;
  assert.match(svg, /Hospital general/);
  assert.doesNotMatch(svg, /Helper text/);
});

test('unbound Show Icon2 property reveals a hidden icon in its component', () => {
  const iconContent = rect({ guid: { sessionID: 18, localID: 3 }, type: 'TEXT',
    characters: 'download-icon', style: { fontFamily: 'Inter', fontSize: 14, fontWeight: 400 } });
  const icon = { ...rect({ guid: { sessionID: 18, localID: 2 }, name: 'Icon 2', visible: false }),
    type: 'INSTANCE', children: [iconContent] } as FigNode;
  const symbol = { ...rect({ guid: { sessionID: 18, localID: 1 } }), type: 'FRAME',
    children: [icon] } as FigNode;
  const instance = { ...rect({ guid: { sessionID: 18, localID: 4 } }), type: 'INSTANCE',
    symbolData: { symbolID: symbol.guid } } as FigNode;
  const rawNodeIndex = new Map<string, Record<string, unknown>>([
    ['18:4', { componentPropAssignments: [{ defID: { sessionID: 18, localID: 6 },
      varValue: { value: { boolValue: true } } }] }],
    ['18:1', { componentPropDefs: [{ id: { sessionID: 18, localID: 6 },
      parentPropDefId: { sessionID: 18, localID: 5 } }] }],
    ['18:9', { componentPropDefs: [{ id: { sessionID: 18, localID: 5 }, name: 'Show Icon2' }] }],
  ]);
  const nodeIndex = new Map([['18:1', symbol], ['18:2', icon],
    ['18:3', iconContent], ['18:4', instance]]);
  assert.match(renderScreen(instance, undefined, undefined, {
    nodeIndex, rawNodeIndex, viewport: 'node',
  }).svg, /download-icon/);
});

test('nested text properties without node refs use a unique declared default', () => {
  const title = rect({ guid: { sessionID: 8, localID: 3 }, type: 'TEXT',
    name: 'Título', characters: 'Título', width: 120, height: 24,
    style: { fontFamily: 'Inter', fontSize: 16, fontWeight: 400 } });
  const body = rect({ guid: { sessionID: 8, localID: 4 }, type: 'TEXT',
    name: 'Body', characters: 'Default body', width: 200, height: 24,
    style: { fontFamily: 'Inter', fontSize: 14, fontWeight: 400 } });
  const innerSymbol = { ...rect({ guid: { sessionID: 8, localID: 2 } }),
    type: 'FRAME', children: [title, body] } as FigNode;
  const nested = { ...rect({ guid: { sessionID: 8, localID: 5 } }),
    type: 'INSTANCE', symbolData: { symbolID: innerSymbol.guid } } as FigNode;
  const outerSymbol = { ...rect({ guid: { sessionID: 8, localID: 6 } }),
    type: 'FRAME', children: [nested] } as FigNode;
  const outer = { ...rect({ guid: { sessionID: 8, localID: 1 } }),
    type: 'INSTANCE', symbolData: { symbolID: outerSymbol.guid } } as FigNode;
  const defId = { sessionID: 8, localID: 7 };
  const rawNodeIndex = new Map<string, Record<string, unknown>>([
    ['8:1', { symbolData: { symbolOverrides: [{
      guidPath: { guids: [nested.guid] }, componentPropAssignments: [{
        defID: defId, varValue: { value: { textDataValue: { characters: 'Error' } } },
      }],
    }] } }],
    ['8:2', { componentPropDefs: [{ id: defId, name: 'Title',
      varValue: { value: { textDataValue: { characters: 'Título' } } } }] }],
  ]);
  const nodeIndex = new Map([['8:1', outer], ['8:2', innerSymbol], ['8:3', title],
    ['8:4', body], ['8:5', nested], ['8:6', outerSymbol]]);
  const svg = renderScreen(outer, undefined, undefined, { nodeIndex, rawNodeIndex, viewport: 'node' }).svg;
  assert.match(svg, /Error/);
  assert.match(svg, /Default body/);
  assert.doesNotMatch(svg, /Título/);
});

test('unbound text property targets its unique originating layer in a component set', () => {
  const title = rect({ guid: { sessionID: 9, localID: 3 }, type: 'TEXT',
    name: 'Title', characters: 'Label', width: 140, height: 22,
    style: { fontFamily: 'Inter', fontSize: 14, fontWeight: 400 } });
  const subtitle = rect({ guid: { sessionID: 10, localID: 4 }, type: 'TEXT',
    name: 'Subtitle', characters: 'Label', width: 140, height: 22,
    style: { fontFamily: 'Inter', fontSize: 14, fontWeight: 400 } });
  const symbol = { ...rect({ guid: { sessionID: 9, localID: 2 } }),
    type: 'FRAME', children: [title, subtitle] } as FigNode;
  const instance = { ...rect({ guid: { sessionID: 9, localID: 1 } }),
    type: 'INSTANCE', symbolData: { symbolID: symbol.guid } } as FigNode;
  const titleDef = { sessionID: 9, localID: 5 };
  const subtitleDef = { sessionID: 10, localID: 6 };
  const rawNodeIndex = new Map<string, Record<string, unknown>>([
    ['9:1', { componentPropAssignments: [
      { defID: titleDef, varValue: { value: { textDataValue: { characters: 'Medicine' } } } },
      { defID: subtitleDef, varValue: { value: { textDataValue: { characters: 'One tablet' } } } },
    ] }],
    ['9:2', { componentPropDefs: [
      { id: titleDef, name: 'Title' },
      { id: subtitleDef, parentPropDefId: { sessionID: 10, localID: 0 } },
    ] }],
    ['9:3', { componentPropRefs: [{ defID: titleDef, componentPropNodeField: 'TEXT_DATA' }] }],
  ]);
  const nodeIndex = new Map([['9:1', instance], ['9:2', symbol], ['9:3', title], ['10:4', subtitle]]);
  const svg = renderScreen(instance, undefined, undefined, { nodeIndex, rawNodeIndex, viewport: 'node' }).svg;
  assert.match(svg, /Medicine/);
  assert.match(svg, /One tablet/);
  assert.doesNotMatch(svg, />Label</);
});

test('nested input properties hide unused icons and swap the chosen icon', () => {
  const iconText = (sessionID: number, characters: string) => rect({
    guid: { sessionID, localID: 2 }, type: 'TEXT', characters, width: 90, height: 20,
    style: { fontFamily: 'Inter', fontSize: 14, fontWeight: 400 },
  });
  const circleText = iconText(12, 'circle-icon');
  const searchText = iconText(13, 'search-icon');
  const circle = { ...rect({ guid: { sessionID: 12, localID: 1 } }),
    type: 'FRAME', children: [circleText] } as FigNode;
  const search = { ...rect({ guid: { sessionID: 13, localID: 1 } }),
    type: 'FRAME', children: [searchText] } as FigNode;
  const leading = { ...rect({ guid: { sessionID: 14, localID: 3 }, name: 'Leading icon' }),
    type: 'INSTANCE', symbolData: { symbolID: circle.guid } } as FigNode;
  const trail = { ...rect({ guid: { sessionID: 14, localID: 4 }, name: 'Trail icon' }),
    type: 'INSTANCE', symbolData: { symbolID: circle.guid } } as FigNode;
  const inputSymbol = { ...rect({ guid: { sessionID: 14, localID: 2 } }),
    type: 'FRAME', children: [leading, trail] } as FigNode;
  const input = { ...rect({ guid: { sessionID: 14, localID: 5 } }),
    type: 'INSTANCE', symbolData: { symbolID: inputSymbol.guid } } as FigNode;
  const outerSymbol = { ...rect({ guid: { sessionID: 14, localID: 6 } }),
    type: 'FRAME', children: [input] } as FigNode;
  const outer = { ...rect({ guid: { sessionID: 14, localID: 1 } }),
    type: 'INSTANCE', symbolData: { symbolID: outerSymbol.guid } } as FigNode;
  const trailDef = { sessionID: 14, localID: 7 };
  const leadingDef = { sessionID: 14, localID: 8 };
  const nodeIndex = new Map([['12:1', circle], ['12:2', circleText], ['13:1', search],
    ['13:2', searchText], ['14:1', outer], ['14:2', inputSymbol], ['14:3', leading],
    ['14:4', trail], ['14:5', input], ['14:6', outerSymbol]]);
  const rawNodeIndex = new Map<string, Record<string, unknown>>([
    ['14:1', { symbolData: { symbolOverrides: [{
      guidPath: { guids: [input.guid] }, componentPropAssignments: [
        { defID: trailDef, varValue: { value: { boolValue: false } } },
        { defID: leadingDef, varValue: { value: { symbolIdValue: { guid: search.guid } } } },
      ],
    }] } }],
    ['14:2', { componentPropDefs: [
      { id: trailDef, name: 'Show trail icon' },
      { id: leadingDef, name: 'Leading icon' },
    ] }],
  ]);
  const svg = renderScreen(outer, undefined, undefined, { nodeIndex, rawNodeIndex, viewport: 'node' }).svg;
  assert.match(svg, /search-icon/);
  assert.doesNotMatch(svg, /circle-icon/);
  assert.deepEqual((leading as FigNode & { symbolData?: { symbolID?: unknown } }).symbolData?.symbolID, circle.guid);
});
