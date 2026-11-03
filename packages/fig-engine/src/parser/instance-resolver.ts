/**
 * Instance Resolver - Extracts and resolves INSTANCE content from symbolOverrides
 *
 * INSTANCE nodes in .fig files reference SYMBOL (component) definitions.
 * The actual content (text, colors, sizes) is stored in symbolOverrides,
 * which use internal guidPaths that don't map directly to tree node GUIDs.
 *
 * This module provides helpers to:
 * 1. Extract meaningful content from INSTANCE overrides
 * 2. Build a resolved representation for rendering/display
 */

import type { FigNode, SceneNode, GUID, Color, Paint, DerivedTextData, TextStyle } from "./types.js";
import { formatGUID } from "./kiwi-parser.js";

/** Extracted text content from an INSTANCE override */
export interface InstanceTextContent {
  text: string;
  guidPath: string;
  fillColor?: Color;
  fontSize?: number;
  fontFamily?: string;
}

/** Extracted visual element from an INSTANCE override */
export interface InstanceVisualElement {
  type: "text" | "rectangle";
  guidPath: string;
  text?: string;
  size?: { x: number; y: number };
  fillColor?: Color;
  strokeColor?: Color;
  cornerRadius?: number;
  fontSize?: number;
  fontFamily?: string;
}

/** Resolved instance content */
export interface ResolvedInstanceContent {
  /** The original INSTANCE node */
  instance: FigNode;
  /** GUID of the referenced SYMBOL */
  symbolId: string;
  /** All text content extracted from overrides */
  textContent: InstanceTextContent[];
  /** Visual elements (rects, text) with their properties */
  elements: InstanceVisualElement[];
  /** Size information from derivedSymbolData */
  sizes: Map<string, { x: number; y: number }>;
}

type OverrideData = {
  characters?: string;
  fillPaints?: unknown[];
  strokePaints?: unknown[];
  cornerRadius?: number;
  visible?: boolean;
  rectangleCornerRadius?: {
    topLeft?: number;
    topRight?: number;
    bottomRight?: number;
    bottomLeft?: number;
  };
  fontSize?: number;
  fontName?: Record<string, string>;
  textAlignHorizontal?: string;
  lineHeight?: { value?: number };
  textAutoResize?: string;
  maxLines?: number;
  textTruncation?: string;
  size?: { x: number; y: number };
  derivedTextData?: unknown;
  fillGeometry?: unknown;
  strokeGeometry?: unknown;
  transform?: { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number };
  componentPropAssignments?: Array<{ defId: string; characters?: string; visible?: boolean; symbolId?: GUID }>;
  overrideSymbolId?: GUID;
};

/**
 * Extract Color from a paint object
 */
function extractColor(paint: unknown): Color | undefined {
  if (!paint || typeof paint !== "object") return undefined;
  const p = paint as Record<string, unknown>;
  if (p.visible === false) return undefined;
  const color = p.color as Record<string, number> | undefined;
  if (!color) return undefined;
  return {
    r: color.r ?? 0,
    g: color.g ?? 0,
    b: color.b ?? 0,
    a: color.a ?? 1,
  };
}

function guidPathToString(path: unknown): string {
  const guids = (path as Record<string, unknown>)?.guids as unknown[] | undefined;
  if (!guids) return "";
  return guids
    .map((g: unknown) => {
      const guid = g as Record<string, number>;
      return `${guid.sessionID}:${guid.localID}`;
    })
    .join(">");
}

function parseGUID(value: unknown): GUID | undefined {
  if (!value || typeof value !== "object") return undefined;
  const guid = value as Record<string, unknown>;
  const sessionID = guid.sessionID;
  const localID = guid.localID;
  if (typeof sessionID !== "number" || typeof localID !== "number") return undefined;
  return { sessionID, localID };
}

type ComponentAssignment = { defId: string; characters?: string; visible?: boolean; symbolId?: GUID };

function parseComponentAssignment(value: unknown): ComponentAssignment | undefined {
  if (!value || typeof value !== "object") return undefined;
  const assignment = value as Record<string, unknown>;
  const def = parseGUID(assignment.defID);
  if (!def) return undefined;
  // Newer .fig files put the effective value in varValue; older files use value.
  const variable = assignment.varValue as Record<string, unknown> | undefined;
  const data = (variable?.value ?? assignment.value) as Record<string, unknown> | undefined;
  const textData = (data?.textDataValue ?? data?.textValue) as Record<string, unknown> | undefined;
  return {
    defId: formatGUID(def),
    characters: typeof textData?.characters === "string" ? textData.characters : undefined,
    visible: typeof data?.boolValue === "boolean" ? data.boolValue : undefined,
    symbolId: parseGUID((data?.symbolIdValue as Record<string, unknown> | undefined)?.guid ?? data?.guidValue),
  };
}

