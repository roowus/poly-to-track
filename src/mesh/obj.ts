/**
 * Wavefront OBJ parser — v/f statements only (normals, uvs, materials,
 * groups ignored). Polygon faces are fan-triangulated. Negative indices
 * (relative references) are supported.
 */
import type { TriangleMesh } from './types';

export function parseObj(text: string): TriangleMesh {
  const vertices: number[] = [];
  const coords: number[] = [];

  const resolve = (token: string): number => {
    const slash = token.indexOf('/');
    const raw = parseInt(slash === -1 ? token : token.slice(0, slash), 10);
    if (Number.isNaN(raw) || raw === 0) throw new Error(`OBJ: bad face index "${token}"`);
    const idx = raw > 0 ? raw - 1 : vertices.length / 3 + raw;
    if (idx < 0 || idx * 3 + 2 >= vertices.length) throw new Error(`OBJ: face index ${raw} out of range`);
    return idx;
  };

  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (s.startsWith('v ') || s.startsWith('v\t')) {
      const t = s.split(/\s+/);
      if (t.length < 4) throw new Error(`OBJ: bad vertex line "${s}"`);
      vertices.push(parseFloat(t[1]!), parseFloat(t[2]!), parseFloat(t[3]!));
    } else if (s.startsWith('f ') || s.startsWith('f\t')) {
      const t = s.split(/\s+/).slice(1);
      if (t.length < 3) throw new Error(`OBJ: face with <3 vertices "${s}"`);
      const first = resolve(t[0]!);
      for (let i = 1; i + 1 < t.length; i++) {
        const a = first, b = resolve(t[i]!), c = resolve(t[i + 1]!);
        for (const idx of [a, b, c]) {
          coords.push(vertices[idx * 3]!, vertices[idx * 3 + 1]!, vertices[idx * 3 + 2]!);
        }
      }
    }
  }
  if (coords.length === 0) throw new Error('OBJ: no faces found (only v/f statements are supported)');
  return { positions: new Float32Array(coords), triangleCount: coords.length / 9 };
}
