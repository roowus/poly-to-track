/**
 * Tests-only decoder for the legacy "v2…" track-code format, mirroring the
 * game's own parser (0.6.2 chunk 1648.js). Community archives (e.g.
 * polytrackcodes) still hold v2 codes; the game upconverts them on import.
 *
 * v2 layout: "v2" ++ b62(nameLen u8) ++ b62(nameUtf8) ++ b62(deflate(body))
 * body: repeated { partId u16le, count u32le, per part:
 *   x u24le - 8388608, y u24le, z u24le - 8388608, rotation u8,
 *   [checkpointOrder u16le for checkpoint ids] }
 * Upconversion multiplies x/z by 4 (current coords are tile-grid; a full
 * Block spans 4×4 tiles), keeps y, forces YPositive axis + Default color.
 */
import { inflate } from 'pako';
import { b62Decode } from '../../src/codec/b62';
import { AXIS, CHECKPOINT_PART_IDS, COLOR, START_PART_IDS, type PlacedPart } from '../../src/codec/parts';

const PART_ID_MAX = 185; // ids 0..185 exist in 0.6.2
const LEGACY_SLOPE_WITH_PILLAR = 40; // v2-only id → Slope(4) + PillarTopSlope(168)

export interface V2Track {
  readonly name: string;
  readonly parts: PlacedPart[];
}

export function fromV2ExportString(code: string): V2Track | null {
  if (!code.startsWith('v2')) return null;
  const lenBytes = b62Decode(code.substring(2, 4));
  if (lenBytes === null || lenBytes.length !== 1) return null;
  const nameChars = Math.ceil((lenBytes[0]! / 3) * 4);
  const nameBytes = b62Decode(code.substring(4, 4 + nameChars));
  if (nameBytes === null) return null;
  const name = new TextDecoder('utf-8').decode(nameBytes);

  const packed = b62Decode(code.substring(4 + nameChars));
  if (packed === null) return null;
  let body: Uint8Array;
  try {
    body = inflate(packed);
  } catch {
    return null;
  }

  const parts: PlacedPart[] = [];
  let p = 0;
  while (p < body.length) {
    if (body.length - p < 6) return null;
    let partId = body[p]! | (body[p + 1]! << 8);
    p += 2;
    let extraPartId: number | null = null;
    if (partId === LEGACY_SLOPE_WITH_PILLAR) {
      partId = 4;
      extraPartId = 168;
    }
    if (partId > PART_ID_MAX) return null;
    const count = (body[p]! | (body[p + 1]! << 8) | (body[p + 2]! << 16) | (body[p + 3]! << 24)) >>> 0;
    p += 4;
    for (let i = 0; i < count; i++) {
      if (body.length - p < 10) return null;
      const x = (body[p]! | (body[p + 1]! << 8) | (body[p + 2]! << 16)) - 8388608;
      const y = body[p + 3]! | (body[p + 4]! << 8) | (body[p + 5]! << 16);
      const z = (body[p + 6]! | (body[p + 7]! << 8) | (body[p + 8]! << 16)) - 8388608;
      const rotation = body[p + 9]!;
      p += 10;
      if (rotation > 3) return null;
      let checkpointOrder: number | undefined;
      if ((CHECKPOINT_PART_IDS as readonly number[]).includes(partId)) {
        if (body.length - p < 2) return null;
        checkpointOrder = body[p]! | (body[p + 1]! << 8);
        p += 2;
      }
      let startOrder: number | undefined;
      if ((START_PART_IDS as readonly number[]).includes(partId)) {
        startOrder = i === count - 1 ? 1 : 0;
      }
      const base = {
        x: x * 4,
        y,
        z: z * 4,
        rotation,
        rotationAxis: AXIS.YPositive,
        color: COLOR.Default,
      };
      if (extraPartId !== null) {
        parts.push({ ...base, partId: extraPartId });
      }
      parts.push({ ...base, partId, ...(checkpointOrder !== undefined && { checkpointOrder }), ...(startOrder !== undefined && { startOrder }) });
    }
  }
  return { name, parts };
}
