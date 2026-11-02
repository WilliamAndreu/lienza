/**
 * True geometry helpers — decode Figma baked path commands from .fig blobs.
 * Source of truth: fillGeometry / strokeGeometry commandsBlob (or commands array).
 * Agents must never invent path `d` data; always export via these helpers.
 */

import type { SceneNode, VectorPath, Paint } from "../parser/types.js";
import type { BlobEntry, PathCommand, TransformMatrix } from "../renderer/render-types.js";
import { IDENTITY_TRANSFORM } from "../renderer/render-types.js";
import { buildSvgPath } from "../renderer/render-utils.js";
import { getPaints, getVisiblePaint } from "../renderer/paint-utils.js";

/** Soft ceiling for vector-network vertex/segment counts (was 1000 — dropped complex icons). */
export const VECTOR_NETWORK_MAX_ELEMENTS = 500_000;

const CMD_ARG_COUNTS: Readonly<Record<number, number>> = {
  0: 0, // Z
  1: 2, // M
  2: 2, // L
  3: 4, // Q
  4: 6, // C
  5: 4, // Q (alt)
};

/**
 * Decode path commands from raw commandsBlob bytes (no blob index / ctx required).
 * Format: repeating [cmd:u8][args:float32 LE × N]
 */
export function decodeCommandsBlob(bytes: Uint8Array): PathCommand[] {
  if (bytes.length === 0) return [];

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const commands: PathCommand[] = [];
  let offset = 0;

  while (offset < bytes.length) {
    const cmd = bytes[offset++];
    const argCount = CMD_ARG_COUNTS[cmd];
    if (argCount === undefined) break;

    const values: number[] = [];
    for (let i = 0; i < argCount && offset + 4 <= bytes.length; i++) {
      values.push(view.getFloat32(offset, true));
      offset += 4;
    }
    if (values.length < argCount && argCount > 0) break;
    commands.push({ cmd, values });
  }

  return commands;
}

/**
 * Decode path commands from the array form stored on some nodes
 * (["M", x, y, "L", x2, y2, "Z", ...]).
 */
export function decodeCommandsArray(commands: unknown[] | undefined): PathCommand[] {
  if (!commands?.length) return [];

  const cmdMap: Record<string, number> = { M: 1, L: 2, Q: 3, C: 4, Z: 0 };
  const argCounts: Record<number, number> = { 0: 0, 1: 2, 2: 2, 3: 4, 4: 6 };

  const result: PathCommand[] = [];
  let currentCmd: number | null = null;
  let buffer: number[] = [];

  for (const entry of commands) {
    if (typeof entry === "string") {
      const mapped = cmdMap[entry.toUpperCase()];
      if (mapped === undefined) continue;
      if (mapped === 0) {
        result.push({ cmd: 0, values: [] });
        currentCmd = null;
        buffer = [];
        continue;
      }
      currentCmd = mapped;
      buffer = [];
    } else if (typeof entry === "number" && currentCmd !== null) {
      buffer.push(entry);
      const expected = argCounts[currentCmd] ?? 0;
      if (buffer.length === expected) {
        result.push({ cmd: currentCmd, values: buffer });
        buffer = [];
      }
    }
  }

  return result;
}

/**
 * Build SVG path `d` from decoded commands, optionally applying a transform.
 */
export function geometryToSvgPathD(
  commands: PathCommand[],
  transform: TransformMatrix = IDENTITY_TRANSFORM,
): string {
  if (commands.length === 0) return "";
  return buildSvgPath(commands, transform);
}

export type GeometryPathKind = "fill" | "stroke";

export interface GeometryPathEntry {
  kind: GeometryPathKind;
  d: string;
  windingRule?: string;
  paint?: Paint;
  paints?: Paint[];
  commands: PathCommand[];
}

function resolvePathCommands(
  path: VectorPath,
  blobs: BlobEntry[] | undefined,
): PathCommand[] {
  if (typeof path.commandsBlob === "number" && blobs?.[path.commandsBlob]?.bytes) {
    return decodeCommandsBlob(blobs[path.commandsBlob].bytes);
  }
  if (path.commands?.length) {
    return decodeCommandsArray(path.commands);
  }
  return [];
}

/**
 * Extract fill/stroke path data from a node's baked Figma geometry only
 * (fillGeometry / strokeGeometry → commandsBlob or commands).
 */
export function nodeFillStrokePaths(
  node: SceneNode,
  blobs: BlobEntry[] | undefined,
  transform: TransformMatrix = IDENTITY_TRANSFORM,
): GeometryPathEntry[] {
  const out: GeometryPathEntry[] = [];
  const fills = getPaints(node as never, "fills") ?? [];
  const strokes = getPaints(node as never, "strokes") ?? [];
  const overrides = (node.vectorData?.styleOverrideTable ?? []) as Array<{
    styleID?: number; fillPaints?: Paint[]; strokePaints?: Paint[];
  }>;
  const pathPaints = (styleID: number | undefined, kind: "fill" | "stroke", defaults: Paint[]): Paint[] => {
    if (!styleID) return defaults;
    const override = overrides.find(entry => entry.styleID === styleID);
    return (kind === "fill" ? override?.fillPaints : override?.strokePaints) ?? defaults;
  };

  if (node.fillGeometry?.length) {
    for (let i = 0; i < node.fillGeometry.length; i++) {
      const path = node.fillGeometry[i];
      const commands = resolvePathCommands(path, blobs);
      if (commands.length === 0) continue;
      const d = geometryToSvgPathD(commands, transform);
      if (!d) continue;
      out.push({
        kind: "fill",
        d,
        windingRule: path.windingRule,
        paints: pathPaints(path.styleID, "fill", fills),
        paint: getVisiblePaint(pathPaints(path.styleID, "fill", fills)),
        commands,
      });
    }
  }

  if (node.strokeGeometry?.length) {
    for (let i = 0; i < node.strokeGeometry.length; i++) {
      const path = node.strokeGeometry[i];
      const commands = resolvePathCommands(path, blobs);
      if (commands.length === 0) continue;
      const d = geometryToSvgPathD(commands, transform);
      if (!d) continue;
      out.push({
        kind: "stroke",
        d,
        windingRule: path.windingRule,
        paints: pathPaints(path.styleID, "stroke", strokes),
        paint: getVisiblePaint(pathPaints(path.styleID, "stroke", strokes)),
        commands,
      });
    }
  }

  return out;
}

/**
 * Encode PathCommand[] to commandsBlob bytes (test / round-trip helper).
 */
export function encodeCommandsBlob(commands: PathCommand[]): Uint8Array {
  let size = 0;
  for (const { cmd, values } of commands) {
    size += 1 + values.length * 4;
  }
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const { cmd, values } of commands) {
    bytes[offset++] = cmd;
    for (const v of values) {
      view.setFloat32(offset, v, true);
      offset += 4;
    }
  }
  return bytes;
}
