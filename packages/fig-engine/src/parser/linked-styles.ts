import type { FigNode, GUID, Paint, SceneNode } from './types.js';
import { formatGUID } from './kiwi-parser.js';

/** Resolve local paint styles before rendering, theming, or exposing node data. */
export function resolveLinkedPaintStyles(
  document: FigNode,
  rawNodeIndex: Map<string, Record<string, unknown>>,
): void {
  function paintsFor(raw: Record<string, unknown>, key: 'styleIdForFill' | 'styleIdForStrokeFill'): Paint[] | undefined {
    const guid = (raw[key] as { guid?: GUID } | undefined)?.guid;
    if (!guid) return undefined;
    const style = rawNodeIndex.get(formatGUID(guid));
    return style?.styleType === 'FILL' && Array.isArray(style.fillPaints)
      ? style.fillPaints as Paint[]
      : undefined;
  }

  function visit(node: FigNode): void {
    const raw = rawNodeIndex.get(formatGUID(node.guid));
    if (raw) {
      const scene = node as SceneNode;
      const fills = paintsFor(raw, 'styleIdForFill');
      const strokes = paintsFor(raw, 'styleIdForStrokeFill');
      if (fills) scene.fills = fills;
      if (strokes) scene.strokes = strokes;
    }
    for (const child of node.children ?? []) visit(child);
  }

  visit(document);
}