function buildOverridePathMap(
  root: FigNode,
  rawNodeIndex: Map<string, Record<string, unknown>>,
  nodeIndex: Map<string, FigNode>,
): Map<string, string> {
  const pathMap = new Map<string, string>();
  const symbolStack = new Set<string>();

  const walk = (node: FigNode, path: string[], instancePath: string[], skipOverrideKey: boolean): void => {
    const nodeId = formatGUID(node.guid);
    // derivedSymbolData commonly addresses a symbol child by its own GUID,
    // while symbolOverrides uses overrideKey-based paths. Accept both forms.
    pathMap.set(nodeId, nodeId);
    // Some .fig revisions use the actual GUID of each nested instance and
    // then the target child GUID instead of overrideKey values.
    pathMap.set([...instancePath, nodeId].join(">"), nodeId);
    const raw = rawNodeIndex.get(nodeId);
    const overrideKey = raw?.overrideKey as Record<string, number> | undefined;
    const overrideKeyString = overrideKey ? `${overrideKey.sessionID}:${overrideKey.localID}` : null;
    const nextPath = overrideKeyString && !skipOverrideKey ? [...path, overrideKeyString] : path;
    const nextInstancePath = node.type === "INSTANCE" ? [...instancePath, nodeId] : instancePath;

    if (overrideKeyString && !skipOverrideKey) {
      const fullPath = nextPath.join(">");
      pathMap.set(fullPath, nodeId);
      if (nextPath.length > 1) {
        pathMap.set(nextPath.slice(1).join(">"), nodeId);
      }
    }

    if (
      node.type === "INSTANCE" &&
      (node as SceneNode).symbolData?.symbolID
    ) {
      const symbolId = formatGUID((node as SceneNode).symbolData!.symbolID as GUID);
      const symbolNode = nodeIndex.get(symbolId);
      if (symbolNode?.children && !symbolStack.has(symbolId)) {
        symbolStack.add(symbolId);
        for (const child of symbolNode.children) {
          walk(child as FigNode, nextPath, nextInstancePath, false);
        }
        symbolStack.delete(symbolId);
      }
    }

    if (node.children) {
      for (const child of node.children) {
        walk(child as FigNode, nextPath, nextInstancePath, false);
      }
    }
  };

  walk(root, [], [], false);
  return pathMap;
}

