/**
 * FigReader - Reads and extracts .fig files
 *
 * .fig files are ZIP archives containing:
 * - canvas.fig: The main document data (kiwi binary format)
 * - meta.json: File metadata
 * - thumbnail.png: Preview image
 * - images/: Directory with image assets (loaded lazily)
 */

import { open, readFile, type FileHandle } from "fs/promises";
import { promisify } from "node:util";
import { inflateRaw as inflateRawZlib } from "node:zlib";
import { inflateRaw } from "pako";
import type { FigMeta } from "./types.js";

// ZIP Central Directory Entry
interface CentralDirEntry {
  filename: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/** Metadata for an image entry without decoding bytes. */
export interface ImageMeta {
  hash: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
}

/**
 * Lazy image store backed by the ZIP buffer + central directory.
 * Decodes images on demand with an optional LRU cache (max 64).
 */
export interface ImageStore {
  readonly size: number;
  listHashes(): string[];
  getMeta(hash: string): ImageMeta | undefined;
  get(hash: string): Uint8Array | undefined;
  has(hash: string): boolean;
  keys(): IterableIterator<string>;
}

const DEFAULT_LRU_MAX = 64;
const MAX_THUMBNAIL_BYTES = 12_000_000;
const MAX_CENTRAL_DIRECTORY_BYTES = 8_000_000;
const inflateThumbnail = promisify(inflateRawZlib);

async function readExact(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const data = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(data, offset, length - offset, position + offset);
    if (!bytesRead) throw new Error('Truncated .fig ZIP archive');
    offset += bytesRead;
  }
  return data;
}

/** Read only the ZIP index and thumbnail entry, never the full .fig archive. */
export async function readEmbeddedFigThumbnail(filePath: string): Promise<Uint8Array | undefined> {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, 65_557);
    const tail = await readExact(handle, size - tailLength, tailLength);
    const eocd = findEOCD(tail);
    if (eocd < 0) throw new Error('Missing .fig ZIP central directory');
    const directorySize = readUint32LE(tail, eocd + 12);
    const directoryOffset = readUint32LE(tail, eocd + 16);
    if (directorySize > MAX_CENTRAL_DIRECTORY_BYTES || directoryOffset + directorySize > size) {
      throw new Error('.fig ZIP central directory exceeds preview limit');
    }
    // parseCentralDirectory expects absolute offsets from the start of a ZIP.
    // Rebase the EOCD to this small directory buffer instead.
    const directory = await readExact(handle, directoryOffset, directorySize);
    const localEocd = Buffer.alloc(22);
    tail.copy(localEocd, 0, eocd, eocd + 22);
    localEocd.writeUInt32LE(0, 16);
    const entries = parseCentralDirectory(Buffer.concat([directory, localEocd]));
    const entry = entries.find(item => item.filename === 'thumbnail.png');
    if (!entry) return undefined;
    if (entry.compressedSize > MAX_THUMBNAIL_BYTES || entry.uncompressedSize > MAX_THUMBNAIL_BYTES) {
      return undefined;
    }
    const header = await readExact(handle, entry.localHeaderOffset, 30);
    if (readUint32LE(header, 0) !== 0x04034b50) throw new Error('Invalid thumbnail ZIP header');
    const dataStart = entry.localHeaderOffset + 30 + readUint16LE(header, 26) + readUint16LE(header, 28);
    if (dataStart + entry.compressedSize > size) throw new Error('Invalid thumbnail ZIP length');
    const compressed = await readExact(handle, dataStart, entry.compressedSize);
    if (entry.compressionMethod === 0) return compressed;
    if (entry.compressionMethod !== 8) return undefined;
    return await inflateThumbnail(compressed, { maxOutputLength: MAX_THUMBNAIL_BYTES });
  } finally {
    await handle.close();
  }
}

export class LazyImageStore implements ImageStore {
  private readonly zipData: Uint8Array;
  private readonly entryByHash: Map<string, CentralDirEntry>;
  private readonly cache = new Map<string, Uint8Array>();
  private readonly lruMax: number;

  constructor(
    zipData: Uint8Array,
    imageEntries: Map<string, CentralDirEntry>,
    lruMax: number = DEFAULT_LRU_MAX,
  ) {
    this.zipData = zipData;
    this.entryByHash = imageEntries;
    this.lruMax = lruMax;
  }

