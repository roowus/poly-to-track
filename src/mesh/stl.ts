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
  const positions = new Float32Array(count * 9);
  let w = 0;
  for (let i = 0; i < count; i++) {
    const base = 84 + i * 50 + 12; // skip the normal
    for (let f = 0; f < 9; f++) {
      positions[w++] = view.getFloat32(base + f * 4, true);
    }
  }
  return { positions, triangleCount: count };
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