function buildOverrideData(
  instance: FigNode,
  rawNodeChange: Record<string, unknown> | undefined,
  rawNodeIndex: Map<string, Record<string, unknown>>,
): Map<string, OverrideData> {
  const overrides = new Map<string, OverrideData>();
  const sceneNode = instance as SceneNode;
  const rawSymbolData = rawNodeChange?.symbolData as Record<string, unknown> | undefined;
  const symbolOverrides = (rawSymbolData?.symbolOverrides || sceneNode.symbolData?.symbolOverrides || []) as unknown[];
  const derivedSymbolData = (rawNodeChange?.derivedSymbolData || []) as unknown[];

  const upsert = (path: string): OverrideData => {
    if (!overrides.has(path)) {
      overrides.set(path, {});
    }
    return overrides.get(path)!;
  };

  for (const override of symbolOverrides) {
    if (!override || typeof override !== "object") continue;
    const o = override as Record<string, unknown>;
    const path = guidPathToString(o.guidPath);
    if (!path) continue;

    const entry = upsert(path);

    const textData = o.textData as Record<string, unknown> | undefined;
    if (typeof textData?.characters === "string") {
      entry.characters = textData.characters;
    } else if (typeof o.characters === "string") {
      entry.characters = o.characters;
    }
    if (typeof o.visible === "boolean") {
      entry.visible = o.visible;
    }
    if (Array.isArray(o.fillPaints)) {
      entry.fillPaints = o.fillPaints;
    }
    // A linked Figma color style is the effective paint. Some .fig files keep
    // an older inline fill alongside it (for example, pink on a dark icon).
    const fillStyleGuid = (o.styleIdForFill as { guid?: GUID } | undefined)?.guid;
    if (fillStyleGuid) {
      const style = rawNodeIndex.get(formatGUID(fillStyleGuid));
      if (Array.isArray(style?.fillPaints)) {
        entry.fillPaints = style.fillPaints;
      }
    }
    if (Array.isArray(o.strokePaints)) {
      entry.strokePaints = o.strokePaints;
    }
    const overriddenSymbolId = parseGUID(o.overriddenSymbolID);
    if (overriddenSymbolId) entry.overrideSymbolId = overriddenSymbolId;
    if (typeof o.cornerRadius === "number") {
      entry.cornerRadius = o.cornerRadius;
    }
    if (o.rectangleTopLeftCornerRadius || o.rectangleTopRightCornerRadius || o.rectangleBottomRightCornerRadius || o.rectangleBottomLeftCornerRadius) {
      entry.rectangleCornerRadius = {
        topLeft: o.rectangleTopLeftCornerRadius as number | undefined,
        topRight: o.rectangleTopRightCornerRadius as number | undefined,
        bottomRight: o.rectangleBottomRightCornerRadius as number | undefined,
        bottomLeft: o.rectangleBottomLeftCornerRadius as number | undefined,
      };
    }
    if (typeof o.fontSize === "number") {
      entry.fontSize = o.fontSize;
    }
    if (o.fontName && typeof o.fontName === "object") {
      entry.fontName = o.fontName as Record<string, string>;
    }
    if (typeof o.textAlignHorizontal === "string") {
      entry.textAlignHorizontal = o.textAlignHorizontal;
    }
    if (o.lineHeight && typeof o.lineHeight === "object") {
      entry.lineHeight = o.lineHeight as { value?: number };
    }
    if (typeof o.textAutoResize === "string") {
      entry.textAutoResize = o.textAutoResize;
    }
    if (typeof o.maxLines === "number") entry.maxLines = o.maxLines;
    if (typeof o.textTruncation === "string") entry.textTruncation = o.textTruncation;
    if (o.size && typeof o.size === "object") {
      const size = o.size as Record<string, number>;
      entry.size = { x: size.x ?? 0, y: size.y ?? 0 };
    }

    const propAssignments = o.componentPropAssignments as unknown[] | undefined;
    if (propAssignments) {
      for (const assign of propAssignments) {
        if (!assign || typeof assign !== "object") continue;
        const assignment = parseComponentAssignment(assign);
        if (assignment) {
          if (!entry.componentPropAssignments) entry.componentPropAssignments = [];
          entry.componentPropAssignments.push(assignment);
        } else {
          const raw = assign as Record<string, unknown>;
          const variable = raw.varValue as Record<string, unknown> | undefined;
          const data = (variable?.value ?? raw.value) as Record<string, unknown> | undefined;
          const text = (data?.textDataValue ?? data?.textValue) as Record<string, unknown> | undefined;
          if (typeof text?.characters === "string") entry.characters = text.characters;
        }
      }
    }
  }

  for (const derived of derivedSymbolData) {
    if (!derived || typeof derived !== "object") continue;
    const d = derived as Record<string, unknown>;
    const path = guidPathToString(d.guidPath);
    if (!path) continue;

    const entry = upsert(path);
    const pathIds = path.split(">");
    const scaledInstance = [formatGUID(instance.guid), ...pathIds].some(id => {
      const symbol = rawNodeIndex.get(id)?.symbolData as Record<string, unknown> | undefined;
      const scale = symbol?.uniformScaleFactor;
      return typeof scale === "number" && scale > 0 && scale !== 1;
    });
    const source = rawNodeIndex.get(pathIds[pathIds.length - 1]!);
    if (d.size && typeof d.size === "object" && !(scaledInstance && source?.size)) {
      const size = d.size as Record<string, number>;
      entry.size = { x: size.x ?? 0, y: size.y ?? 0 };
    }
    if (d.derivedTextData && !(scaledInstance && source?.derivedTextData)) {
      entry.derivedTextData = d.derivedTextData;
    }
    // Derived paths inside scaled instances have already been shrunk by Figma.
    // Use the authored path with the instance transform to avoid scaling twice.
    if (d.fillGeometry && !(scaledInstance && Array.isArray(source?.fillGeometry) && source.fillGeometry.length > 0)) {
      entry.fillGeometry = d.fillGeometry;
    }
    if (d.strokeGeometry && !(scaledInstance && Array.isArray(source?.strokeGeometry) && source.strokeGeometry.length > 0)) {
      entry.strokeGeometry = d.strokeGeometry;
    }
    if (d.transform && typeof d.transform === "object" && !(scaledInstance && source?.transform)) {
      const t = d.transform as Record<string, number>;
      entry.transform = {
        m00: t.m00 ?? 1,
        m01: t.m01 ?? 0,
        m02: t.m02 ?? 0,
        m10: t.m10 ?? 0,
        m11: t.m11 ?? 1,
        m12: t.m12 ?? 0,
      };
    }
  }

  return overrides;
}

