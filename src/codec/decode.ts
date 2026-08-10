/**
 * PolyTrack2 export-code decoder — the inverse of encode.ts, mirroring the
 * game's parser (chunk 6582). Used by tests to round-trip real track codes,
 * and by the UI to show stats for imported codes.
 */
import pako from 'pako';
import { b62Decode } from './b62';
import { CHECKPOINT_PART_IDS, START_PART_IDS, type PlacedPart } from './parts';

export interface DecodedTrack {
  readonly name: string;
  readonly author: string | null;
  readonly lastModified: Date | null;
  readonly environment: number;
  readonly sunRotation: number;
  readonly parts: readonly PlacedPart[];
}

function readI32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) | 0
  );
}

export function fromExportString(code: string): DecodedTrack | null {
  const clean = code.replace(/\s+/g, '');
  if (!clean.startsWith('PolyTrack2')) return null;

  const outer = b62Decode(clean.substring(10));
  if (!outer) return null;
  let innerText: string;
  try {
    innerText = pako.inflate(outer, { to: 'string' });
  } catch {
    return null;
  }
  const inner = b62Decode(innerText);
  if (!inner) return null;
  let raw: Uint8Array;
  try {
    raw = pako.inflate(inner);
  } catch {
    return null;
  }

  let h = 0;
  if (raw.length < h + 1) return null;
  const nameLen = raw[h]!; h += 1;
  if (raw.length < h + nameLen) return null;
  const name = new TextDecoder('utf-8').decode(raw.subarray(h, h + nameLen)); h += nameLen;

  if (raw.length < h + 1) return null;
  const authorLen = raw[h]!; h += 1;
  let author: string | null = null;
  if (authorLen > 0) {
    if (raw.length < h + authorLen) return null;
    author = new TextDecoder('utf-8').decode(raw.subarray(h, h + authorLen)); h += authorLen;
  }

  if (raw.length < h + 1) return null;
  const dateFlag = raw[h]!; h += 1;
  let lastModified: Date | null = null;
  if (dateFlag === 1) {
    if (raw.length < h + 4) return null;
    lastModified = new Date(readI32(raw, h) * 1000); h += 4;
  } else if (dateFlag !== 0) {
    return null;
  }

  if (raw.length < h + 2) return null;
  const environment = raw[h]!; h += 1;
  const sunRotation = raw[h]!; h += 1;
  if (sunRotation >= 180) return null;

  if (raw.length < h + 13) return null;
  const minX = readI32(raw, h); h += 4;
  const minY = readI32(raw, h); h += 4;
  const minZ = readI32(raw, h); h += 4;
  const pack = raw[h]!; h += 1;
  const bx = pack & 3, by = (pack >> 2) & 3, bz = (pack >> 4) & 3;
  if (bx < 1 || by < 1 || bz < 1) return null;

  const parts: PlacedPart[] = [];
  while (h < raw.length) {
    if (raw.length - h < 5) return null;
    const partId = raw[h]!; h += 1;
    const count = readI32(raw, h) >>> 0; h += 4;
    const isCheckpoint = CHECKPOINT_PART_IDS.includes(partId);
    const isStart = START_PART_IDS.includes(partId);
    for (let i = 0; i < count; i++) {
      if (raw.length - h < bx + by + bz + 2) return null;
      let x = 0;
      for (let j = 0; j < bx; j++) x |= raw[h + j]! << (j * 8);
      x += minX; h += bx;
      let y = 0;
      for (let j = 0; j < by; j++) y |= raw[h + j]! << (j * 8);
      y += minY; h += by;
      let z = 0;
      for (let j = 0; j < bz; j++) z |= raw[h + j]! << (j * 8);
      z += minZ; h += bz;
      const rb = raw[h]!; h += 1;
      const color = raw[h]!; h += 1;
      let checkpointOrder: number | undefined;
      let startOrder: number | undefined;
      if (isCheckpoint) {
        if (raw.length - h < 2) return null;
        checkpointOrder = raw[h]! | (raw[h + 1]! << 8); h += 2;
      }
      if (isStart) {
        if (raw.length - h < 4) return null;
        startOrder = readI32(raw, h) >>> 0; h += 4;
      }
      parts.push({
        x, y, z, partId,
        rotation: rb & 3,
        rotationAxis: (rb >> 2) & 7,
        color,
        ...(checkpointOrder != null ? { checkpointOrder } : {}),
        ...(startOrder != null ? { startOrder } : {}),
      });
    }
  }

  return { name, author, lastModified, environment, sunRotation, parts };
}
