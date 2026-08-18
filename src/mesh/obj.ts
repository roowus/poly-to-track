/**
 * Wavefront OBJ parser — v/vt/f statements plus material color resolution.
 * Polygon faces are fan-triangulated. Negative indices (relative
 * references) are supported; normals/groups are ignored.
 *
 * Vertex colors use the common extension `v x y z r g b` (Blender, MeshLab
 * and most scanners write it). Components are 0–1 floats unless any exceeds
 * 1, in which case the file is treated as 0–255.
 *
 * MTL: pass the sidecar's parsed materials (see parseMtl) and `usemtl`
 * colors the faces that follow it. A material with a decoded `map_Kd`
 * texture contributes a per-triangle UV + texture channel (`texturing`) that
 * the voxelizer samples PER VOXEL, plus a UV-centroid fallback color;
 * otherwise its flat `Kd` diffuse is used. Vertex colors win over the
 * material where both exist. `mtllib` names are surfaced on the result so
 * the panel can tell the user which file to add; ditto each material's
 * texture filename so the panel can decode it from the same selection.
 */
import type { MeshTexturing, TriangleMesh } from './types';
import { sampleImage, type DecodedImage } from './texture';

export interface MtlMaterial {
  /** Diffuse Kd as RGB bytes (near-white when the MTL names no Kd). */
  readonly kd: readonly [number, number, number];
  /** map_Kd filename exactly as written in the MTL (empty when none). */
  readonly mapKd: string;
  /** Decoded map_Kd pixels — the panel fills this in before parseObj. */
  image?: DecodedImage | null;
}

