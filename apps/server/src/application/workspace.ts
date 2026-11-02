import { analyzeTheme, formatGUID, paintToImageHash, resolveFontFamily } from '@figma-reader/fig-engine';
import { getHitAreas, renderFigNode, screenshotFigNode } from '@figma-reader/fig-engine';
import type { FigNode, LoadedFig, SceneNode, ThemeReport } from '@figma-reader/fig-engine';
import type { FigLoader, LayerSummary } from '../domain/ports.js';
import { randomUUID } from 'node:crypto';
import { componentEvidence, componentReferenceCounts, imageAsset, imageAssetHashes, layoutEvidence } from './source-evidence.js';

function summary(node: FigNode, depth = 1): LayerSummary {
  const canvas = node.type === 'CANVAS' ? node as FigNode & {
    backgroundColor?: { r: number; g: number; b: number; a: number };
    backgroundEnabled?: boolean;
    backgroundOpacity?: number;
  } : null;
  return {
    id: formatGUID(node.guid), name: node.name || node.type, type: node.type,
    visible: node.visible !== false, childCount: node.children?.length ?? 0,
    ...(canvas ? {
      backgroundColor: canvas.backgroundColor ?? null,
      backgroundEnabled: canvas.backgroundEnabled ?? true,
      backgroundOpacity: canvas.backgroundOpacity ?? 1,
    } : {}),
    ...(depth > 0 ? { children: (node.children ?? []).map(child => summary(child, depth - 1)) } : {}),
  };
}

export class Workspace {
  private file?: LoadedFig;
  private themeReport?: ThemeReport;
  private selectedId?: string;
  private viewingNodeId?: string;
  private viewingPath: LayerSummary[] = [];
  private readonly parentIds = new Map<string, string | null>();
  private revision = 0;
  private renderKey = randomUUID();
  private readonly renderCache = new Map<string, ReturnType<typeof renderFigNode>>();
  private readonly hitAreaCache = new Map<string, ReturnType<typeof getHitAreas>>();
  private componentCounts = new Map<string, number>();

  constructor(private readonly loader: FigLoader) {}

  async open(path: string, displayName?: string) {
    const file = await this.loader.load(path);
    if (displayName) file.name = displayName;
    const themeReport = analyzeTheme(file);
    this.file = file;
    this.themeReport = themeReport;
    this.componentCounts = componentReferenceCounts(file);
    this.selectedId = undefined;
    this.parentIds.clear();
    const indexParents = (node: FigNode, parentId: string | null) => {
      const id = formatGUID(node.guid);
      this.parentIds.set(id, parentId);
      for (const child of node.children ?? []) indexParents(child, id);
    };
    indexParents(file.document, null);
    const firstPage = file.document.children?.find(node => node.visible !== false && (node.children?.length ?? 0) > 0)
      ?? file.document.children?.[0];
    this.viewingNodeId = firstPage ? formatGUID(firstPage.guid) : undefined;
    this.viewingPath = this.viewingNodeId ? this.path(this.viewingNodeId) : [];
    this.renderKey = randomUUID();
    this.renderCache.clear();
    this.hitAreaCache.clear();
    this.revision++;
    return this.status();
  }

  clear() {
    this.file = undefined;
    this.themeReport = undefined;
    this.selectedId = undefined;
    this.viewingNodeId = undefined;
    this.viewingPath = [];
    this.parentIds.clear();
    this.componentCounts.clear();
    this.renderCache.clear();
    this.hitAreaCache.clear();
    this.renderKey = randomUUID();
    this.revision++;
    return this.status();
  }

  private requireFile(): LoadedFig {
    if (!this.file) throw new Error('No .fig file is open');
    return this.file;
  }

  requireRenderKey(renderKey?: string) {
    if (renderKey && renderKey !== this.renderKey) {
      throw Object.assign(new Error('The .fig version changed; reload the project'), { statusCode: 409 });
    }
  }

