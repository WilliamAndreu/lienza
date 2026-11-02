/**
 * Asset pack exporter — the agent packaging tool.
 * Writes REAL geometry SVGs, image binaries, design specs, and AGENTS.md policy.
 * Agents MUST use these files; never invent SVG path data.
 */

import { mkdir, writeFile } from "fs/promises";
import { join, basename } from "path";
import type { FigNode, SceneNode, DocumentNode } from "../parser/types.js";
import type { ImageStore } from "../parser/fig-reader.js";
import { formatGUID } from "../parser/kiwi-parser.js";
import { buildDesignSpec } from "./design-spec.js";
import { exportNodeTrueSvg, type TrueSvgOptions } from "./true-svg.js";
import { nodeFillStrokePaths } from "./geometry.js";
import { generateScreenshot } from "../renderer/screenshot.js";
import { prepareSvgFonts } from "../font-catalog.js";
import {
  detectImageFormat,
  getPaints,
  paintToImageHash,
} from "../renderer/paint-utils.js";
import type { BlobEntry } from "../renderer/render-types.js";

async function screenshotWithEmbeddedAssets(node: FigNode, options: TrueSvgOptions) {
  const svg = exportNodeTrueSvg(node, {
    ...options,
    imageResolver: { allowBase64: true },
  }).svg;
  return generateScreenshot(svg, {
    pixelPerfect: true,
    scale: 1,
    fontFiles: prepareSvgFonts(svg).fontFiles,
  });
}

export interface ExportAssetPackOptions {
  filePath: string;
  outputDir: string;
  nodeId?: string;
  maxDepth?: number;
  maxNodes?: number;
  includeImages?: boolean;
  includeVectors?: boolean;
  includeScreens?: boolean;
  includeSpecs?: boolean;
  /** Pre-parsed document pieces (when called from MCP cache) */
  document?: FigNode;
  images?: ImageStore;
  blobs?: BlobEntry[];
  nodeIndex?: Map<string, FigNode>;
  rawNodeIndex?: Map<string, Record<string, unknown>>;
  sourceFig?: string;
}

export interface AssetPackNodeEntry {
  id: string;
  name: string;
  type: string;
  paths: {
    svg?: string;
    png?: string;
    spec?: string;
    meta?: string;
    assets?: string;
  };
  images: string[];
  vectors: string[];
}

export interface AssetPackImageEntry {
  hash: string;
  path: string;
  byteLength: number;
  format: string;
}

export interface AssetPackManifest {
  version: 1;
  sourceFig: string;
  exportedAt: string;
  policy: string;
  nodes: AssetPackNodeEntry[];
  images: AssetPackImageEntry[];
  totals: {
    nodes: number;
    images: number;
    vectors: number;
    screens: number;
  };
}

const POLICY =
  "Agents MUST use these exported files. Do NOT redraw SVG paths or guess icons. Reference relative paths under this pack.";

const AGENTS_MD = `# AGENTS — Design Asset Pack Rules (MANDATORY)

## HARD RULES — READ BEFORE IMPLEMENTING UI

1. **You MUST NOT invent, approximate, or hand-write SVG path \`d\` attributes** for design assets from this pack.
2. **Always \`read\` / \`copy\` files under this pack**:
   - \`images/{hash}.{ext}\` — real binary images from the .fig store
   - \`vectors/*__*.svg\` — true geometry single-node vectors from Figma baked paths
   - \`nodes/*/node.svg\` — true-geometry composite of that node subtree
   - \`nodes/*/node.png\` — raster ground truth (pixel-perfect of true SVG)
3. **Implement UI with HTML/CSS + imported assets** (img src, background-image, inline SVG file contents). Never regenerate icon paths from memory or vision.
4. **Text copy** comes from \`design-spec.json\` \`text\` array — use exact characters.
5. **If an asset is missing**, re-run \`export_asset_pack\` / \`export_node_assets\` — do not draw a substitute path.
6. **Screenshots** (\`node.png\`) are ground truth for layout/color. Open the file; do not redraw.

## Policy

${POLICY}

## Manifest

See \`MANIFEST.json\` for the complete index of nodeId → relative file paths.
`;

