/**
 * glTF 2.0 parser — .glb (binary container) and .gltf (JSON), zero
 * dependencies. Walks the scene's node hierarchy applying node transforms
 * (matrix or TRS), reads every TRIANGLES primitive (indexed or not, any
 * component type, interleaved buffer views) and flattens the lot into the
 * mod's triangle soup.
 *
 * Colors: a primitive's COLOR_0 vertex attribute wins (averaged per
 * triangle); otherwise baseColorTexture — emitted as a per-triangle UV +
 * texture channel (`texturing`, sampled PER VOXEL by the voxelizer, tinted
 * by baseColorFactor) with a UV-centroid fallback color; otherwise the flat
 * baseColorFactor. Factors and COLOR_0 are LINEAR per the glTF spec, so
 * everything is encoded to sRGB before byte-packing — the palette matcher
 * and preview expect display-space RGB.
 *
 * Buffers: GLB's BIN chunk backs buffer 0; `data:` URIs are decoded inline;
 * anything else goes through the optional `resolveBuffer` callback (the
 * panel passes sibling files from the same file-picker selection).
 *
 * Textures: image DECODING is async and browser-only, so it stays in the
 * panel — call gltfImageBytes() to get each image's raw bytes, decode them,
 * and pass the pixels back via the `images` array (indexed like doc.images).
 */
import type { MeshTexturing, TriangleMesh } from './types';
import { sampleImage, srgbToLinear, linearToSrgbByte, type DecodedImage } from './texture';

export type BufferResolver = (uri: string) => ArrayBuffer | null;

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export function parseGlb(
  data: ArrayBuffer,
  resolveBuffer?: BufferResolver,
  images?: readonly (DecodedImage | null)[],
): TriangleMesh {
  const view = new DataView(data);
  if (data.byteLength < 12 || view.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error('GLB: not a glTF binary (bad magic)');
  }
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`GLB: unsupported glTF version ${version}`);
  let json: string | null = null;
  let bin: ArrayBuffer | null = null;
  let off = 12;
  while (off + 8 <= data.byteLength) {
    const len = view.getUint32(off, true);
    const type = view.getUint32(off + 4, true);
    const body = data.slice(off + 8, off + 8 + len);
    if (type === CHUNK_JSON) json = new TextDecoder().decode(body);
    else if (type === CHUNK_BIN && !bin) bin = body;
    // Spec says chunk data is already 4-byte padded, but real exporters get
    // this wrong — realign defensively.
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('GLB: missing JSON chunk');
  return parseGltf(json, resolveBuffer, bin, images);
}

