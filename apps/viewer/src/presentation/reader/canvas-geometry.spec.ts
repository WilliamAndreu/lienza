import { fitCanvas, focusCanvasOnArea, zoomCanvasAt } from './canvas-geometry';

describe('canvas viewport', () => {
  it('centers a full page inside the panel', () => {
    const result = fitCanvas(6000, 1900, 900, 700);
    expect(result.x).toBeGreaterThan(0);
    expect(result.y).toBeGreaterThan(0);
    expect(result.x + 6000 * result.zoom).toBeLessThan(900);
    expect(result.y + 1900 * result.zoom).toBeLessThan(700);
  });

  it('keeps the same design point under the pointer while zooming', () => {
    const before = { x: 120, y: 80, zoom: 0.5 };
    const anchor = { x: 420, y: 300 };
    const documentX = (anchor.x - before.x) / before.zoom;
    const documentY = (anchor.y - before.y) / before.zoom;
    const after = zoomCanvasAt(before, 1.25, anchor.x, anchor.y);
    expect(after.x + documentX * after.zoom).toBeCloseTo(anchor.x);
    expect(after.y + documentY * after.zoom).toBeCloseTo(anchor.y);
  });
});

describe('focusCanvasOnArea', () => {
  it('zooms into a small layer and centers it without changing the rendered view', () => {
    const area = { x: 240, y: 120, width: 72, height: 88 };
    const focused = focusCanvasOnArea({ x: 0, y: 0, zoom: 1 }, area, 1000, 700);
    expect(focused.zoom).toBe(3.5795454545454546);
    expect(focused.x + (area.x + area.width / 2) * focused.zoom).toBeCloseTo(500);
    expect(focused.y + (area.y + area.height / 2) * focused.zoom).toBeCloseTo(350);
  });
});