  get size(): number {
    return this.entryByHash.size;
  }

  listHashes(): string[] {
    return Array.from(this.entryByHash.keys());
  }

  keys(): IterableIterator<string> {
    return this.entryByHash.keys();
  }

  has(hash: string): boolean {
    return this.entryByHash.has(hash) || this.entryByHash.has(hash.toLowerCase());
  }

  getMeta(hash: string): ImageMeta | undefined {
    const entry = this.entryByHash.get(hash) ?? this.entryByHash.get(hash.toLowerCase());
    if (!entry) return undefined;
    const resolved = this.entryByHash.has(hash) ? hash : hash.toLowerCase();
    const key = this.entryByHash.has(hash)
      ? hash
      : this.entryByHash.has(hash.toLowerCase())
        ? hash.toLowerCase()
        : resolved;
    return {
      hash: this.entryByHash.has(hash) ? hash : key,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
      compressionMethod: entry.compressionMethod,
    };
  }

  get(hash: string): Uint8Array | undefined {
    const key = this.resolveKey(hash);
    if (!key) return undefined;

    const cached = this.cache.get(key);
    if (cached) {
      // Refresh LRU order
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    const entry = this.entryByHash.get(key);
    if (!entry) return undefined;

    const compressedData = extractFileData(this.zipData, entry);
    const fileData = decompressData(compressedData, entry.compressionMethod);
    this.putCache(key, fileData);
    return fileData;
  }

  /** Test helper: number of currently decoded (cached) images. */
  get cachedCount(): number {
    return this.cache.size;
  }

  private resolveKey(hash: string): string | undefined {
    if (this.entryByHash.has(hash)) return hash;
    const lower = hash.toLowerCase();
    if (this.entryByHash.has(lower)) return lower;
    return undefined;
  }

  private putCache(key: string, data: Uint8Array): void {
    if (this.lruMax <= 0) return;
    if (this.cache.size >= this.lruMax) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(key, data);
  }
}

export interface FigArchive {
  canvasFig: Uint8Array;
  meta: FigMeta;
  thumbnail?: Uint8Array;
  images: ImageStore;
}

/**
 * Read a little-endian uint16 from buffer
 */
function readUint16LE(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8);
}

/**
 * Read a little-endian uint32 from buffer
 */
function readUint32LE(data: Uint8Array, offset: number): number {
  return (
    data[offset]! |
    (data[offset + 1]! << 8) |
    (data[offset + 2]! << 16) |
    (data[offset + 3]! << 24)
  ) >>> 0;
}

/**
 * Find the End of Central Directory record
 */
