import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Workspace } from './workspace.js';
import { openFigLoader } from '../adapters/out/openfig-loader.js';
import { exportNodeTrueSvg, getHitAreas, loadFig, renderFigNode, renderScreen } from '@figma-reader/fig-engine';
import type { FigNode } from '@figma-reader/fig-engine';

test('canvas hit areas exclude hidden, locked, and transparent layers', () => {
  const frame = (localID: number, properties: Record<string, unknown> = {}) => ({
    guid: { sessionID: 1, localID }, type: 'FRAME', name: `Frame ${localID}`,
    x: localID * 20, y: 0, width: 10, height: 10, ...properties,
  });
  const page = { guid: { sessionID: 1, localID: 0 }, type: 'CANVAS', name: 'Page', children: [
    frame(1), frame(2, { visible: false }), frame(3, { locked: true }), frame(4, { opacity: 0 }),
  ] } as FigNode;
  assert.deepEqual(getHitAreas(page).map(area => area.id), ['1:1']);
});

test('hit areas use the visible SVG origin when a frame clips descendants', () => {
  const page = { guid: { sessionID: 1, localID: 0 }, type: 'CANVAS', name: 'Page', children: [
    { guid: { sessionID: 1, localID: 1 }, type: 'FRAME', name: 'Clipped', x: 100, y: 50,
      width: 100, height: 80, clipsContent: true, children: [
        { guid: { sessionID: 1, localID: 2 }, type: 'RECTANGLE', name: 'Outside', x: -500, y: -500, width: 20, height: 20 },
      ] },
  ] } as FigNode;
  const rendered = renderScreen(page);
  const frame = getHitAreas(page).find(area => area.id === '1:1');
  assert.ok(frame);
  assert.equal(rendered.width, 100);
  assert.equal(rendered.height, 80);
  assert.deepEqual({ x: frame.x, y: frame.y, width: frame.width, height: frame.height },
    { x: 0, y: 0, width: 100, height: 80 });
});

test('opens, indexes, renders, and shares selection from a real .fig', { skip: !process.env.FIGMA_TEST_FILE }, async () => {
  const workspace = new Workspace(openFigLoader);
  const status = await workspace.open(process.env.FIGMA_TEST_FILE!);
  assert.equal(status.loaded, true);
  assert.ok(status.nodeCount > 0);
  assert.ok(status.pages.length > 0);
  assert.ok(status.suggestedNodeId);

  const node = workspace.node(status.suggestedNodeId!);
  assert.ok(node.name);
  const rendered = workspace.render(node.id);
  assert.equal(workspace.render(node.id), rendered);
  assert.match(rendered.svg, /<svg/);
  assert.ok(rendered.width > 0 && rendered.height > 0);
  const hitAreas = workspace.hitAreas(node.id);
  assert.ok(hitAreas.length > 0);
  assert.equal(workspace.hitAreas(node.id), hitAreas);

  workspace.select(node.id);
  assert.equal(workspace.selection().selectedId, node.id);
  const pageWithPeer = status.pages.find(page => (workspace.tree(page.id).children?.length ?? 0) > 1);
  assert.ok(pageWithPeer);
  const other = workspace.tree(pageWithPeer.id).children?.find(child => child.id !== node.id);
  assert.ok(other);
  const path = workspace.path(other.id);
  assert.equal(path[0]?.id, pageWithPeer.id);
  assert.equal(path.at(-1)?.id, other.id);
  workspace.view(other.id);
  assert.equal(workspace.selection().selectedId, node.id);
  assert.equal(workspace.selection().viewingNodeId, other.id);
  assert.equal(workspace.status().viewingPath.at(-1)?.id, other.id);
  assert.equal(workspace.search(node.name).some(found => found.id === node.id), true);
  const renderKey = workspace.status().renderKey;
  await workspace.open(process.env.FIGMA_TEST_FILE!);
  assert.notEqual(workspace.status().renderKey, renderKey);
});