  status() {
    const file = this.file;
    const pages = file?.document.children?.map(node => summary(node, 0)) ?? [];
    const firstPage = file?.document.children?.find(node => node.visible !== false && (node.children?.length ?? 0) > 0);
    const firstFrame = firstPage?.children?.find(node => node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'SECTION');
    return {
      loaded: !!file, name: file?.name ?? null, parser: file?.parser ?? null,
      version: file?.version ?? null, nodeCount: file?.nodeIndex.size ?? 0,
      imageCount: file?.images.size ?? 0, pages,
      renderKey: this.renderKey,
      viewingNodeId: this.viewingNodeId ?? null, viewingPath: this.viewingPath,
      suggestedNodeId: firstFrame ? formatGUID(firstFrame.guid) : firstPage ? formatGUID(firstPage.guid) : null,
      selectedId: this.selectedId ?? null, revision: this.revision,
    };
  }

  tree(pageId?: string, depth = 10) {
    const file = this.requireFile();
    const node = pageId ? file.nodeIndex.get(pageId) : file.document;
    if (!node) throw new Error(`Node ${pageId} not found`);
    return summary(node, Math.max(0, Math.min(depth, 20)));
  }

  node(id: string) {
    const node = this.requireFile().nodeIndex.get(id);
    if (!node) throw new Error(`Node ${id} not found`);
    const scene = node as FigNode & { x?: number; y?: number; width?: number; height?: number; characters?: string; opacity?: number; fills?: unknown[]; strokes?: unknown[]; layoutMode?: unknown; style?: { fontFamily?: string; fontFamilyDeclared?: boolean; fontPostScriptName?: string; fontSize?: number; fontWeight?: number; lineHeightPx?: number; letterSpacing?: number } };
    const declaredFamily = scene.style?.fontFamilyDeclared === false ? null : scene.style?.fontFamily ?? null;
    return {
      ...summary(node, 1), x: scene.x ?? null, y: scene.y ?? null,
      width: scene.width ?? null, height: scene.height ?? null,
      text: scene.characters ?? null, opacity: scene.opacity ?? 1,
      fills: scene.fills ?? [], strokes: scene.strokes ?? [],
      layout: scene.layoutMode ?? null,
      typography: scene.style ? {
        family: scene.style.fontFamily ?? null,
        declaredFamily,
        renderedFamily: resolveFontFamily(scene.style.fontFamily ?? 'Inter'),
        postscript: scene.style.fontPostScriptName ?? null,
        size: scene.style.fontSize ?? null,
        weight: scene.style.fontWeight ?? null,
        lineHeight: scene.style.lineHeightPx ?? null,
        letterSpacing: scene.style.letterSpacing ?? null,
        substituted: !!declaredFamily && resolveFontFamily(declaredFamily) !== declaredFamily,
      } : null,
    };
  }

  search(query: string, limit = 50) {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    return [...this.requireFile().nodeIndex.values()]
      .filter(node => node.name.toLocaleLowerCase().includes(normalized) || node.type.toLocaleLowerCase().includes(normalized))
      .slice(0, Math.max(1, Math.min(limit, 100)))
      .map(node => summary(node, 0));
  }

  select(id: string | null) {
    if (id && !this.requireFile().nodeIndex.has(id)) throw new Error(`Node ${id} not found`);
    this.selectedId = id ?? undefined;
    this.revision++;
    return { selectedId: this.selectedId ?? null, revision: this.revision, node: id ? this.node(id) : null };
  }

  selection() {
    const canvasBounds = this.selectedId && this.viewingNodeId
      ? this.hitAreas(this.viewingNodeId).find(area => area.id === this.selectedId) ?? null
      : null;
    return { selectedId: this.selectedId ?? null, viewingNodeId: this.viewingNodeId ?? null,
      viewingPath: this.viewingPath, revision: this.revision, renderKey: this.renderKey,
      canvasBounds, node: this.selectedId ? this.node(this.selectedId) : null };
  }