/** Material name → material. */
export type MtlMaterials = Map<string, MtlMaterial>;

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
  const texcoords: number[] = [];
  const coords: number[] = [];
  const triColors: number[] = [];
  /** material color bytes per triangle (Kd or sampled map_Kd), -1 = none. */
  const triMtl: number[] = [];
  let sawMtlColor = false;
  const mtlLibs: string[] = [];
  let activeMtl: MtlMaterial | null = null;
  // Texture channel: per-triangle image-space UVs + texture index, so the
  // voxelizer can sample a texel PER VOXEL (the triMtl centroid sample above
  // is only the flat fallback).
  const triUvs: number[] = [];
  const triTexture: number[] = [];
  const textures: DecodedImage[] = [];
  const textureIndex = new Map<DecodedImage, number>();

  const resolve = (token: string): { v: number; vt: number } => {
    const parts = token.split('/');
    const raw = parseInt(parts[0]!, 10);
    if (Number.isNaN(raw) || raw === 0) throw new Error(`OBJ: bad face index "${token}"`);
    const idx = raw > 0 ? raw - 1 : vertices.length / 3 + raw;
    if (idx < 0 || idx * 3 + 2 >= vertices.length) throw new Error(`OBJ: face index ${raw} out of range`);
    let vt = -1;
    if (parts.length > 1 && parts[1]) {
      const rawVt = parseInt(parts[1]!, 10);
      if (!Number.isNaN(rawVt) && rawVt !== 0) {
        vt = rawVt > 0 ? rawVt - 1 : texcoords.length / 2 + rawVt;
        if (vt < 0 || vt * 2 + 1 >= texcoords.length) vt = -1;
      }
    }
    return { v: idx, vt };
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
    } else if (s.startsWith('vt ') || s.startsWith('vt\t')) {
      const t = s.split(/\s+/);
      texcoords.push(parseFloat(t[1]!) || 0, parseFloat(t[2]!) || 0);
    } else if (s.startsWith('f ') || s.startsWith('f\t')) {
      const t = s.split(/\s+/).slice(1);
      if (t.length < 3) throw new Error(`OBJ: face with <3 vertices "${s}"`);
      const first = resolve(t[0]!);
      for (let i = 1; i + 1 < t.length; i++) {
        const tri = [first, resolve(t[i]!), resolve(t[i + 1]!)];
        let cr = 0, cg = 0, cb = 0, colored = 0;
        let cu = 0, cv = 0, uvCount = 0;
        const uvFlat: number[] = [];
        for (const { v: idx, vt } of tri) {
          coords.push(vertices[idx * 3]!, vertices[idx * 3 + 1]!, vertices[idx * 3 + 2]!);
          if (vertexColors[idx * 3]! >= 0) {
            cr += vertexColors[idx * 3]!;
            cg += vertexColors[idx * 3 + 1]!;
            cb += vertexColors[idx * 3 + 2]!;
            colored++;
          }
          if (vt >= 0) {
            const u = texcoords[vt * 2]!, v = texcoords[vt * 2 + 1]!;
            cu += u;
            cv += v;
            uvCount++;
            // OBJ v is bottom-up, image rows are top-down — flip here so the
            // stored UVs are image-space (matches glTF and sampleImage).
            uvFlat.push(u, 1 - v);
          }
        }
        // Triangle color = average of its colored vertices (raw scale for now).
        triColors.push(colored ? cr / colored : -1, colored ? cg / colored : -1, colored ? cb / colored : -1);
        const textured = !!activeMtl?.image && uvCount === 3;
        if (activeMtl) {
          if (activeMtl.image && uvCount === 3) {
            // Centroid fallback color (also shown before voxelization).
            const [r, g, b] = sampleImage(activeMtl.image, cu / 3, 1 - cv / 3);
            triMtl.push(r, g, b);
          } else {
            triMtl.push(activeMtl.kd[0], activeMtl.kd[1], activeMtl.kd[2]);
          }
          sawMtlColor = true;
        } else {
          triMtl.push(-1, -1, -1);
        }
        // Texture channel — vertex colors keep precedence, so a triangle with
        // its own colors stays untextured here.
        if (textured && colored === 0) {
          const img = activeMtl!.image!;
          let ti = textureIndex.get(img);
          if (ti === undefined) {
            ti = textures.length;
            textures.push(img);
            textureIndex.set(img, ti);
          }
          triTexture.push(ti);
          triUvs.push(...uvFlat);
        } else {
          triTexture.push(-1);
          triUvs.push(0, 0, 0, 0, 0, 0);
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
  let texturing: MeshTexturing | undefined;
  if (textures.length > 0) {
    texturing = {
      uvs: new Float32Array(triUvs),
      triTexture: new Int32Array(triTexture),
      textures,
    };
  }
  return {
    positions: new Float32Array(coords),
    triangleCount,
    mtlLibs,
    ...(colors ? { colors } : {}),
    ...(texturing ? { texturing } : {}),
  };
}

/**
 * MTL sidecar parser: material name → diffuse color (Kd, 0–1 floats → RGB
 * bytes) + map_Kd texture filename. Materials without Kd fall back to
 * near-white — a named material should still register so `usemtl` doesn't
 * silently miss. map_Kd options (-o, -s, -blendu …) are skipped; the
 * filename is the last token(s) after the options.
 */
export function parseMtl(text: string): MtlMaterials {
  const out: MtlMaterials = new Map();
  let current: MtlMaterial | null = null;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (s.startsWith('newmtl')) {
      const name = s.slice(6).trim();
      current = name ? { kd: [230, 230, 230], mapKd: '' } : null;
      if (name && current && !out.has(name)) out.set(name, current);
    } else if (current && (s.startsWith('Kd ') || s.startsWith('Kd\t'))) {
      const t = s.split(/\s+/);
      const r = parseFloat(t[1]!), g = parseFloat(t[2]!), b = parseFloat(t[3]!);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        (current as { kd: readonly [number, number, number] }).kd =
          [clampByte(r * 255), clampByte(g * 255), clampByte(b * 255)];
      }
    } else if (current && /^map_Kd\s/i.test(s)) {
      (current as { mapKd: string }).mapKd = mapKdFilename(s);
    }
  }
  return out;
}

/** Strip `map_Kd` and its dash-options; what remains is the filename. */
function mapKdFilename(line: string): string {
  const tokens = line.split(/\s+/).slice(1);
  let i = 0;
  const OPTION_ARGS: Record<string, number> = {
    '-blendu': 1, '-blendv': 1, '-cc': 1, '-clamp': 1, '-mm': 2,
    '-o': 3, '-s': 3, '-t': 3, '-texres': 1, '-imfchan': 1, '-boost': 1, '-bm': 1,
  };
  while (i < tokens.length && tokens[i]!.startsWith('-')) {
    i += 1 + (OPTION_ARGS[tokens[i]!.toLowerCase()] ?? 1);
  }
  return tokens.slice(i).join(' ');
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}