function applyOverrideToNode(node: SceneNode, override: OverrideData): void {
  if (override.characters !== undefined) {
    node.characters = override.characters;
  }
  if (override.fillPaints) {
    node.fills = override.fillPaints as Paint[];
  }
  if (override.strokePaints) {
    node.strokes = override.strokePaints as Paint[];
  }
  if (override.cornerRadius !== undefined) {
    node.cornerRadius = override.cornerRadius;
  } else if (override.rectangleCornerRadius) {
    node.cornerRadius = {
      topLeft: override.rectangleCornerRadius.topLeft ?? 0,
      topRight: override.rectangleCornerRadius.topRight ?? 0,
      bottomRight: override.rectangleCornerRadius.bottomRight ?? 0,
      bottomLeft: override.rectangleCornerRadius.bottomLeft ?? 0,
    };
  }
  if (override.size) {
    node.width = override.size.x;
    node.height = override.size.y;
    node.size = { x: override.size.x, y: override.size.y };
  }
  if (override.derivedTextData) {
    node.derivedTextData = override.derivedTextData as unknown as DerivedTextData;
  }
  if (override.fillGeometry) {
    node.fillGeometry = override.fillGeometry as unknown as SceneNode["fillGeometry"];
  }
  if (override.strokeGeometry) {
    node.strokeGeometry = override.strokeGeometry as unknown as SceneNode["strokeGeometry"];
  }
  if (override.transform) {
    node.transform = override.transform;
  }
  if (override.visible !== undefined) {
    node.visible = override.visible;
  }
  if (override.maxLines !== undefined) node.maxLines = override.maxLines;
  if (override.textTruncation !== undefined) node.textTruncation = override.textTruncation;
  if (override.overrideSymbolId) {
    // The clone initially shares symbolData with its source node. Replacing a
    // variant must not change that source for subsequent page renders.
    node.symbolData = { ...node.symbolData, symbolID: override.overrideSymbolId };
    node.children = undefined;
  }

  if (
    override.fontName ||
    override.fontSize !== undefined ||
    override.lineHeight?.value !== undefined ||
    override.textAutoResize
  ) {
    const style: Partial<TextStyle> = { ...(node.style ?? {}) };
    if (override.fontName?.family) {
      style.fontFamily = override.fontName.family;
    }
    if (override.fontSize !== undefined) {
      style.fontSize = override.fontSize;
    }
    if (
      override.textAlignHorizontal === "LEFT" ||
      override.textAlignHorizontal === "CENTER" ||
      override.textAlignHorizontal === "RIGHT" ||
      override.textAlignHorizontal === "JUSTIFIED"
    ) {
      style.textAlignHorizontal = override.textAlignHorizontal;
    }
    if (override.lineHeight?.value !== undefined) {
      style.lineHeightPx = override.lineHeight.value;
    }
    if (
      override.textAutoResize === "NONE" ||
      override.textAutoResize === "HEIGHT" ||
      override.textAutoResize === "WIDTH_AND_HEIGHT" ||
      override.textAutoResize === "TRUNCATE"
    ) {
      style.textAutoResize = override.textAutoResize;
    }
    node.style = style as TextStyle;
  }
}