test('DEV keeps its five views and clips components and sections', { skip: !process.env.FIGMA_TEST_FILE }, async () => {
  const workspace = new Workspace(openFigLoader);
  const status = await workspace.open(process.env.FIGMA_TEST_FILE!);
  const dev = status.pages.find(page => page.name === 'DEV');
  assert.ok(dev);

  const views = workspace.tree(dev.id).children ?? [];
  assert.equal(views.length, 5);
  const overview = workspace.render(dev.id);
  assert.ok(overview.width > 6000);
  assert.ok(overview.height >= 1900);

  const resources = views.find(view => view.name === 'Recursos');
  assert.ok(resources);
  assert.match(workspace.render(resources.id).svg, /<rect x="0" y="0" width="1208" height="655"[^>]*fill="rgb\(33, 33, 33\)"/);

  const events = views.find(view => view.name === 'Tipos de eventos');
  assert.ok(events);
  assert.match(workspace.render(events.id).svg, /<clipPath id="clip-/);
});

test('the .fig produces a reusable theme with provenance and font substitutions', {
  skip: !process.env.FIGMA_TEST_FILE?.endsWith('Rudo Dashboard.fig'),
}, async () => {
  const workspace = new Workspace(openFigLoader);
  await workspace.open(process.env.FIGMA_TEST_FILE!);
  const theme = workspace.theme();
  assert.equal(workspace.theme(), theme);
  assert.ok(theme.source.analyzedNodes > 6000);
  assert.ok(theme.colors.find(color => color.hex === '#FF005F' && color.count > 0));
  assert.ok(theme.radii.find(radius => radius.css === '8px'));
  assert.ok(theme.spacing.find(space => space.px === 16 && space.source === 'geometry'));
  assert.ok(theme.borders.length > 0);
  assert.ok(theme.shadows.length > 0);
  const declaredFont = theme.typography.fonts.find(font => font.family === 'Raptor V3 Premium');
  assert.equal(declaredFont?.declaredFamily, 'Raptor V3 Premium');
  assert.equal(declaredFont?.renderedFamily, 'Rubik');
  assert.equal(declaredFont?.substituted, true);
  assert.equal(workspace.node(declaredFont!.examples[0]!.id).typography?.declaredFamily, 'Raptor V3 Premium');
  assert.match(theme.cssVariables, /--fig-color-\d+: #/);
  assert.match(theme.cssVariables, /--fig-type-\d+:/);
  assert.ok(theme.colors[0]?.examples[0]?.id);
});

test('Proyectos Rudo resolves linked color styles and page background', {
  skip: !process.env.FIGMA_PROJECTS_TEST_FILE?.endsWith('Proyectos Rudo Dashboard.fig'),
}, async () => {
  const workspace = new Workspace(openFigLoader);
  const status = await workspace.open(process.env.FIGMA_PROJECTS_TEST_FILE!);
  assert.deepEqual(status.pages.find(page => page.id === '4:14')?.backgroundColor,
    { r: 0.8980392217636108, g: 0.8980392217636108, b: 0.8980392217636108, a: 1 });
  const panel = workspace.node('7:859');
  const grid = workspace.node('126:5455');
  assert.deepEqual((panel.fills as Array<{ color: { r: number; g: number; b: number } }>)[0]?.color,
    { r: 0.07058823853731155, g: 0.0784313753247261, b: 0.10980392247438431, a: 1 });
  assert.ok(((grid.fills as Array<{ color: { r: number } }>)[0]?.color.r ?? 0) > 0.97);
  assert.match(workspace.render('4:14').svg, /<rect width="100%" height="100%" fill="rgba\(229,229,229,1\.000\)"/);
  const transparentPage = workspace.render('4:14', { includeCanvasBackground: false });
  assert.doesNotMatch(transparentPage.svg, /<rect width="100%" height="100%" fill="rgba\(229,229,229,1\.000\)"/);
  assert.notEqual(transparentPage, workspace.render('4:14'));
  assert.match(workspace.render('25:18614').svg, /<linearGradient/);
  const headerChildren = workspace.tree('56:16203').children ?? [];
  assert.equal(headerChildren[0]?.id, '25:1574', 'the background must remain behind the logo and text');
  assert.ok(headerChildren.findIndex(child => child.id === '7:1230') > 0);
  const panelSvg = workspace.render('7:859').svg;
  assert.match(panelSvg, /<image[^>]+href="data:image\/jpeg;base64,/);
  assert.match(panelSvg, /<clipPath id="image-clip-\d+"[^>]*><path d=/);
});

test('Personas preserves the rounded left corners from the .fig', {
  skip: !process.env.FIGMA_PROJECTS_TEST_FILE?.endsWith('Proyectos Rudo Dashboard.fig'),
}, async () => {
  const file = await loadFig(process.env.FIGMA_PROJECTS_TEST_FILE!);
  const { svg } = renderFigNode(file, '35:10011');
  assert.match(svg, /<path d="M 0 16 C 0 7\.163/);
  assert.match(svg, /L 227 0 L 227 32/);
  assert.match(renderFigNode(file, '35:13478').svg, /<path d="M 16 32 C 16 23\.163/);
});

test('RudoApps preserves circular photos, masks, geometry, and text styles', {
  skip: !process.env.FIGMA_TEST_FILE?.endsWith('Rudo Dashboard.fig'),
}, async () => {
  const workspace = new Workspace(openFigLoader);
  await workspace.open(process.env.FIGMA_TEST_FILE!);
  const rendered = workspace.render('869:4285');
  assert.equal(rendered.width, 1080);
  assert.equal(rendered.height, 1920);
  assert.match(rendered.svg, /<rect x="0" y="0" width="48" height="48" rx="24" ry="24"/);
  assert.match(rendered.svg, /<image[^>]+width="48" height="48"/);
  assert.match(rendered.svg, /<rect[^>]+width="48" height="48"[^>]+fill="rgba\(0, 0, 0, 0\.60\)"/);
  assert.match(rendered.svg, /fill-rule="evenodd"/);
  assert.match(rendered.svg, /<linearGradient/);
  assert.match(rendered.svg, />Activos vs<\/tspan><tspan fill="rgb\(33, 33, 33\)"[^>]*> Total<\/tspan>/);
  assert.match(rendered.svg, />53<\/tspan><tspan fill="rgb\(33, 33, 33\)"/);

  const ringBase = workspace.render('869:4346').svg;
  assert.match(ringBase, /<ellipse cx="46" cy="46" rx="42\.892/);
  assert.equal((ringBase.match(/<path /g) ?? []).length, 1);
});

test('department icons use scaled geometry from their instances', {
  skip: !process.env.FIGMA_TEST_FILE?.endsWith('Rudo Dashboard.fig'),
}, async () => {
  const workspace = new Workspace(openFigLoader);
  await workspace.open(process.env.FIGMA_TEST_FILE!);
  for (const [name, id] of [
    ['iOS', '869:4700'],
    ['Android', '869:4449'],
    ['Back', '869:4915'],
    ['Ionic', '869:4525'],
    ['Flutter', '869:4609'],
  ]) {
    const svg = workspace.render(id).svg;
    const xCoordinates = [...svg.matchAll(/<path d="([^"]+)"/g)]
      .flatMap(([, d]) => [...d.matchAll(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)].map(match => Number(match[0])))
      .filter((_, index) => index % 2 === 0);
    assert.ok(xCoordinates.length > 0, `${name}: no geometry`);
    assert.ok(Math.max(...xCoordinates) - Math.min(...xCoordinates) > 22, `${name}: icon not scaled`);
  }
});

test('typography and color headings preserve glyphs beyond their line box', {
  skip: !process.env.FIGMA_TEST_FILE?.endsWith('Rudo Dashboard.fig'),
}, async () => {
  const workspace = new Workspace(openFigLoader);
  await workspace.open(process.env.FIGMA_TEST_FILE!);

  for (const [id, title, frameHeight] of [
    ['1837:4417', 'TIPOGRAFÍAS', 1161],
    ['1837:4416', 'COLORES', 1149],
  ] as const) {
    const rendered = workspace.render(id);
    const hitAreas = workspace.hitAreas(id);
    const frame = hitAreas.find(area => area.id === id);
    assert.ok(frame);
    assert.ok(rendered.height > frameHeight + 100, `${title}: SVG clips the heading`);
    assert.ok(Math.abs(frame.y - (rendered.height - frameHeight)) < 0.01);
    assert.match(rendered.svg, new RegExp(title));
    assert.match(rendered.svg, /<clipPath[^>]*><path d="M 0 0 L [\d.]+ 0 L [\d.]+ [\d.]+ L 0 [\d.]+ Z" \/><\/clipPath>/);
  }
});

test('the exported SVG exactly matches the RudoApps preview and its images', {
  skip: !process.env.FIGMA_TEST_FILE?.endsWith('Rudo Dashboard.fig'),
}, async () => {
  const file = await loadFig(process.env.FIGMA_TEST_FILE!);
  const node = file.nodeIndex.get('869:4285');
  assert.ok(node);
  const preview = renderFigNode(file, '869:4285');
  const exported = exportNodeTrueSvg(node, {
    blobs: file.blobs, images: file.images,
    nodeIndex: file.nodeIndex, rawNodeIndex: file.rawNodeIndex,
    imageResolver: { allowBase64: true },
  });
  assert.equal(exported.svg, preview.svg);
  assert.equal(exported.imageHashes.length, 9);
});