export function parseGltf(
  json: string,
  resolveBuffer?: BufferResolver,
  binChunk?: ArrayBuffer | null,
  images?: readonly (DecodedImage | null)[],
): TriangleMesh {
  let doc: GltfDoc;
  try {
    doc = JSON.parse(json) as GltfDoc;
  } catch {
    throw new Error('glTF: invalid JSON');
  }
  if (!doc.asset || !String(doc.asset.version ?? '').startsWith('2')) {
    throw new Error('glTF: only glTF 2.0 is supported');
  }

  const buffers: (ArrayBuffer | null)[] = (doc.buffers ?? []).map((b, i) => {
    if (b.uri === undefined) return i === 0 ? binChunk ?? null : null;
    if (b.uri.startsWith('data:')) return decodeDataUri(b.uri);
    return resolveBuffer?.(b.uri) ?? null;
  });

  const coords: number[] = [];
  const triColors: number[] = []; // r,g,b bytes per triangle, -1 = uncolored
  let sawColor = false;
  // Texture channel for per-voxel sampling (triColors keeps the centroid
  // fallback). UVs in glTF are already image-space (v top-down).
  const triUvs: number[] = [];
  const triTexture: number[] = [];
  const triTints: number[] = [];
  let sawTint = false;
  const outTextures: DecodedImage[] = [];
  const textureIndexOf = new Map<DecodedImage, number>();

  const readAccessor = (index: number): Float32Array => {
    const acc = doc.accessors?.[index];
    if (!acc) throw new Error(`glTF: missing accessor ${index}`);
    const comps = TYPE_COMPONENTS[acc.type ?? ''] ?? 0;
    if (!comps) throw new Error(`glTF: unsupported accessor type ${acc.type}`);
    const info = COMPONENT_TYPES[acc.componentType ?? 0];
    if (!info) throw new Error(`glTF: unsupported componentType ${acc.componentType}`);
    const out = new Float32Array(acc.count * comps);
    if (acc.bufferView === undefined) return out; // spec: zero-filled
    const bv = doc.bufferViews?.[acc.bufferView];
    if (!bv) throw new Error(`glTF: missing bufferView ${acc.bufferView}`);
    const buf = buffers[bv.buffer ?? 0];
    if (!buf) {
      const uri = doc.buffers?.[bv.buffer ?? 0]?.uri ?? '(GLB bin chunk)';
      throw new Error(`glTF: buffer "${uri}" not available — select the .bin alongside the .gltf`);
    }
    const view = new DataView(buf);
    const stride = bv.byteStride ?? comps * info.size;
    const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const norm = acc.normalized === true;
    for (let e = 0; e < acc.count; e++) {
      for (let c = 0; c < comps; c++) {
        let v = info.read(view, base + e * stride + c * info.size);
        if (norm && info.max) v = Math.max(v / info.max, info.signed ? -1 : 0);
        out[e * comps + c] = v;
      }
    }
    return out;
  };

  const emitPrimitive = (prim: GltfPrimitive, matrix: number[] | null): void => {
    if ((prim.mode ?? 4) !== 4) return; // TRIANGLES only; strips/fans/lines skipped
    const posIdx = prim.attributes?.POSITION;
    if (posIdx === undefined) return;
    const pos = readAccessor(posIdx);
    const vertexCount = pos.length / 3;

    let indices: ArrayLike<number>;
    if (prim.indices !== undefined) {
      indices = readAccessor(prim.indices);
    } else {
      const seq = new Uint32Array(vertexCount);
      for (let i = 0; i < vertexCount; i++) seq[i] = i;
      indices = seq;
    }

    // Color precedence: COLOR_0 vertex colors > baseColorTexture sampled at
    // the triangle's UV centroid (× baseColorFactor) > flat baseColorFactor.
    let vcolors: Float32Array | null = null;
    let vcomps = 0;
    const colorIdx = prim.attributes?.COLOR_0;
    if (colorIdx !== undefined) {
      vcolors = readAccessor(colorIdx);
      vcomps = TYPE_COMPONENTS[doc.accessors?.[colorIdx]?.type ?? ''] ?? 0;
      if (vcomps < 3) vcolors = null;
    }
    const mat = prim.material !== undefined ? doc.materials?.[prim.material] : undefined;
    const pbr = mat?.pbrMetallicRoughness;
    const bcf = Array.isArray(pbr?.baseColorFactor) && pbr.baseColorFactor.length >= 3
      ? pbr.baseColorFactor : [1, 1, 1, 1];
    let flat: [number, number, number] | null = null;
    if (pbr?.baseColorFactor) {
      flat = [srgbByte(bcf[0]!), srgbByte(bcf[1]!), srgbByte(bcf[2]!)];
    }
    // Texture path: needs the material to name a texture, the texture to
    // reference a decoded image, and the primitive to carry that UV set.
    let texImage: DecodedImage | null = null;
    let uvs: Float32Array | null = null;
    const texInfo = pbr?.baseColorTexture;
    if (texInfo && images) {
      const tex = doc.textures?.[texInfo.index ?? -1];
      const imgIdx = tex?.source;
      if (imgIdx !== undefined) texImage = images[imgIdx] ?? null;
      const uvIdx = prim.attributes?.[`TEXCOORD_${texInfo.texCoord ?? 0}`];
      if (texImage && uvIdx !== undefined) {
        uvs = readAccessor(uvIdx);
      } else {
        texImage = null;
      }
    }

    // Register the primitive's texture once, not per triangle.
    let texSlot = -1;
    if (texImage && uvs) {
      let ti = textureIndexOf.get(texImage);
      if (ti === undefined) {
        ti = outTextures.length;
        outTextures.push(texImage);
        textureIndexOf.set(texImage, ti);
      }
      texSlot = ti;
    }

    const triCount = Math.floor(indices.length / 3);
    for (let t = 0; t < triCount; t++) {
      let cr = 0, cg = 0, cb = 0;
      let cu = 0, cv = 0;
      const uvFlat: number[] = [];
      for (let k = 0; k < 3; k++) {
        const vi = indices[t * 3 + k]!;
        let x = pos[vi * 3]!, y = pos[vi * 3 + 1]!, z = pos[vi * 3 + 2]!;
        if (matrix) {
          const m = matrix;
          const tx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
          const ty = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
          const tz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
          x = tx; y = ty; z = tz;
        }
        coords.push(x, y, z);
        if (vcolors) {
          cr += vcolors[vi * vcomps]!;
          cg += vcolors[vi * vcomps + 1]!;
          cb += vcolors[vi * vcomps + 2]!;
        }
        if (uvs) {
          const u = uvs[vi * 2]!, v = uvs[vi * 2 + 1]!;
          cu += u;
          cv += v;
          uvFlat.push(u, v);
        }
      }
      if (vcolors) {
        triColors.push(srgbByte(cr / 3), srgbByte(cg / 3), srgbByte(cb / 3));
        sawColor = true;
        triTexture.push(-1);
        triUvs.push(0, 0, 0, 0, 0, 0);
        triTints.push(1, 1, 1);
      } else if (texImage && uvs) {
        // Centroid fallback color; the voxelizer resamples per voxel via the
        // texture channel below. Texture bytes are sRGB, factors linear —
        // multiply in linear space, then back to display bytes.
        const [tr, tg, tb] = sampleImage(texImage, cu / 3, cv / 3);
        triColors.push(
          linearToSrgbByte(srgbToLinear(tr) * bcf[0]!),
          linearToSrgbByte(srgbToLinear(tg) * bcf[1]!),
          linearToSrgbByte(srgbToLinear(tb) * bcf[2]!),
        );
        sawColor = true;
        triTexture.push(texSlot);
        triUvs.push(...uvFlat);
        triTints.push(bcf[0]!, bcf[1]!, bcf[2]!);
        if (bcf[0] !== 1 || bcf[1] !== 1 || bcf[2] !== 1) sawTint = true;
      } else {
        if (flat) {
          triColors.push(flat[0], flat[1], flat[2]);
          sawColor = true;
        } else {
          triColors.push(-1, -1, -1);
        }
        triTexture.push(-1);
        triUvs.push(0, 0, 0, 0, 0, 0);
        triTints.push(1, 1, 1);
      }
    }
  };

  const visitNode = (index: number, parent: number[] | null, depth: number): void => {
    if (depth > 256) return; // cycle guard
    const node = doc.nodes?.[index];
    if (!node) return;
    const local = nodeMatrix(node);
    const world = parent ? (local ? mul4(parent, local) : parent) : local;
    if (node.mesh !== undefined) {
      for (const prim of doc.meshes?.[node.mesh]?.primitives ?? []) emitPrimitive(prim, world);
    }
    for (const child of node.children ?? []) visitNode(child, world, depth + 1);
  };

  const sceneNodes = doc.scenes?.[doc.scene ?? 0]?.nodes
    ?? (doc.nodes ? rootNodes(doc.nodes) : undefined);
  if (sceneNodes && sceneNodes.length > 0) {
    for (const n of sceneNodes) visitNode(n, null, 0);
  } else {
    // No node hierarchy at all — draw every mesh at the origin.
    for (const mesh of doc.meshes ?? []) {
      for (const prim of mesh.primitives ?? []) emitPrimitive(prim, null);
    }
  }

  if (coords.length === 0) throw new Error('glTF: no triangles found');
  const triangleCount = coords.length / 9;
  let colors: Uint8Array | undefined;
  if (sawColor) {
    colors = new Uint8Array(triangleCount * 3);
    for (let t = 0; t < triangleCount; t++) {
      const r = triColors[t * 3]!;
      if (r < 0) {
        colors[t * 3] = 184; colors[t * 3 + 1] = 184; colors[t * 3 + 2] = 184;
      } else {
        colors[t * 3] = r;
        colors[t * 3 + 1] = triColors[t * 3 + 1]!;
        colors[t * 3 + 2] = triColors[t * 3 + 2]!;
      }
    }
  }
  let texturing: MeshTexturing | undefined;
  if (outTextures.length > 0) {
    texturing = {
      uvs: new Float32Array(triUvs),
      triTexture: new Int32Array(triTexture),
      textures: outTextures,
      ...(sawTint ? { tints: new Float32Array(triTints) } : {}),
    };
  }
  return {
    positions: new Float32Array(coords),
    triangleCount,
    ...(colors ? { colors } : {}),
    ...(texturing ? { texturing } : {}),
  };
}