function applyComponentPropAssignments(
  instanceNodeId: string,
  assignments: Array<{ defId: string; characters?: string; visible?: boolean; symbolId?: GUID }>,
  nodeIndex: Map<string, FigNode>,
  rawNodeIndex: Map<string, Record<string, unknown>>,
  overrideByNodeId: Map<string, OverrideData>,
  selectedSymbolId?: GUID,
): void {
  const instanceNode = nodeIndex.get(instanceNodeId) as SceneNode | undefined;
  if (!instanceNode?.symbolData?.symbolID) return;

  // A parent instance may swap this nested instance to another component
  // variant. Its property IDs then refer to the chosen variant, not the
  // nested instance's original symbol.
  const symbolId = formatGUID(
    selectedSymbolId
      ?? overrideByNodeId.get(instanceNodeId)?.overrideSymbolId
      ?? instanceNode.symbolData.symbolID as GUID,
  );
  const symbolNode = nodeIndex.get(symbolId);
  if (!symbolNode) return;

  const byDefId = new Map<string, { characters?: string; visible?: boolean; symbolId?: GUID }>();
  for (const assign of assignments) {
    byDefId.set(assign.defId, {
      characters: assign.characters,
      visible: assign.visible,
      symbolId: assign.symbolId,
    });
  }
  const referencedDefs = new Set<string>();

  const walk = (node: FigNode): void => {
    const nodeId = formatGUID(node.guid);
    const raw = rawNodeIndex.get(nodeId);
    const refs = raw?.componentPropRefs as Array<Record<string, unknown>> | undefined;
    if (refs) {
      for (const ref of refs) {
        const def = ref.defID as Record<string, number> | undefined;
        if (!def) continue;
        const defId = `${def.sessionID}:${def.localID}`;
        const assignment = byDefId.get(defId);
        if (assignment) {
          referencedDefs.add(defId);
          const existing = overrideByNodeId.get(nodeId) ?? {};
          if (ref.componentPropNodeField === "TEXT_DATA" && assignment.characters !== undefined) {
            overrideByNodeId.set(nodeId, { ...existing, characters: assignment.characters });
          } else if (ref.componentPropNodeField === "VISIBLE" && assignment.visible !== undefined) {
            overrideByNodeId.set(nodeId, { ...existing, visible: assignment.visible });
          } else if (ref.componentPropNodeField === "OVERRIDDEN_SYMBOL_ID" && assignment.symbolId) {
            overrideByNodeId.set(nodeId, { ...existing, overrideSymbolId: assignment.symbolId });
          }
        }
      }
    }
    if (node.children) {
      for (const child of node.children) {
        walk(child as FigNode);
      }
    }
  };

  walk(symbolNode);

  // Some exported components declare a text property and its default value
  // but omit componentPropRefs on the text layer. Match the original text only
  // when it identifies a single descendant in that component definition.
  const definitions = (rawNodeIndex.get(symbolId)?.componentPropDefs as Array<Record<string, unknown>> | undefined) ?? [];
  for (const [defId, assignment] of byDefId) {
    if (assignment.characters === undefined || referencedDefs.has(defId)) continue;
    const definition = definitions.find(def => {
      const id = parseGUID(def.id);
      return id && formatGUID(id) === defId;
    });
    if (!definition) continue;
    const value = (definition.varValue as Record<string, unknown> | undefined)?.value as Record<string, unknown> | undefined;
    const initial = definition.initialValue as Record<string, unknown> | undefined;
    const original = ((value?.textDataValue ?? initial?.textValue) as Record<string, unknown> | undefined)?.characters;
    const texts: FigNode[] = [];
    const collect = (node: FigNode): void => {
      if (node.type === "TEXT") texts.push(node);
      for (const child of node.children ?? []) collect(child as FigNode);
    };
    collect(symbolNode);
    const defaultMatches = typeof original === "string" && original.length > 0
      ? texts.filter(node => (node as SceneNode).characters === original) : [];
    // In some component sets the variant's property def has only a parent ID.
    // Its text layer still retains the originating session ID. Use that link
    // only when it identifies exactly one text layer in this symbol.
    const defGuid = parseGUID(definition.id);
    const sessionMatches = defGuid
      ? texts.filter(node => node.guid.sessionID === defGuid.sessionID) : [];
    const match = defaultMatches.length === 1 ? defaultMatches[0]
      : sessionMatches.length === 1 ? sessionMatches[0] : undefined;
    if (!match) continue;
    const nodeId = formatGUID(match.guid);
    overrideByNodeId.set(nodeId, { ...overrideByNodeId.get(nodeId), characters: assignment.characters });
  }
}

function cloneWithOverrides(
  node: FigNode,
  overrideByNodeId: Map<string, OverrideData>,
  nodeIndex: Map<string, FigNode>,
  rawNodeIndex: Map<string, Record<string, unknown>>,
  symbolStack: Set<string>,
): FigNode {
  const nodeId = formatGUID(node.guid);
  const clone = { ...node } as FigNode;
  const override = overrideByNodeId.get(nodeId);
  if (override) {
    applyOverrideToNode(clone as SceneNode, override);
  }
  let children = "children" in clone ? clone.children : undefined;
  let expandedSymbolId: string | null = null;
  if (
    (!children || children.length === 0) &&
    clone.type === "INSTANCE" &&
    (clone as SceneNode).symbolData?.symbolID
  ) {
    const symbolId = formatGUID((clone as SceneNode).symbolData!.symbolID as GUID);
    const symbolNode = nodeIndex.get(symbolId);
    if (symbolNode?.children && !symbolStack.has(symbolId)) {
      symbolStack.add(symbolId);
      expandedSymbolId = symbolId;
      // A nested instance carries its own text, visibility and variant
      // assignments. Resolve them before applying overrides from its parent.
      children = resolveInstanceChildren(
        clone, symbolNode, rawNodeIndex, nodeIndex, symbolStack,
        override?.componentPropAssignments,
      )
        ?? symbolNode.children as FigNode[];
    }
  }

  if (children && children.length > 0) {
    clone.children = children.map(child =>
      cloneWithOverrides(child as FigNode, overrideByNodeId, nodeIndex, rawNodeIndex, symbolStack)
    );
  }
  if (expandedSymbolId) {
    symbolStack.delete(expandedSymbolId);
  }
  return clone;
}