function findEOCD(data: Uint8Array): number {
  // EOCD signature: 0x06054b50
  // Search backwards from end of file (EOCD can have variable-length comment)
  const minEOCDSize = 22;
  const maxCommentSize = 65535;
  const searchStart = Math.max(0, data.length - minEOCDSize - maxCommentSize);

  for (let i = data.length - minEOCDSize; i >= searchStart; i--) {
    if (
      data[i] === 0x50 &&
      data[i + 1] === 0x4b &&
      data[i + 2] === 0x05 &&
      data[i + 3] === 0x06
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Parse the Central Directory to get file entries with correct sizes
 */
function parseCentralDirectory(data: Uint8Array): CentralDirEntry[] {
  const eocdOffset = findEOCD(data);
  if (eocdOffset === -1) {
    throw new Error("Cannot find End of Central Directory record");
  }

  const centralDirOffset = readUint32LE(data, eocdOffset + 16);
  const entryCount = readUint16LE(data, eocdOffset + 10);

  const entries: CentralDirEntry[] = [];
  let offset = centralDirOffset;

  for (let i = 0; i < entryCount; i++) {
    // Central directory file header signature: 0x02014b50
    const signature = readUint32LE(data, offset);
    if (signature !== 0x02014b50) {
      throw new Error(`Invalid central directory signature at offset ${offset}`);
    }

    const compressionMethod = readUint16LE(data, offset + 10);
    const compressedSize = readUint32LE(data, offset + 20);
    const uncompressedSize = readUint32LE(data, offset + 24);
    const filenameLength = readUint16LE(data, offset + 28);
    const extraFieldLength = readUint16LE(data, offset + 30);
    const commentLength = readUint16LE(data, offset + 32);
    const localHeaderOffset = readUint32LE(data, offset + 42);

    const filenameStart = offset + 46;
    const filename = new TextDecoder().decode(
      data.slice(filenameStart, filenameStart + filenameLength)
    );

    entries.push({
      filename,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    offset += 46 + filenameLength + extraFieldLength + commentLength;
  }

  return entries;
}

/**
 * Extract file data using central directory info
 */
function extractFileData(
  data: Uint8Array,
  entry: CentralDirEntry
): Uint8Array {
  const localHeaderOffset = entry.localHeaderOffset;

  // Verify local file header signature
  const signature = readUint32LE(data, localHeaderOffset);
  if (signature !== 0x04034b50) {
    throw new Error(`Invalid local file header at offset ${localHeaderOffset}`);
  }

  const filenameLength = readUint16LE(data, localHeaderOffset + 26);
  const extraFieldLength = readUint16LE(data, localHeaderOffset + 28);

  const dataStart = localHeaderOffset + 30 + filenameLength + extraFieldLength;
  const dataEnd = dataStart + entry.compressedSize;

  return data.slice(dataStart, dataEnd);
}

/**
 * Decompress file data
 */
function decompressData(
  compressedData: Uint8Array,
  compressionMethod: number
): Uint8Array {
  // Method 0 = stored (no compression)
  if (compressionMethod === 0) {
    return compressedData;
  }

  // Method 8 = deflate
  if (compressionMethod === 8) {
    return inflateRaw(compressedData);
  }

  throw new Error(`Unsupported compression method: ${compressionMethod}`);
}

/**
 * Eagerly extract a single named file from the ZIP (used for canvas/meta/thumbnail).
 */
function extractNamedFile(
  data: Uint8Array,
  entries: CentralDirEntry[],
  filename: string,
): Uint8Array | undefined {
  const entry = entries.find((e) => e.filename === filename);
  if (!entry) return undefined;
  const compressed = extractFileData(data, entry);
  return decompressData(compressed, entry.compressionMethod);
}

/**
 * Read a .fig file from disk and extract its contents
 */
export async function readFigFile(filePath: string): Promise<FigArchive> {
  const data = await readFile(filePath);
  return parseFigArchive(new Uint8Array(data));
}

/**
 * Parse a .fig archive from a buffer.
 * Eager: canvas.fig, meta.json, thumbnail.png only.
 * Images: lazy via ImageStore (CD index + on-demand inflate).
 */
export function parseFigArchive(data: Uint8Array): FigArchive {
  // Check for ZIP signature (PK..)
  if (data[0] !== 0x50 || data[1] !== 0x4b) {
    throw new Error("Invalid .fig file: not a ZIP archive");
  }

  const entries = parseCentralDirectory(data);

  const canvasFig = extractNamedFile(data, entries, "canvas.fig");
  if (!canvasFig) {
    throw new Error("Invalid .fig file: missing canvas.fig");
  }

  let meta: FigMeta = {};
  const metaJson = extractNamedFile(data, entries, "meta.json");
  if (metaJson) {
    try {
      meta = JSON.parse(new TextDecoder().decode(metaJson)) as FigMeta;
    } catch {
      console.warn("Failed to parse meta.json");
    }
  }

  const thumbnail = extractNamedFile(data, entries, "thumbnail.png");

  const imageEntries = new Map<string, CentralDirEntry>();
  for (const entry of entries) {
    if (entry.filename.endsWith("/")) continue;
    if (entry.filename.startsWith("images/")) {
      const imageName = entry.filename.slice(7); // Remove "images/" prefix
      if (imageName.length > 0) {
        imageEntries.set(imageName, entry);
      }
    }
  }

  const images = new LazyImageStore(data, imageEntries);

  return {
    canvasFig,
    meta,
    thumbnail,
    images,
  };
}

/**
 * List all files in a .fig archive
 */
export async function listFigContents(filePath: string): Promise<string[]> {
  const data = await readFile(filePath);
  const entries = parseCentralDirectory(new Uint8Array(data));
  return entries.map((e) => e.filename);
}

/** Exported for tests that build synthetic ZIPs and need CD helpers. */
export const _zipInternals = {
  parseCentralDirectory,
  extractFileData,
  decompressData,
  readUint16LE,
  readUint32LE,
};