  path(id: string): LayerSummary[] {
    const file = this.requireFile();
    if (!file.nodeIndex.has(id)) throw new Error(`Node ${id} not found`);
    const path: LayerSummary[] = [];
    let current: string | null = id;
    while (current) {
      const node = file.nodeIndex.get(current);
      if (node && node.type !== 'DOCUMENT') path.push(summary(node, 0));
      current = this.parentIds.get(current) ?? null;
    }
    return path.reverse();
  }

  view(id: string) {
    this.viewingPath = this.path(id);
    this.viewingNodeId = id;
    this.revision++;
    return { viewingNodeId: id, viewingPath: this.viewingPath, revision: this.revision };
  }

  render(id: string, options: { includeCanvasBackground?: boolean } = {}) {
    const key = `${id}:${options.includeCanvasBackground === false ? 'transparent' : 'page'}`;
    const cached = this.renderCache.get(key);
    if (cached) {
      this.renderCache.delete(key);
      this.renderCache.set(key, cached);
      return cached;
    }
    const rendered = renderFigNode(this.requireFile(), id, options);
    this.renderCache.set(key, rendered);
    if (this.renderCache.size > 6) this.renderCache.delete(this.renderCache.keys().next().value!);
    return rendered;
  }
  screenshot(id: string, options?: { pixelPerfect?: boolean; maxWidth?: number; maxHeight?: number }) { return screenshotFigNode(this.requireFile(), id, options); }
  hitAreas(id: string) {
    const cached = this.hitAreaCache.get(id);
    if (cached) return cached;
    const node = this.requireFile().nodeIndex.get(id);
    if (!node) throw new Error(`Node ${id} not found`);
    const areas = getHitAreas(node);
    this.hitAreaCache.set(id, areas);
    return areas;
  }
  thumbnail() { return this.requireFile().thumbnail; }
  theme() { this.requireFile(); return this.themeReport!; }

  asset(hash: string) { return imageAsset(this.requireFile(), hash); }

  assetHashes() { return this.requireFile().images.listHashes(); }

  components(limit = 100, offset = 0) {
    const file = this.requireFile();
    const entries = [...this.componentCounts.entries()]
      .map(([id, instanceCount]) => {
        const node = file.nodeIndex.get(id);
        const componentKey = file.rawNodeIndex.get(id)?.componentKey;
        return { source: 'fig' as const, definitionId: id, name: node?.name ?? null,
          definitionResolved: !!node, instanceCount,
          componentKey: typeof componentKey === 'string' ? componentKey : null };
      })
      .sort((a, b) => b.instanceCount - a.instanceCount);
    const safeOffset = Math.max(0, Math.floor(offset));
    return { total: entries.length, offset: safeOffset,
      components: entries.slice(safeOffset, safeOffset + Math.max(1, Math.min(limit, 200))) };
  }

