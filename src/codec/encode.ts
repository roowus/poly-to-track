/**
 * PolyTrack2 export-code encoder.
 *
 * Byte-level mirror of the game's `TrackData.toExportString` (0.6.2 bundle,
 * chunk 9117): serialize header + part table, deflate with windowBits 9,
 * base62 the result, deflate THAT string with windowBits 15, base62 again,
 * and prefix "PolyTrack2". The game's `fromExportString` accepts the result.
 */
import pako from 'pako';
import { b62Encode } from './b62';
import { CHECKPOINT_PART_IDS, START_PART_IDS, type PlacedPart } from './parts';

export interface TrackMeta {
  readonly name: string;
  readonly author?: string | null;
  readonly lastModified?: Date | null;
  /** Environment id (0 Summer, 1 Winter, 2 Desert). Default Summer. */
  readonly environment?: number;
  /** Sun rotation representation 0..179 (degrees / 2). Game default 28. */
  readonly sunRotation?: number;
}

/** The game keeps each part-id bucket sorted with this comparator (addPart). */
function comparePlaced(a: PlacedPart, b: PlacedPart): number {
  return (
    a.x - b.x ||
    a.y - b.y ||
    a.z - b.z ||
    a.rotation - b.rotation ||
    a.rotationAxis - b.rotationAxis ||
    a.color - b.color ||
    (a.checkpointOrder ?? -1) - (b.checkpointOrder ?? -1) ||
    (a.startOrder ?? -1) - (b.startOrder ?? -1)
  );
}

function pushI32(out: number[], v: number): void {
  out.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
}

/** Serialize environment + sun + part table exactly like the game's #h(). */
export function serializeTrackBody(parts: readonly PlacedPart[], meta: TrackMeta): Uint8Array {
  const environment = meta.environment ?? 0;
  const sunRotation = meta.sunRotation ?? 28;
  if (!Number.isSafeInteger(sunRotation) || sunRotation < 0 || sunRotation >= 180) {
    throw new Error(`sunRotation out of range: ${sunRotation}`);
  }

  const byId = new Map<number, PlacedPart[]>();
  for (const p of parts) {
    if (p.partId < 0 || p.partId > 255) throw new Error(`Part id out of range: ${p.partId}`);
    let list = byId.get(p.partId);
    if (!list) byId.set(p.partId, (list = []));
    list.push(p);
  }
  const ids = [...byId.keys()].sort((a, b) => a - b);
  for (const id of ids) byId.get(id)!.sort(comparePlaced);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of parts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); minZ = Math.min(minZ, p.z);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); maxZ = Math.max(maxZ, p.z);
  }
  if (!Number.isFinite(minX)) { minX = minY = minZ = maxX = maxY = maxZ = 0; }

  const spanX = maxX - minX + 1;
  const spanY = maxY - minY + 1;
  const spanZ = maxZ - minZ + 1;
  const bx = Math.max(1, Math.min(4, Math.ceil(Math.log2(spanX + 1) / 8)));
  const by = Math.max(1, Math.min(4, Math.ceil(Math.log2(spanY + 1) / 8)));
  const bz = Math.max(1, Math.min(4, Math.ceil(Math.log2(spanZ + 1) / 8)));

  const out: number[] = [environment, sunRotation];
  pushI32(out, minX);
  pushI32(out, minY);
  pushI32(out, minZ);
  out.push((bx | (by << 2) | (bz << 4)) & 255);

  for (const id of ids) {
    const list = byId.get(id)!;
    out.push(id & 255);
    pushI32(out, list.length);
    const isCheckpoint = CHECKPOINT_PART_IDS.includes(id);
    const isStart = START_PART_IDS.includes(id);
    for (const p of list) {
      const dx = p.x - minX;
      const dy = p.y - minY;
      const dz = p.z - minZ;
      for (let i = 0; i < bx; i++) out.push((dx >>> (i * 8)) & 255);
      for (let i = 0; i < by; i++) out.push((dy >>> (i * 8)) & 255);
      for (let i = 0; i < bz; i++) out.push((dz >>> (i * 8)) & 255);
      out.push(((p.rotation & 3) | ((p.rotationAxis & 7) << 2)) & 255, p.color & 255);
      if (isCheckpoint) {
        if (p.checkpointOrder == null) throw new Error('Checkpoint has no checkpoint order');
        out.push(p.checkpointOrder & 255, (p.checkpointOrder >>> 8) & 255);
      }
      if (isStart) {
        if (p.startOrder == null) throw new Error('Start has no start order');
        pushI32(out, p.startOrder);
      }
    }
  }
  return new Uint8Array(out);
}

/** Full "PolyTrack2…" export code, importable by the game and api.tracks. */
export function toExportString(parts: readonly PlacedPart[], meta: TrackMeta): string {
  const name = new TextEncoder().encode(meta.name);
  if (name.length > 255) throw new Error('Track name too long (max 255 utf-8 bytes)');
  const author = meta.author != null ? new TextEncoder().encode(meta.author) : null;
  if (author && author.length > 255) throw new Error('Author too long (max 255 utf-8 bytes)');

  const dateBytes: number[] = [];
  if (meta.lastModified == null) {
    dateBytes.push(0);
  } else {
    dateBytes.push(1);
    const t = Math.floor(meta.lastModified.getTime() / 1000);
    dateBytes.push(t & 255, (t >>> 8) & 255, (t >>> 16) & 255, (t >>> 24) & 255);
  }

  const header = new Uint8Array(1 + name.length + 1 + (author?.length ?? 0) + dateBytes.length);
  header[0] = name.length;
  header.set(name, 1);
  header[1 + name.length] = author?.length ?? 0;
  if (author) header.set(author, 1 + name.length + 1);
  header.set(dateBytes, 1 + name.length + 1 + (author?.length ?? 0));

  const body = serializeTrackBody(parts, meta);
  const payload = new Uint8Array(header.length + body.length);
  payload.set(header, 0);
  payload.set(body, header.length);

  const inner = pako.deflate(payload, { level: 9, windowBits: 9, memLevel: 9 });
  const innerText = b62Encode(inner);
  const outer = pako.deflate(new TextEncoder().encode(innerText), {
    level: 9,
    windowBits: 15,
    memLevel: 9,
  });
  return 'PolyTrack2' + b62Encode(outer);
}
