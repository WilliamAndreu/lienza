export interface CanvasTransform {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.01;
export const MAX_ZOOM = 8;

export function fitCanvas(
  contentWidth: number,
  contentHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): CanvasTransform {
  const padding = viewportWidth < 640 ? 24 : 48;
  const zoom = Math.max(MIN_ZOOM, Math.min(
    1,
    (viewportWidth - padding * 2) / contentWidth,
    (viewportHeight - padding * 2) / contentHeight,
  ));
  return {
    x: (viewportWidth - contentWidth * zoom) / 2,
    y: (viewportHeight - contentHeight * zoom) / 2,
    zoom,
  };
}

/** Keep the same document point underneath the cursor while zooming. */
export function zoomCanvasAt(
  current: CanvasTransform,
  nextZoom: number,
  anchorX: number,
  anchorY: number,
): CanvasTransform {
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
  const ratio = zoom / current.zoom;
  return {
    x: anchorX - (anchorX - current.x) * ratio,
    y: anchorY - (anchorY - current.y) * ratio,
    zoom,
  };
}

/** Enlarge a selected layer while keeping it in the current rendered context. */
export function focusCanvasOnArea(
  current: CanvasTransform,
  area: { x: number; y: number; width: number; height: number },
  viewportWidth: number,
  viewportHeight: number,
): CanvasTransform {
  const targetZoom = Math.min(4, viewportWidth * 0.45 / area.width, viewportHeight * 0.45 / area.height);
  const zoom = Math.max(current.zoom, Math.min(MAX_ZOOM, targetZoom));
  return {
    x: viewportWidth / 2 - (area.x + area.width / 2) * zoom,
    y: viewportHeight / 2 - (area.y + area.height / 2) * zoom,
    zoom,
  };
}
