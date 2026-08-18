/**
 * Wavefront OBJ parser — v/f statements plus material color resolution.
 * Polygon faces are fan-triangulated. Negative indices (relative
 * references) are supported; normals/uvs/groups are ignored.
 *
 * Vertex colors use the common extension `v x y z r g b` (Blender, MeshLab
 * and most scanners write it). Components are 0–1 floats unless any exceeds
 * 1, in which case the file is treated as 0–255.
 *
 * MTL: pass the sidecar's parsed materials (see parseMtl) and `usemtl`
 * colors the faces that follow it with the material's diffuse Kd. Vertex
 * colors win over the material where both exist. `mtllib` names are
 * surfaced on the result so the panel can tell the user which file to add.
 */
import type { TriangleMesh } from './types';

/** Material name → diffuse RGB bytes. */
export type MtlMaterials = Map<string, readonly [number, number, number]>;

export interface ObjMesh extends TriangleMesh {
  /** Files named by `mtllib` statements (empty when the OBJ names none). */
  readonly mtlLibs: readonly string[];
}

export function parseObj(text: string, materials?: MtlMaterials): ObjMesh {
  const vertices: number[] = [];
  /** r,g,b per vertex, −1 marks "no color on this vertex". */
  const vertexColors: number[] = [];
  let sawColor = false;
  let maxComponent = 0;
  const coords: number[] = [];
  const triColors: number[] = [];
  /** Kd bytes per triangle from the active `usemtl`, -1 = no material. */
  const triMtl: number[] = [];
  let sawMtlColor = false;
  const mtlLibs: string[] = [];
  let activeMtl: readonly [number, number, number] | null = null;

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
      if (t.length >= 7) {
        const r = parseFloat(t[4]!), g = parseFloat(t[5]!), b = parseFloat(t[6]!);
        if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
          vertexColors.push(r, g, b);
          maxComponent = Math.max(maxComponent, r, g, b);
          sawColor = true;
        } else {
          vertexColors.push(-1, -1, -1);
        }
      } else {
        vertexColors.push(-1, -1, -1);
      }
    } else if (s.startsWith('f ') || s.startsWith('f\t')) {
      const t = s.split(/\s+/).slice(1);
      if (t.length < 3) throw new Error(`OBJ: face with <3 vertices "${s}"`);
      const first = resolve(t[0]!);
      for (let i = 1; i + 1 < t.length; i++) {
        const tri = [first, resolve(t[i]!), resolve(t[i + 1]!)];
        let cr = 0, cg = 0, cb = 0, colored = 0;
        for (const idx of tri) {
          coords.push(vertices[idx * 3]!, vertices[idx * 3 + 1]!, vertices[idx * 3 + 2]!);
          if (vertexColors[idx * 3]! >= 0) {
            cr += vertexColors[idx * 3]!;
            cg += vertexColors[idx * 3 + 1]!;
            cb += vertexColors[idx * 3 + 2]!;
            colored++;
          }
        }
        // Triangle color = average of its colored vertices (raw scale for now).
        triColors.push(colored ? cr / colored : -1, colored ? cg / colored : -1, colored ? cb / colored : -1);
        if (activeMtl) {
          triMtl.push(activeMtl[0], activeMtl[1], activeMtl[2]);
          sawMtlColor = true;
        } else {
          triMtl.push(-1, -1, -1);
        }
      }
    } else if (s.startsWith('mtllib ')) {
      // Everything after the keyword is the filename (spaces allowed).
      const name = s.slice(7).trim();
      if (name) mtlLibs.push(name);
    } else if (s.startsWith('usemtl')) {
      const name = s.slice(6).trim();
      activeMtl = (name && materials?.get(name)) || null;
    }
  }
  if (coords.length === 0) throw new Error('OBJ: no faces found (only v/f statements are supported)');

  const triangleCount = coords.length / 9;
  let colors: Uint8Array | undefined;
  if (sawColor || sawMtlColor) {
    // 0–1 floats normally; a file with any component >1 is using 0–255.
    const scale = maxComponent > 1 ? 1 : 255;
    colors = new Uint8Array(triangleCount * 3);
    for (let t = 0; t < triangleCount; t++) {
      const r = triColors[t * 3]!;
      if (r >= 0) {
        colors[t * 3] = clampByte(r * scale);
        colors[t * 3 + 1] = clampByte(triColors[t * 3 + 1]! * scale);
        colors[t * 3 + 2] = clampByte(triColors[t * 3 + 2]! * scale);
      } else if (triMtl[t * 3]! >= 0) {
        colors[t * 3] = triMtl[t * 3]!;
        colors[t * 3 + 1] = triMtl[t * 3 + 1]!;
        colors[t * 3 + 2] = triMtl[t * 3 + 2]!;
      } else {
        colors[t * 3] = 184; colors[t * 3 + 1] = 184; colors[t * 3 + 2] = 184;
      }
    }
  }
  return { positions: new Float32Array(coords), triangleCount, mtlLibs, ...(colors ? { colors } : {}) };
}

/**
 * MTL sidecar parser: material name → diffuse color (Kd) as RGB bytes.
 * Kd values are 0–1 floats. Materials without Kd fall back to white — a
 * named material should still register so `usemtl` doesn't silently miss.
 */
export function parseMtl(text: string): MtlMaterials {
  const out: Map<string, readonly [number, number, number]> = new Map();
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (s.startsWith('newmtl')) {
      current = s.slice(6).trim();
      if (current && !out.has(current)) out.set(current, [230, 230, 230]);
    } else if (current && (s.startsWith('Kd ') || s.startsWith('Kd\t'))) {
      const t = s.split(/\s+/);
      const r = parseFloat(t[1]!), g = parseFloat(t[2]!), b = parseFloat(t[3]!);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        out.set(current, [clampByte(r * 255), clampByte(g * 255), clampByte(b * 255)]);
      }
    }
  }
  return out;
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}
