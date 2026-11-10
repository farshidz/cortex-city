import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "fs";
import path from "path";
import { deflateRawSync } from "zlib";
import type { ResolvedSecret } from "./secret-store";
import type { RoutineArtifact } from "./types";

// --- Redaction ---

const MIN_REDACT_LENGTH = 4;
const MIN_FILE_LINE_REDACT_LENGTH = 16;

export interface Redactor {
  (text: string): string;
  /** Byte-level redaction for files of any type. */
  buffer: (data: Buffer) => Buffer;
}

function replaceAllBytes(data: Buffer, needle: Buffer, replacement: Buffer): Buffer {
  let index = data.indexOf(needle);
  if (index === -1) return data;
  const parts: Buffer[] = [];
  let start = 0;
  while (index !== -1) {
    parts.push(data.subarray(start, index), replacement);
    start = index + needle.length;
    index = data.indexOf(needle, start);
  }
  parts.push(data.subarray(start));
  return Buffer.concat(parts);
}

export const identityRedactor: Redactor = Object.assign((text: string) => text, {
  buffer: (data: Buffer) => data,
});

/**
 * Replaces every known secret value with a placeholder naming the secret.
 * File secrets also redact their individual long lines, so a key that is
 * printed line by line is still caught.
 */
export function createRedactor(secrets: Pick<ResolvedSecret, "name" | "value" | "kind">[]): Redactor {
  const needles: { value: string; label: string }[] = [];
  for (const secret of secrets) {
    const value = secret.value;
    if (value.length >= MIN_REDACT_LENGTH) {
      needles.push({ value, label: `[REDACTED:${secret.name}]` });
      const trimmed = value.trim();
      if (trimmed !== value && trimmed.length >= MIN_REDACT_LENGTH) {
        needles.push({ value: trimmed, label: `[REDACTED:${secret.name}]` });
      }
    }
    if (secret.kind === "file") {
      for (const line of value.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length >= MIN_FILE_LINE_REDACT_LENGTH) {
          needles.push({ value: trimmed, label: `[REDACTED:${secret.name}]` });
        }
      }
    }
  }
  needles.sort((a, b) => b.value.length - a.value.length);
  if (needles.length === 0) return identityRedactor;
  const byteNeedles = needles.map((needle) => ({
    value: Buffer.from(needle.value, "utf-8"),
    label: Buffer.from(needle.label, "utf-8"),
  }));
  const redactText = (text: string) => {
    let result = text;
    for (const needle of needles) {
      if (result.includes(needle.value)) result = result.split(needle.value).join(needle.label);
    }
    return result;
  };
  return Object.assign(redactText, {
    buffer: (data: Buffer) => {
      let result = data;
      for (const needle of byteNeedles) result = replaceAllBytes(result, needle.value, needle.label);
      return result;
    },
  });
}

// --- Content types ---

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

// --- Capture ---

export interface ArtifactListing {
  path: string;
  title: string;
  main: boolean;
}

export interface CaptureResult {
  artifacts: RoutineArtifact[];
  bytes: number;
  truncated: boolean;
  skipped: string[];
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [""];
  while (stack.length > 0) {
    const relative = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      // Symlinks are never followed: they could point outside the output dir.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) files.push(child);
    }
  }
  return files.sort();
}

/** Normalizes an agent-reported path to a safe path relative to `root`. */
export function normalizeArtifactPath(root: string, reported: string): string | undefined {
  const resolvedRoot = path.resolve(root);
  const candidate = path.isAbsolute(reported)
    ? path.resolve(reported)
    : path.resolve(resolvedRoot, reported);
  const relative = path.relative(resolvedRoot, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join("/");
}

/**
 * Copies the run's output directory into permanent storage. Files the report
 * lists come first (main report first) so a size cap keeps what matters.
 * Text files are redacted on the way in.
 */
export function captureArtifacts(
  outputDir: string,
  destinationDir: string,
  listing: ArtifactListing[],
  options: { maxBytes: number; redact: Redactor }
): CaptureResult {
  const result: CaptureResult = { artifacts: [], bytes: 0, truncated: false, skipped: [] };
  let realOutput: string;
  try {
    realOutput = realpathSync(outputDir);
  } catch {
    return result;
  }
  const files = listFiles(realOutput);
  const present = new Set(files);
  const listed = new Map<string, ArtifactListing>();
  for (const entry of listing) {
    const normalized = normalizeArtifactPath(realOutput, entry.path);
    if (normalized && present.has(normalized) && !listed.has(normalized)) {
      listed.set(normalized, { ...entry, path: normalized });
    }
  }
  const ordered = [
    ...[...listed.values()].sort((a, b) => Number(b.main) - Number(a.main)).map((entry) => entry.path),
    ...files.filter((file) => !listed.has(file)),
  ];
  let mainAssigned = false;
  for (const relative of ordered) {
    const source = path.join(realOutput, relative);
    let size: number;
    try {
      const stat = lstatSync(source);
      if (!stat.isFile()) continue;
      size = stat.size;
    } catch {
      continue;
    }
    const contentType = contentTypeFor(relative);
    if (result.bytes + size > options.maxBytes) {
      result.truncated = true;
      result.skipped.push(relative);
      continue;
    }
    const destination = path.join(destinationDir, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    // Every file is redacted byte by byte, whatever its extension: an agent
    // can write a token into a .env, a script or a file with no extension.
    const redacted = options.redact.buffer(readFileSync(source));
    writeFileSync(destination, redacted);
    const storedSize = redacted.length;
    const entry = listed.get(relative);
    const main = Boolean(entry?.main) && !mainAssigned;
    if (main) mainAssigned = true;
    result.bytes += storedSize;
    result.artifacts.push({
      path: relative,
      title: entry?.title ?? path.basename(relative),
      size: storedSize,
      content_type: contentType,
      listed: Boolean(entry),
      ...(main ? { main: true } : {}),
    });
  }
  // Without an explicit main report, a lone or first HTML file is the main one.
  if (!mainAssigned) {
    const html = result.artifacts.find((artifact) => artifact.content_type.startsWith("text/html"));
    if (html) html.main = true;
  }
  return result;
}

/** Resolves a stored artifact path, refusing anything outside the run's dir. */
export function resolveStoredArtifact(artifactsDir: string, relative: string): string | undefined {
  const normalized = normalizeArtifactPath(artifactsDir, relative);
  if (!normalized) return undefined;
  const full = path.join(artifactsDir, normalized);
  try {
    const stat = lstatSync(full);
    if (!stat.isFile()) return undefined;
  } catch {
    return undefined;
  }
  return full;
}

// --- Zip (download all) ---

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Builds a deflate-compressed zip archive of the given files in memory. */
export function buildZip(files: { name: string; data: Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf-8");
    const compressed = deflateRawSync(file.data);
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 10); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}
