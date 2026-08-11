/**
 * STL parser — binary and ASCII, zero dependencies.
 *
 * Binary layout: 80-byte header, u32le triangle count, then per triangle
 * 12 floats (normal + 3 vertices) + u16 attribute byte count.
 */
import type { TriangleMesh } from './types';

export function parseStl(data: ArrayBuffer): TriangleMesh {
  if (isAsciiStl(data)) return parseAsciiStl(new TextDecoder().decode(data));
  return parseBinaryStl(data);
}

function isAsciiStl(data: ArrayBuffer): boolean {
  if (data.byteLength < 84) return true;
  const head = new TextDecoder().decode(data.slice(0, 5)).toLowerCase();
  if (head !== 'solid') return false;
  // "solid" headers can still be binary; trust the binary size invariant.
  const count = new DataView(data).getUint32(80, true);
  return data.byteLength !== 84 + count * 50;
}

function parseBinaryStl(data: ArrayBuffer): TriangleMesh {
  if (data.byteLength < 84) throw new Error('STL: file too short for a binary STL');
  const view = new DataView(data);
  const count = view.getUint32(80, true);
  if (data.byteLength < 84 + count * 50) {
    throw new Error(`STL: truncated — header claims ${count} triangles`);
  }
  // Two per-facet color conventions share the 16-bit attribute field:
  // VisCAM/SolidView — bit15=1 marks a valid color, blue in the LOW bits;
  // Materialise Magics — header contains "COLOR=", bit15=0 means "this facet
  // has its own color", RED in the low bits. 5 bits per channel either way.
  const magics = new TextDecoder().decode(data.slice(0, 80)).includes('COLOR=');
  const positions = new Float32Array(count * 9);
  const colors = new Uint8Array(count * 3);
  let sawColor = false;
  let w = 0;
  for (let i = 0; i < count; i++) {
    const base = 84 + i * 50 + 12; // skip the normal
    for (let f = 0; f < 9; f++) {
      positions[w++] = view.getFloat32(base + f * 4, true);
    }
    const attr = view.getUint16(base + 36, true);
    const valid = magics ? (attr & 0x8000) === 0 : (attr & 0x8000) !== 0;
    if (valid && attr !== 0) {
      const lo = (attr & 31) << 3, mid = ((attr >> 5) & 31) << 3, hi = ((attr >> 10) & 31) << 3;
      colors[i * 3] = magics ? lo : hi;      // red
      colors[i * 3 + 1] = mid;               // green
      colors[i * 3 + 2] = magics ? hi : lo;  // blue
      sawColor = true;
    } else {
      colors[i * 3] = 184; colors[i * 3 + 1] = 184; colors[i * 3 + 2] = 184;
    }
  }
  return { positions, triangleCount: count, ...(sawColor ? { colors } : {}) };
}

function parseAsciiStl(text: string): TriangleMesh {
  const coords: number[] = [];
  const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    coords.push(parseFloat(m[1]!), parseFloat(m[2]!), parseFloat(m[3]!));
  }
  if (coords.length === 0 || coords.length % 9 !== 0) {
    throw new Error(`STL: expected vertex triples in facets, got ${coords.length / 3} vertices`);
  }
  return { positions: new Float32Array(coords), triangleCount: coords.length / 9 };
}