  implementationContext(id?: string, depth = 1, limit = 60, referenceMode: 'http' | 'tool' = 'http') {
    const file = this.requireFile();
    const nodeId = id ?? this.selectedId ?? this.viewingNodeId;
    if (!nodeId) throw new Error('Select a node or provide node_id');
    const root = file.nodeIndex.get(nodeId);
    if (!root) throw new Error(`Node ${nodeId} not found`);
    const safeDepth = Math.max(0, Math.min(depth, 2));
    const safeLimit = Math.max(1, Math.min(limit, 100));
    let included = 0;
    let truncated = false;
    const describe = (node: FigNode, level: number): Record<string, unknown> => {
      included++;
      const childCount = node.children?.length ?? 0;
      const scene = node as SceneNode;
      const currentId = formatGUID(node.guid);
      const raw = file.rawNodeIndex.get(currentId);
      const children: Record<string, unknown>[] = [];
      if (level < safeDepth) {
        for (const child of node.children ?? []) {
          if (included >= safeLimit) { truncated = true; break; }
          children.push(describe(child, level + 1));
        }
      }
      const declaredFont = scene.style?.fontFamilyDeclared === false ? null : scene.style?.fontFamily ?? null;
      const paintSummary = (paint: NonNullable<SceneNode['fills']>[number]) => ({
        type: paint.type, visible: paint.visible !== false, opacity: paint.opacity ?? 1,
        color: paint.color ?? null,
        gradientStops: (paint.gradientStops ?? paint.stops ?? []).slice(0, 12),
        imageHash: paintToImageHash(paint),
      });
      return {
        id: currentId, name: node.name, type: node.type, visible: node.visible !== false,
        childCount, bounds: { source: 'fig', x: scene.x ?? null, y: scene.y ?? null,
          width: scene.width ?? null, height: scene.height ?? null },
        layout: layoutEvidence(node, raw),
        component: componentEvidence(file, node, this.componentCounts),
        visualStyle: { source: 'fig', opacity: scene.opacity ?? 1, cornerRadius: scene.cornerRadius ?? null,
          strokeWeight: scene.strokeWeight ?? null, fills: (scene.fills ?? []).slice(0, 8).map(paintSummary),
          strokes: (scene.strokes ?? []).slice(0, 8).map(paintSummary),
          effects: (scene.effects ?? []).slice(0, 8) },
        ...(scene.characters ? { text: { source: 'fig', value: scene.characters } } : {}),
        ...(scene.style ? { typography: { source: 'fig', declaredFamily: declaredFont,
          size: scene.style.fontSize ?? null, weight: scene.style.fontWeight ?? null,
          previewFamily: resolveFontFamily(scene.style.fontFamily ?? 'Inter') } } : {}),
        ...(level < safeDepth ? { children } : {}),
      };
    };
    const assets = imageAssetHashes(root);
    const renderKey = this.renderKey;
    const url = (extension: 'svg' | 'png') => `/api/render/${encodeURIComponent(nodeId)}.${extension}?v=${encodeURIComponent(renderKey)}${extension === 'png' ? '&maxWidth=1600&maxHeight=1600' : ''}`;
    const theme = this.theme();
    return {
      file: { name: file.name, parser: file.parser, renderKey, nodeId, path: this.path(nodeId) },
      provenance: { fig: 'Value or relationship read from the .fig', inferred: 'Statistical grouping derived from observed values; not a declared variable' },
      node: describe(root, 0), hierarchy: { included, truncated, requestedDepth: safeDepth, limit: safeLimit },
      theme: {
        source: 'inferred' as const, tool: 'get_theme',
        colors: theme.colors.slice(0, 12).map(color => ({ source: 'inferred' as const, observedValueSource: 'fig' as const, ...color })),
        fonts: theme.typography.fonts.slice(0, 8).map(font => ({ source: 'inferred' as const, declaredFamilySource: 'fig' as const, ...font })),
        radii: theme.radii.slice(0, 8).map(radius => ({ source: 'inferred' as const, observedValueSource: 'fig' as const, ...radius })),
        spacing: theme.spacing.slice(0, 8).map(space => ({ ...space, source: 'inferred' as const,
          measurementMethod: space.source, observedValueSource: space.source === 'auto-layout' ? 'fig' as const : 'inferred' as const })),
      },
      assets: { source: 'fig' as const, scannedNodes: assets.scannedNodes, truncated: assets.truncated,
        total: assets.assets.length, resultsTruncated: assets.assets.length > 40,
        images: assets.assets.slice(0, 40).map(asset => ({ ...asset,
          available: file.images.has(asset.hash), bytes: file.images.getMeta(asset.hash)?.uncompressedSize ?? null,
          ...(referenceMode === 'http'
            ? { url: `/api/assets/${asset.hash}?v=${encodeURIComponent(renderKey)}` }
            : { assetTool: { name: 'get_image_asset', hash: asset.hash } }) })) },
      visualReferences: { source: 'rendered-from-fig' as const,
        ...(referenceMode === 'http' ? { svgUrl: url('svg'), pngUrl: url('png') }
          : { renderTool: { name: 'render_node', node_id: nodeId, include_svg: true } }),
        imageTool: { name: 'get_node_image', node_id: nodeId } },
      note: 'Constraints and auto layout appear only when declared in the file. This context does not suggest breakpoints or generate responsive code.',
    };
  }
}