/**
 * The encoded (PNG/JPEG) bytes of every image in a .glb / .gltf, indexed
 * like doc.images — null where the bytes aren't reachable. The panel decodes
 * these (createImageBitmap) and hands the pixels back to parseGlb/parseGltf.
 * Never throws: a model with a broken texture should still import, just
 * without that texture's colors.
 */
export function gltfImageBytes(
  data: ArrayBuffer | string,
  resolveBuffer?: BufferResolver,
): (ArrayBuffer | null)[] {
  try {
    let json: string;
    let bin: ArrayBuffer | null = null;
    if (typeof data === 'string') {
      json = data;
    } else {
      const view = new DataView(data);
      if (data.byteLength < 12 || view.getUint32(0, true) !== GLB_MAGIC) return [];
      let j: string | null = null;
      let off = 12;
      while (off + 8 <= data.byteLength) {
        const len = view.getUint32(off, true);
        const type = view.getUint32(off + 4, true);
        const body = data.slice(off + 8, off + 8 + len);
        if (type === CHUNK_JSON) j = new TextDecoder().decode(body);
        else if (type === CHUNK_BIN && !bin) bin = body;
        off += 8 + len + ((4 - (len % 4)) % 4);
      }
      if (!j) return [];
      json = j;
    }
    const doc = JSON.parse(json) as GltfDoc;
    const buffers: (ArrayBuffer | null)[] = (doc.buffers ?? []).map((b, i) => {
      if (b.uri === undefined) return i === 0 ? bin : null;
      if (b.uri.startsWith('data:')) return decodeDataUri(b.uri);
      return resolveBuffer?.(b.uri) ?? null;
    });
    return (doc.images ?? []).map((img) => {
      if (img.uri !== undefined) {
        if (img.uri.startsWith('data:')) return decodeDataUri(img.uri);
        return resolveBuffer?.(img.uri) ?? null;
      }
      if (img.bufferView === undefined) return null;
      const bv = doc.bufferViews?.[img.bufferView];
      const buf = bv ? buffers[bv.buffer ?? 0] : null;
      if (!bv || !buf) return null;
      const start = bv.byteOffset ?? 0;
      return buf.slice(start, start + (bv.byteLength ?? 0));
    });
  } catch {
    return [];
  }
}