type PropertyDefinition = { name?: string; parentId?: string };
const propertyDefinitionCache = new WeakMap<Map<string, Record<string, unknown>>, Map<string, PropertyDefinition>>();

function propertyDefinitions(rawNodeIndex: Map<string, Record<string, unknown>>): Map<string, PropertyDefinition> {
  const cached = propertyDefinitionCache.get(rawNodeIndex);
  if (cached) return cached;
  const definitions = new Map<string, PropertyDefinition>();
  for (const raw of rawNodeIndex.values()) {
    for (const entry of (raw.componentPropDefs as unknown[] | undefined) ?? []) {
      const def = entry as Record<string, unknown>;
      const id = parseGUID(def.id);
      if (!id) continue;
      const parent = parseGUID(def.parentPropDefId);
      definitions.set(formatGUID(id), {
        name: typeof def.name === "string" ? def.name : undefined,
        parentId: parent ? formatGUID(parent) : undefined,
      });
    }
  }
  propertyDefinitionCache.set(rawNodeIndex, definitions);
  return definitions;
}

function propertyName(defId: string, definitions: Map<string, PropertyDefinition>): string | undefined {
  const seen = new Set<string>();
  let current: string | undefined = defId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const definition: PropertyDefinition | undefined = definitions.get(current);
    if (definition?.name) return definition.name;
    current = definition?.parentId;
  }
  return undefined;
}