function sanitizeFilePart(name: string): string {
  return name.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "node";
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

function guessExtFromBytes(data: Uint8Array): string {
  const fmt = detectImageFormat(data);
  switch (fmt) {
    case "jpeg":
      return ".jpg";
    case "png":
      return ".png";
    case "gif":
      return ".gif";
    case "webp":
      return ".webp";
    default:
      return ".bin";
  }
}

function collectImageHashes(node: FigNode, out: Set<string>): void {
  const scene = node as SceneNode;
  const paints = [
    ...(getPaints(node, "fills") ?? []),
    ...(getPaints(node, "strokes") ?? []),
  ];
  for (const paint of paints) {
    const hash = paintToImageHash(paint);
    if (hash) out.add(hash.toLowerCase());
    if (paint.type === "IMAGE" && paint.imageRef) {
      out.add(paint.imageRef.toLowerCase());
    }
  }
  if (node.children) {
    for (const c of node.children) collectImageHashes(c as FigNode, out);
  }
}

function collectVectorCandidates(
  node: FigNode,
  out: FigNode[],
  max: number,
): void {
  if (out.length >= max) return;
  const scene = node as SceneNode;
  const hasGeom =
    (scene.fillGeometry?.length ?? 0) > 0 ||
    (scene.strokeGeometry?.length ?? 0) > 0;
  const isVectorType = [
    "VECTOR",
    "BOOLEAN_OPERATION",
    "STAR",
    "LINE",
    "ELLIPSE",
    "REGULAR_POLYGON",
    "POLYGON",
  ].includes(node.type ?? "");
  if (hasGeom || isVectorType) {
    out.push(node);
  }
  if (node.children) {
    for (const c of node.children) {
      if (out.length >= max) break;
      collectVectorCandidates(c as FigNode, out, max);
    }
  }
}

function collectExportRoots(
  document: FigNode,
  nodeId: string | undefined,
  nodeIndex: Map<string, FigNode> | undefined,
  maxNodes: number,
): FigNode[] {
  if (nodeId && nodeIndex) {
    const n = nodeIndex.get(nodeId);
    if (n) return [n];
  }
  // Whole document: top-level frames on each canvas page
  const roots: FigNode[] = [];
  const doc = document as DocumentNode;
  const pages = doc.children ?? [];
  for (const page of pages) {
    if (roots.length >= maxNodes) break;
    const kids = (page as FigNode).children ?? [];
    if (kids.length === 0) {
      roots.push(page as FigNode);
      continue;
    }
    for (const frame of kids) {
      if (roots.length >= maxNodes) break;
      // Prefer FRAME/COMPONENT at page top level
      if (
        frame.type === "FRAME" ||
        frame.type === "COMPONENT" ||
        frame.type === "SECTION" ||
        frame.type === "INSTANCE"
      ) {
        roots.push(frame as FigNode);
      }
    }
  }
  if (roots.length === 0) roots.push(document);
  return roots.slice(0, maxNodes);
}

/**
 * Export a complete agent-safe asset pack directory.
 */
export async function exportAssetPack(
  opts: ExportAssetPackOptions,
): Promise<AssetPackManifest> {
  const {
    outputDir,
    filePath,
    nodeId,
    maxDepth = 40,
    maxNodes = 50,
    includeImages = true,
    includeVectors = true,
    includeScreens = true,
    includeSpecs = true,
  } = opts;

  if (!opts.document || !opts.nodeIndex) {
    throw new Error(
      "exportAssetPack requires document + nodeIndex (parse the .fig first)",
    );
  }

  await mkdir(outputDir, { recursive: true });
  await mkdir(join(outputDir, "images"), { recursive: true });
  await mkdir(join(outputDir, "vectors"), { recursive: true });
  await mkdir(join(outputDir, "nodes"), { recursive: true });

  const roots = collectExportRoots(
    opts.document,
    nodeId,
    opts.nodeIndex,
    maxNodes,
  );

  const allImageHashes = new Set<string>();
  for (const r of roots) collectImageHashes(r, allImageHashes);

  const imageEntries: AssetPackImageEntry[] = [];
  const hashToPath = new Map<string, string>();

  if (includeImages && opts.images) {
    for (const hash of allImageHashes) {
      const data =
        opts.images.get(hash) ?? opts.images.get(hash.toLowerCase());
      if (!data) continue;
      const ext = guessExtFromBytes(data);
      const rel = `images/${hash}${ext}`;
      const abs = join(outputDir, rel);
      await writeFile(abs, data);
      hashToPath.set(hash, rel);
      hashToPath.set(hash.toLowerCase(), rel);
      imageEntries.push({
        hash,
        path: rel,
        byteLength: data.byteLength,
        format: detectImageFormat(data),
      });
    }
  }

  const nodeEntries: AssetPackNodeEntry[] = [];
  let vectorCount = 0;
  let screenCount = 0;

  for (const root of roots) {
    const id = formatGUID(root.guid);
    const safeId = sanitizeId(id);
    const nodeDir = join(outputDir, "nodes", safeId);
    await mkdir(nodeDir, { recursive: true });

    const nodeImages: string[] = [];
    const nodeVectors: string[] = [];
    const paths: AssetPackNodeEntry["paths"] = {};

    // Collect hashes for this subtree
    const localHashes = new Set<string>();
    collectImageHashes(root, localHashes);
    for (const h of localHashes) {
      const p = hashToPath.get(h) ?? hashToPath.get(h.toLowerCase());
      if (p) nodeImages.push(p);
    }

    // True SVG composite
    const trueSvg = exportNodeTrueSvg(root, {
      blobs: opts.blobs,
      images: opts.images,
      nodeIndex: opts.nodeIndex,
      rawNodeIndex: opts.rawNodeIndex,
      resolveInstances: true,
      maxDepth,
      imageResolver: {
        hashToPath,
        // Relative from nodes/{id}/ → ../../images/...
        assetBase: "../..",
        allowBase64: !includeImages || hashToPath.size === 0,
      },
    });

    const svgRel = `nodes/${safeId}/node.svg`;
    await writeFile(join(outputDir, svgRel), trueSvg.svg, "utf-8");
    paths.svg = svgRel;

    if (includeScreens) {
      try {
        const shot = await screenshotWithEmbeddedAssets(root, {
          blobs: opts.blobs, images: opts.images,
          nodeIndex: opts.nodeIndex, rawNodeIndex: opts.rawNodeIndex,
          resolveInstances: true, maxDepth,
        });
        const pngRel = `nodes/${safeId}/node.png`;
        await writeFile(
          join(outputDir, pngRel),
          Buffer.from(shot.base64, "base64"),
        );
        paths.png = pngRel;
        screenCount++;
      } catch (e) {
        // resvg may fail on huge SVGs — continue
        void e;
      }
    }

    if (includeSpecs) {
      const spec = buildDesignSpec(root, Math.min(maxDepth, 12));
      const specRel = `nodes/${safeId}/design-spec.json`;
      await writeFile(
        join(outputDir, specRel),
        JSON.stringify(spec, null, 2),
        "utf-8",
      );
      paths.spec = specRel;
    }

    const scene = root as SceneNode;
    const meta = {
      id,
      name: root.name,
      type: root.type,
      bounds: {
        x: scene.x ?? 0,
        y: scene.y ?? 0,
        width: scene.width ?? trueSvg.width,
        height: scene.height ?? trueSvg.height,
      },
      usedTrueGeometry: trueSvg.usedTrueGeometry,
      warnings: trueSvg.warnings,
    };
    const metaRel = `nodes/${safeId}/meta.json`;
    await writeFile(join(outputDir, metaRel), JSON.stringify(meta, null, 2));
    paths.meta = metaRel;

    // Standalone vector files for geometry-bearing descendants
    if (includeVectors) {
      const vectors: FigNode[] = [];
      collectVectorCandidates(root, vectors, 200);
      for (const v of vectors) {
        const vid = formatGUID(v.guid);
        const vScene = v as SceneNode;
        // Only write if has real geometry paths
        const geoms = nodeFillStrokePaths(vScene, opts.blobs);
        if (geoms.length === 0 && !vScene.vectorData) continue;

        const vSvg = exportNodeTrueSvg(v, {
          blobs: opts.blobs,
          images: opts.images,
          nodeIndex: opts.nodeIndex,
          rawNodeIndex: opts.rawNodeIndex,
          resolveInstances: true,
          maxDepth: 8,
          imageResolver: {
            hashToPath,
            assetBase: "..",
            allowBase64: false,
          },
        });
        if (!vSvg.svg.includes("<path") && !vSvg.svg.includes("<image")) {
          continue;
        }
        const fname = `${sanitizeFilePart(v.name)}__${sanitizeId(vid)}.svg`;
        const vRel = `vectors/${fname}`;
        await writeFile(join(outputDir, vRel), vSvg.svg, "utf-8");
        nodeVectors.push(vRel);
        vectorCount++;
      }
    }

    const assetsJson = {
      images: nodeImages,
      vectors: nodeVectors,
      trueGeometry: trueSvg.usedTrueGeometry,
    };
    const assetsRel = `nodes/${safeId}/assets.json`;
    await writeFile(
      join(outputDir, assetsRel),
      JSON.stringify(assetsJson, null, 2),
    );
    paths.assets = assetsRel;

    nodeEntries.push({
      id,
      name: root.name,
      type: root.type,
      paths,
      images: nodeImages,
      vectors: nodeVectors,
    });
  }

  const manifest: AssetPackManifest = {
    version: 1,
    sourceFig: opts.sourceFig ?? basename(filePath),
    exportedAt: new Date().toISOString(),
    policy: POLICY,
    nodes: nodeEntries,
    images: imageEntries,
    totals: {
      nodes: nodeEntries.length,
      images: imageEntries.length,
      vectors: vectorCount,
      screens: screenCount,
    },
  };

  await writeFile(
    join(outputDir, "MANIFEST.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
  await writeFile(join(outputDir, "AGENTS.md"), AGENTS_MD, "utf-8");

  return manifest;
}

/**
 * Export single-node assets: true SVG + PNG + images to outputDir.
 * Returns list of written absolute paths only.
 */
export async function exportNodeAssets(
  node: FigNode,
  opts: {
    outputDir: string;
    images?: ImageStore;
    blobs?: BlobEntry[];
    nodeIndex?: Map<string, FigNode>;
    rawNodeIndex?: Map<string, Record<string, unknown>>;
    writePng?: boolean;
    writeSvg?: boolean;
    maxDepth?: number;
  },
): Promise<{ written: string[]; svgPath?: string; pngPath?: string }> {
  const { outputDir } = opts;
  await mkdir(outputDir, { recursive: true });
  const written: string[] = [];

  const hashes = new Set<string>();
  collectImageHashes(node, hashes);
  const hashToPath = new Map<string, string>();

  if (opts.images) {
    for (const hash of hashes) {
      const data =
        opts.images.get(hash) ?? opts.images.get(hash.toLowerCase());
      if (!data) continue;
      const ext = guessExtFromBytes(data);
      const abs = join(outputDir, `${hash}${ext}`);
      await writeFile(abs, data);
      written.push(abs);
      hashToPath.set(hash, `${hash}${ext}`);
    }
  }

  let svgPath: string | undefined;
  let pngPath: string | undefined;

  if (opts.writeSvg !== false) {
    const trueSvg = exportNodeTrueSvg(node, {
      blobs: opts.blobs,
      images: opts.images,
      nodeIndex: opts.nodeIndex,
      rawNodeIndex: opts.rawNodeIndex,
      resolveInstances: true,
      maxDepth: opts.maxDepth ?? 40,
      imageResolver: {
        hashToPath,
        allowBase64: hashToPath.size === 0,
      },
    });
    svgPath = join(outputDir, "node.svg");
    await writeFile(svgPath, trueSvg.svg, "utf-8");
    written.push(svgPath);

    if (opts.writePng !== false) {
      try {
        const shot = await screenshotWithEmbeddedAssets(node, {
          blobs: opts.blobs, images: opts.images,
          nodeIndex: opts.nodeIndex, rawNodeIndex: opts.rawNodeIndex,
          resolveInstances: true, maxDepth: opts.maxDepth ?? 40,
        });
        pngPath = join(outputDir, "node.png");
        await writeFile(pngPath, Buffer.from(shot.base64, "base64"));
        written.push(pngPath);
      } catch {
        // ignore raster failures
      }
    }
  }

  return { written, svgPath, pngPath };
}