// ---------- internals ----------

interface GltfDoc {
  asset?: { version?: string };
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { primitives?: GltfPrimitive[] }[];
  materials?: {
    pbrMetallicRoughness?: {
      baseColorFactor?: number[];
      baseColorTexture?: { index?: number; texCoord?: number };
    };
  }[];
  textures?: { source?: number }[];
  images?: { uri?: string; bufferView?: number; mimeType?: string }[];
  accessors?: GltfAccessor[];
  bufferViews?: { buffer?: number; byteOffset?: number; byteLength?: number; byteStride?: number }[];
  buffers?: { uri?: string; byteLength?: number }[];
}
interface GltfNode {
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}
interface GltfPrimitive {
  attributes?: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
}
interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType?: number;
  normalized?: boolean;
  count: number;
  type?: string;
}

const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

interface ComponentInfo {
  size: number;
  max: number | null;
  signed: boolean;
  read(view: DataView, off: number): number;
}
const COMPONENT_TYPES: Record<number, ComponentInfo> = {
  5120: { size: 1, max: 127, signed: true, read: (v, o) => v.getInt8(o) },
  5121: { size: 1, max: 255, signed: false, read: (v, o) => v.getUint8(o) },
  5122: { size: 2, max: 32767, signed: true, read: (v, o) => v.getInt16(o, true) },
  5123: { size: 2, max: 65535, signed: false, read: (v, o) => v.getUint16(o, true) },
  5125: { size: 4, max: null, signed: false, read: (v, o) => v.getUint32(o, true) },
  5126: { size: 4, max: null, signed: false, read: (v, o) => v.getFloat32(o, true) },
};

/** Column-major 4×4 multiply: a · b. */
function mul4(a: number[], b: number[]): number[] {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! +
        a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
    }
  }
  return out;
}

/** Node's local transform as a column-major 4×4, or null for identity. */
function nodeMatrix(node: GltfNode): number[] | null {
  if (node.matrix && node.matrix.length === 16) return node.matrix;
  if (!node.translation && !node.rotation && !node.scale) return null;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  // Rotation matrix from the (x,y,z,w) quaternion, columns scaled, then translate.
  const x2 = qx! + qx!, y2 = qy! + qy!, z2 = qz! + qz!;
  const xx = qx! * x2, xy = qx! * y2, xz = qx! * z2;
  const yy = qy! * y2, yz = qy! * z2, zz = qz! * z2;
  const wx = qw! * x2, wy = qw! * y2, wz = qw! * z2;
  return [
    (1 - (yy + zz)) * sx!, (xy + wz) * sx!, (xz - wy) * sx!, 0,
    (xy - wz) * sy!, (1 - (xx + zz)) * sy!, (yz + wx) * sy!, 0,
    (xz + wy) * sz!, (yz - wx) * sz!, (1 - (xx + yy)) * sz!, 0,
    tx!, ty!, tz!, 1,
  ];
}

/** Nodes never referenced as a child = the roots (files without `scenes`). */
function rootNodes(nodes: GltfNode[]): number[] {
  const isChild = new Set<number>();
  for (const n of nodes) for (const c of n.children ?? []) isChild.add(c);
  const roots: number[] = [];
  for (let i = 0; i < nodes.length; i++) if (!isChild.has(i)) roots.push(i);
  return roots;
}

function decodeDataUri(uri: string): ArrayBuffer | null {
  const comma = uri.indexOf(',');
  if (comma === -1) return null;
  const meta = uri.slice(5, comma);
  const body = uri.slice(comma + 1);
  if (meta.endsWith(';base64')) {
    const bin = atob(body);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  return new TextEncoder().encode(decodeURIComponent(body)).buffer as ArrayBuffer;
}

/** Linear 0–1 → sRGB byte (glTF colors are linear; the palette wants display RGB). */
const srgbByte = linearToSrgbByte;