function normalizePropertyLabel(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function hidesNamedPart(node: FigNode, target: string): boolean {
  const name = normalizePropertyLabel(node.name ?? "");
  if (name && (name === target || name.includes(target) || (name.length >= 4 && target.includes(name)))) return true;
  if (node.type === "TEXT") {
    const text = normalizePropertyLabel((node as SceneNode).characters ?? "");
    return !!text && (text === target || text.startsWith(`${target} `) || (target.length >= 5 && text.startsWith(target)));
  }
  if (node.type === "INSTANCE") {
    const walk = (child: FigNode): boolean => {
      if (child.type === "TEXT") {
        const text = normalizePropertyLabel((child as SceneNode).characters ?? "");
        if (text === target || text.startsWith(`${target} `) || (target.length >= 5 && text.startsWith(target))) return true;
      }
      return (child.children ?? []).some(grandchild => walk(grandchild as FigNode));
    };
    return (node.children ?? []).some(child => walk(child as FigNode));
  }
  return false;
}

/** Resolve properties whose exported component definition omits node refs. */
function applyUnboundProperties(
  symbol: FigNode,
  assignments: ComponentAssignment[],
  rawNodeIndex: Map<string, Record<string, unknown>>,
  nodeIndex: Map<string, FigNode>,
): void {
  if (!assignments.length) return;
  const definitions = propertyDefinitions(rawNodeIndex);
  for (const assignment of assignments) {
    if (assignment.visible === undefined && !assignment.symbolId) continue;
    const name = propertyName(assignment.defId, definitions);
    if (!name) continue;
    const target = normalizePropertyLabel(name).replace(/^show /, "");
    if (target.length < 3) continue;
    if (assignment.visible === false) {
      const hide = (node: FigNode): void => {
        if ((node.type === "INSTANCE" || node.type === "TEXT") && hidesNamedPart(node, target)) {
          node.visible = false;
          return;
        }
        for (const child of node.children ?? []) hide(child as FigNode);
      };
      for (const child of symbol.children ?? []) hide(child as FigNode);
    }
    if (assignment.visible === true) {
      const compactTarget = target.replace(/\s+/g, "");
      const show = (node: FigNode): void => {
        if (node.type === "INSTANCE"
          && normalizePropertyLabel(node.name ?? "").replace(/\s+/g, "") === compactTarget) {
          node.visible = true;
          return;
        }
        for (const child of node.children ?? []) show(child as FigNode);
      };
      for (const child of symbol.children ?? []) show(child as FigNode);
    }
    if (assignment.symbolId) {
      const matches: FigNode[] = [];
      const collect = (node: FigNode): void => {
        if (node.type === "INSTANCE" && normalizePropertyLabel(node.name ?? "") === target) {
          matches.push(node);
          return;
        }
        for (const child of node.children ?? []) collect(child as FigNode);
      };
      for (const child of symbol.children ?? []) collect(child as FigNode);
      if (matches.length !== 1) continue;
      const targetNode = matches[0] as SceneNode;
      const chosen = nodeIndex.get(formatGUID(assignment.symbolId));
      if (!chosen) continue;
      targetNode.symbolData = { ...targetNode.symbolData, symbolID: assignment.symbolId };
      targetNode.children = resolveInstanceChildren(targetNode, chosen, rawNodeIndex, nodeIndex) ?? [];
    }
  }
}

/**
 * Resolve INSTANCE children by cloning the symbol subtree and applying overrides.
 */
export function resolveInstanceChildren(
  instance: FigNode,
  symbolNode: FigNode,
  rawNodeIndex: Map<string, Record<string, unknown>>,
  nodeIndex: Map<string, FigNode>,
  symbolStack = new Set<string>(),
  inheritedAssignments: ComponentAssignment[] = [],
): FigNode[] | null {
  // Prefer raw node for override/path mapping; if missing, still expand from symbol.
  const instanceRaw = rawNodeIndex.get(formatGUID(instance.guid));
  const overrideData = instanceRaw
    ? buildOverrideData(instance, instanceRaw, rawNodeIndex)
    : new Map<string, OverrideData>();
  // Always expand symbol children — empty overrides still clone the symbol tree.
  // Previously returned null when overrideData/overrideByNodeId were empty, which
  // dropped INSTANCE content for components with no overrides.

  const pathMap = buildOverridePathMap(symbolNode, rawNodeIndex, nodeIndex);
  const overrideByNodeId = new Map<string, OverrideData>();

  const overriddenVariantChild = (path: string): string | undefined => {
    const separator = path.lastIndexOf(">");
    if (separator < 0) return undefined;
    const parentOverride = overrideData.get(path.slice(0, separator));
    const variantId = parentOverride?.overrideSymbolId;
    if (!variantId) return undefined;
    const variant = nodeIndex.get(formatGUID(variantId));
    const targetId = path.slice(separator + 1);
    const contains = (node: FigNode): boolean => formatGUID(node.guid) === targetId
      || (node.children ?? []).some(child => contains(child as FigNode));
    return variant && contains(variant) ? targetId : undefined;
  };

  for (const [path, data] of overrideData.entries()) {
    // A variant swap can introduce descendants absent from the base symbol.
    // Resolve those child overrides against the chosen variant definition.
    const nodeId = pathMap.get(path) ?? overriddenVariantChild(path);
    if (!nodeId) continue;
    const existing = overrideByNodeId.get(nodeId);
    overrideByNodeId.set(nodeId, existing ? { ...existing, ...data } : data);
  }

  const assignments = [
    ...((instanceRaw?.componentPropAssignments as unknown[] | undefined) ?? [])
      .map(parseComponentAssignment).filter((value): value is ComponentAssignment => !!value),
    ...inheritedAssignments,
  ];
  if (assignments.length > 0) {
    applyComponentPropAssignments(
      formatGUID(instance.guid), assignments, nodeIndex, rawNodeIndex,
      overrideByNodeId, symbolNode.guid,
    );
  }

  // If symbol has no children, nothing to expand
  if (!symbolNode.children || symbolNode.children.length === 0) {
    return null;
  }

  const clonedSymbol = cloneWithOverrides(symbolNode, overrideByNodeId, nodeIndex, rawNodeIndex, symbolStack);
  applyUnboundProperties(clonedSymbol, assignments, rawNodeIndex, nodeIndex);
  const applyNestedProperties = (node: FigNode): void => {
    const assignments = overrideByNodeId.get(formatGUID(node.guid))?.componentPropAssignments;
    if (assignments?.length) applyUnboundProperties(node, assignments, rawNodeIndex, nodeIndex);
    for (const child of node.children ?? []) applyNestedProperties(child as FigNode);
  };
  for (const child of clonedSymbol.children ?? []) applyNestedProperties(child as FigNode);
  return clonedSymbol.children ? (clonedSymbol.children as FigNode[]) : null;
}

/**
 * Extract content from an INSTANCE node's symbolOverrides
 */
export function extractInstanceContent(
  instance: FigNode,
  rawNodeChange?: Record<string, unknown>
): ResolvedInstanceContent | null {
  const sceneNode = instance as SceneNode;
  const symbolData = sceneNode.symbolData;

  if (!symbolData?.symbolID) {
    return null;
  }

  const symbolId = formatGUID(symbolData.symbolID as GUID);
  const textContent: InstanceTextContent[] = [];
  const elements: InstanceVisualElement[] = [];
  const sizes = new Map<string, { x: number; y: number }>();

  // Get raw symbolOverrides and derivedSymbolData
  const rawSymbolData = rawNodeChange?.symbolData as Record<string, unknown> | undefined;
  const symbolOverrides = (rawSymbolData?.symbolOverrides || symbolData.symbolOverrides || []) as unknown[];
  const derivedSymbolData = (rawNodeChange?.derivedSymbolData || []) as unknown[];

  // Extract sizes from derivedSymbolData
  for (const derived of derivedSymbolData) {
    if (!derived || typeof derived !== "object") continue;
    const d = derived as Record<string, unknown>;
    const guids = (d.guidPath as Record<string, unknown>)?.guids as unknown[] | undefined;
    const size = d.size as Record<string, number> | undefined;

    if (guids && size) {
      const path = guids.map((g: unknown) => {
        const guid = g as Record<string, number>;
        return `${guid.sessionID}:${guid.localID}`;
      }).join(">");
      sizes.set(path, { x: size.x, y: size.y });
    }
  }

  // Extract content from symbolOverrides
  for (const override of symbolOverrides) {
    if (!override || typeof override !== "object") continue;
    const o = override as Record<string, unknown>;

    const guidPath = guidPathToString(o.guidPath);

    // Extract text from componentPropAssignments
    const propAssignments = o.componentPropAssignments as unknown[] | undefined;
    if (propAssignments) {
      for (const assign of propAssignments) {
        if (!assign || typeof assign !== "object") continue;
        const a = assign as Record<string, unknown>;
        const value = a.value as Record<string, unknown> | undefined;
        const textValue = value?.textValue as Record<string, unknown> | undefined;
        const characters = textValue?.characters as string | undefined;

        if (characters) {
          // Get fill color for this text if available
          const fills = o.fillPaints as unknown[] | undefined;
          const fillColor = fills?.[0] ? extractColor(fills[0]) : undefined;

          textContent.push({
            text: characters,
            guidPath,
            fillColor,
          });

          // Also add as visual element
          const size = sizes.get(guidPath);
          elements.push({
            type: "text",
            guidPath,
            text: characters,
            size,
            fillColor,
            fontSize: o.fontSize as number | undefined,
            fontFamily: (o.fontName as Record<string, string> | undefined)?.family,
          });
        }
      }
    }

    // Extract direct text override (characters field)
    if (o.characters && typeof o.characters === "string") {
      const fills = o.fillPaints as unknown[] | undefined;
      const fillColor = fills?.[0] ? extractColor(fills[0]) : undefined;

      textContent.push({
        text: o.characters as string,
        guidPath,
        fillColor,
      });
    }

    // Extract rectangle/frame overrides (fills, strokes, cornerRadius)
    const fillPaints = o.fillPaints as unknown[] | undefined;
    const strokePaints = o.strokePaints as unknown[] | undefined;
    const cornerRadius = o.cornerRadius as number | undefined;

    if ((fillPaints || strokePaints) && !propAssignments) {
      const fillColor = fillPaints?.[0] ? extractColor(fillPaints[0]) : undefined;
      const strokeColor = strokePaints?.[0] ? extractColor(strokePaints[0]) : undefined;
      const size = sizes.get(guidPath);

      if (fillColor || strokeColor) {
        elements.push({
          type: "rectangle",
          guidPath,
          size,
          fillColor,
          strokeColor,
          cornerRadius,
        });
      }
    }
  }

  // Also extract from top-level componentPropAssignments
  const topLevelAssignments = rawNodeChange?.componentPropAssignments as unknown[] | undefined;
  if (topLevelAssignments) {
    for (const assign of topLevelAssignments) {
      if (!assign || typeof assign !== "object") continue;
      const a = assign as Record<string, unknown>;
      const value = a.value as Record<string, unknown> | undefined;
      const textValue = value?.textValue as Record<string, unknown> | undefined;
      const characters = textValue?.characters as string | undefined;

      if (characters) {
        textContent.push({
          text: characters,
          guidPath: "top-level",
        });
      }
    }
  }

  return {
    instance,
    symbolId,
    textContent,
    elements,
    sizes,
  };
}

/**
 * Get a flat list of all text content in an INSTANCE
 */
export function getInstanceTextList(resolved: ResolvedInstanceContent): string[] {
  return resolved.textContent.map(t => t.text);
}

/**
 * Format instance content for display
 */
export function formatInstanceContent(resolved: ResolvedInstanceContent): string {
  const lines: string[] = [];
  lines.push(`INSTANCE of ${resolved.symbolId}`);

  if (resolved.textContent.length > 0) {
    lines.push("Text content:");
    for (const text of resolved.textContent) {
      lines.push(`  - "${text.text}"`);
    }
  }

  if (resolved.elements.length > 0) {
    lines.push("Visual elements:");
    for (const el of resolved.elements) {
      if (el.type === "text") {
        const sizeStr = el.size ? ` [${el.size.x}x${el.size.y}]` : "";
        lines.push(`  - Text: "${el.text}"${sizeStr}`);
      } else {
        const sizeStr = el.size ? ` [${el.size.x}x${el.size.y}]` : "";
        lines.push(`  - Rectangle${sizeStr}`);
      }
    }
  }

  return lines.join("\n");
}
