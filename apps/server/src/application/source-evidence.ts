import { detectImageFormat, formatGUID, getMimeType, paintToImageHash } from '@figma-reader/fig-engine';
import type { FigNode, LoadedFig, SceneNode } from '@figma-reader/fig-engine';

type Raw = Record<string, unknown>;

function scalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function fields(raw: Raw | undefined, names: string[]) {
  const result: Record<string, string | number | boolean> = {};
  for (const name of names) {
    const value = scalar(raw?.[name]);
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function guidId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const guid = value as Raw;
  return typeof guid.sessionID === 'number' && typeof guid.localID === 'number'
    ? `${guid.sessionID}:${guid.localID}` : null;
}

/** Only report layout values actually encoded in the file. Missing fields are not defaulted. */
export function layoutEvidence(node: FigNode, raw: Raw | undefined) {
  const scene = node as SceneNode;
  const stack = fields(raw, [
    'stackMode', 'stackSpacing', 'stackHorizontalPadding', 'stackVerticalPadding',
    'stackPaddingRight', 'stackPaddingBottom', 'stackPrimarySizing', 'stackCounterSizing',
    'stackPrimaryAlignItems', 'stackCounterAlignItems', 'stackWrap', 'stackChildAlignSelf',
    'stackChildPrimaryGrow', 'stackChildShrink', 'stackPositioning',
  ]);
  const autoLayout = stack.stackMode === 'HORIZONTAL' || stack.stackMode === 'VERTICAL'
    ? { source: 'fig' as const, format: 'fig-stack' as const, fields: stack }
    : scene.layoutMode && scene.layoutMode.mode !== 'NONE'
      ? { source: 'fig' as const, format: 'normalized-layout' as const, fields: scene.layoutMode }
      : null;
  const rawConstraints = fields(raw, ['horizontalConstraint', 'verticalConstraint']);
  const constraints = Object.keys(rawConstraints).length > 0
    ? { source: 'fig' as const, format: 'fig-constraints' as const, fields: rawConstraints }
    : scene.constraints
      ? { source: 'fig' as const, format: 'normalized-constraints' as const, fields: scene.constraints }
      : null;
  const childRules = fields(raw, ['stackChildAlignSelf', 'stackChildPrimaryGrow', 'stackChildShrink', 'stackPositioning']);
  return { autoLayout, constraints, childRules: Object.keys(childRules).length ? { source: 'fig' as const, fields: childRules } : null };
}

export function componentEvidence(file: LoadedFig, node: FigNode, referenceCounts: Map<string, number>) {
  const id = formatGUID(node.guid);
  const raw = file.rawNodeIndex.get(id);
  const scene = node as SceneNode;
  const definitionId = guidId(scene.symbolData?.symbolID) ?? guidId((raw?.symbolData as Raw | undefined)?.symbolID);
  const definition = definitionId ? file.nodeIndex.get(definitionId) : undefined;
  const definitionRaw = definitionId ? file.rawNodeIndex.get(definitionId) : undefined;
  const componentKey = scalar(raw?.componentKey);
  const isDefinition = node.type === 'COMPONENT' || node.type === 'COMPONENT_SET' || !!componentKey || referenceCounts.has(id);
  if (!definitionId && !isDefinition) return null;
  const variantSpecs = (definitionRaw?.variantPropSpecs ?? raw?.variantPropSpecs) as unknown;
  const variants = Array.isArray(variantSpecs) ? variantSpecs.slice(0, 12).map(spec => {
    if (!spec || typeof spec !== 'object') return null;
    const value = scalar((spec as Raw).value);
    const propertyId = guidId((spec as Raw).propDefId);
    return value === undefined ? null : { propertyId, value };
  }).filter(Boolean) : [];
  return {
    source: 'fig' as const,
    role: definitionId ? 'instance' as const : 'definition' as const,
    definitionId: definitionId ?? id,
    definitionName: definition?.name ?? (definitionId ? null : node.name),
    definitionResolved: !!(definition ?? (!definitionId && isDefinition)),
    componentKey: scalar(definitionRaw?.componentKey) ?? componentKey ?? null,
    variantProperties: variants,
    instanceCount: referenceCounts.get(definitionId ?? id) ?? 0,
    overrideCount: Array.isArray(scene.symbolData?.symbolOverrides) ? scene.symbolData.symbolOverrides.length : 0,
  };
}

export function componentReferenceCounts(file: LoadedFig) {
  const counts = new Map<string, number>();
  for (const node of file.nodeIndex.values()) {
    const id = guidId((node as SceneNode).symbolData?.symbolID);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const [id, raw] of file.rawNodeIndex) {
    if (typeof raw.componentKey === 'string' && file.nodeIndex.has(id) && !counts.has(id)) counts.set(id, 0);
  }
  return counts;
}

export function imageAssetHashes(node: FigNode, maxNodes = 5000) {
  const hashes = new Map<string, { hash: string; nodeIds: string[]; occurrences: number }>();
  const queue: FigNode[] = [node];
  let scannedNodes = 0;
  let cursor = 0;
  while (cursor < queue.length && scannedNodes < maxNodes) {
    const current = queue[cursor++]!;
    scannedNodes++;
    const scene = current as SceneNode;
    for (const paint of [...(scene.fills ?? []), ...(scene.strokes ?? [])]) {
      if (paint.visible === false || paint.type !== 'IMAGE') continue;
      const hash = paintToImageHash(paint);
      if (!hash || !/^[a-f0-9]{40}$/.test(hash)) continue;
      let entry = hashes.get(hash);
      if (!entry) { entry = { hash, nodeIds: [], occurrences: 0 }; hashes.set(hash, entry); }
      entry.occurrences++;
      if (entry.nodeIds.length < 3) entry.nodeIds.push(formatGUID(current.guid));
    }
    queue.push(...(current.children ?? []));
  }
  return { assets: [...hashes.values()], scannedNodes, truncated: cursor < queue.length };
}

export function imageAsset(file: LoadedFig, hash: string) {
  if (!/^[a-f0-9]{40}$/.test(hash)) throw new Error('Invalid image hash');
  const bytes = file.images.get(hash);
  if (!bytes) throw new Error(`Asset ${hash} not found`);
  const format = detectImageFormat(bytes);
  const mimeType = getMimeType(format);
  if (mimeType === 'application/octet-stream') throw new Error(`Unsupported asset format for ${hash}`);
  return { bytes, mimeType, format };
}
