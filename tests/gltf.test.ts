import { describe, expect, it } from 'vitest';
import { parseGlb, parseGltf, gltfImageBytes } from '../src/mesh/gltf';
import { sampleImage } from '../src/mesh/texture';
import { meshBounds } from '../src/mesh/types';

/**
 * Fixture builder: one triangle (0,0,0) (1,0,0) (0,1,0), indexed, optional
 * per-vertex COLOR_0 floats and/or a material baseColorFactor. Returns the
 * glTF JSON doc plus its binary buffer so tests can serve it as embedded
 * data: URI, GLB BIN chunk, or an external sidecar.
 */
function triangleDoc(opts: {
  color0?: number[][]; // per-vertex linear RGB(A) floats
  baseColorFactor?: number[];
  node?: Record<string, unknown>; // extra node properties (matrix/TRS)
  omitScenes?: boolean;
  uv?: number[][]; // per-vertex texcoords — adds TEXCOORD_0
  textureUri?: string; // image by external URI (with opts.uv wires baseColorTexture)
} = {}): { doc: Record<string, unknown>; bin: ArrayBuffer } {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 1, 2, 0]); // padded to 4 bytes
  const colorComps = opts.color0?.[0]?.length ?? 0;
  const colors = opts.color0 ? new Float32Array(opts.color0.flat()) : null;
  const uvs = opts.uv ? new Float32Array(opts.uv.flat()) : null;

  const parts: ArrayBuffer[] = [positions.buffer, indices.buffer];
  if (colors) parts.push(colors.buffer as ArrayBuffer);
  if (uvs) parts.push(uvs.buffer as ArrayBuffer);
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const bin = new ArrayBuffer(total);
  const bytes = new Uint8Array(bin);
  let off = 0;
  const offsets: number[] = [];
  for (const p of parts) {
    offsets.push(off);
    bytes.set(new Uint8Array(p), off);
    off += p.byteLength;
  }

  const bufferViews: Record<string, unknown>[] = [
    { buffer: 0, byteOffset: offsets[0], byteLength: positions.byteLength },
    { buffer: 0, byteOffset: offsets[1], byteLength: 6 },
  ];
  const accessors: Record<string, unknown>[] = [
    { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
    { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
  ];
  const attributes: Record<string, number> = { POSITION: 0 };
  if (colors) {
    bufferViews.push({ buffer: 0, byteOffset: offsets[2], byteLength: colors.byteLength });
    accessors.push({ bufferView: 2, componentType: 5126, count: 3, type: colorComps === 4 ? 'VEC4' : 'VEC3' });
    attributes.COLOR_0 = 2;
  }
  if (uvs) {
    const partIdx = colors ? 3 : 2;
    bufferViews.push({ buffer: 0, byteOffset: offsets[partIdx], byteLength: uvs.byteLength });
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: 3, type: 'VEC2' });
    attributes.TEXCOORD_0 = accessors.length - 1;
  }
  const primitive: Record<string, unknown> = { attributes, indices: 1 };
  const doc: Record<string, unknown> = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: total }],
    bufferViews,
    accessors,
    meshes: [{ primitives: [primitive] }],
    nodes: [{ mesh: 0, ...(opts.node ?? {}) }],
    ...(opts.omitScenes ? {} : { scene: 0, scenes: [{ nodes: [0] }] }),
  };
  if (opts.baseColorFactor || opts.textureUri) {
    primitive.material = 0;
    const pbr: Record<string, unknown> = {};
    if (opts.baseColorFactor) pbr.baseColorFactor = opts.baseColorFactor;
    if (opts.textureUri) {
      pbr.baseColorTexture = { index: 0 };
      doc.textures = [{ source: 0 }];
      doc.images = [{ uri: opts.textureUri }];
    }
    doc.materials = [{ pbrMetallicRoughness: pbr }];
  }
  return { doc, bin };
}

function toGlb(doc: Record<string, unknown>, bin: ArrayBuffer): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(doc));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = (4 - (bin.byteLength % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + bin.byteLength + binPad;
  const out = new ArrayBuffer(total);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length + jsonPad, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(jsonBytes, 20);
  bytes.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad); // JSON pads with spaces
  const binHeader = 20 + jsonBytes.length + jsonPad;
  view.setUint32(binHeader, bin.byteLength + binPad, true);
  view.setUint32(binHeader + 4, 0x004e4942, true);
  bytes.set(new Uint8Array(bin), binHeader + 8);
  return out;
}

function toDataUriGltf(doc: Record<string, unknown>, bin: ArrayBuffer): string {
  const b64 = Buffer.from(bin).toString('base64');
  const withUri = { ...doc, buffers: [{ byteLength: bin.byteLength, uri: `data:application/octet-stream;base64,${b64}` }] };
  return JSON.stringify(withUri);
}

describe('parseGlb', () => {
  it('parses a minimal binary glTF', () => {
    const { doc, bin } = triangleDoc();
    const mesh = parseGlb(toGlb(doc, bin));
    expect(mesh.triangleCount).toBe(1);
    const b = meshBounds(mesh);
    expect(b.min).toEqual([0, 0, 0]);
    expect(b.max).toEqual([1, 1, 0]);
    expect(mesh.colors).toBeUndefined();
  });

  it('rejects non-GLB data', () => {
    expect(() => parseGlb(new ArrayBuffer(16))).toThrow(/magic/i);
  });

  it('reads material baseColorFactor as sRGB triangle color', () => {
    const { doc, bin } = triangleDoc({ baseColorFactor: [1, 0, 0, 1] });
    const mesh = parseGlb(toGlb(doc, bin));
    expect([...mesh.colors!]).toEqual([255, 0, 0]);
  });

  it('COLOR_0 vertex colors win over the material', () => {
    const { doc, bin } = triangleDoc({
      color0: [[0, 1, 0], [0, 1, 0], [0, 1, 0]],
      baseColorFactor: [1, 0, 0, 1],
    });
    const mesh = parseGlb(toGlb(doc, bin));
    expect([...mesh.colors!]).toEqual([0, 255, 0]);
  });

  it('linear COLOR_0 is sRGB-encoded (0.5 linear ≈ 188)', () => {
    const { doc, bin } = triangleDoc({ color0: [[0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]] });
    const mesh = parseGlb(toGlb(doc, bin));
    expect(mesh.colors![0]).toBe(188);
  });

  it('VEC4 COLOR_0 ignores alpha', () => {
    const { doc, bin } = triangleDoc({ color0: [[0, 0, 1, 0.25], [0, 0, 1, 0.25], [0, 0, 1, 0.25]] });
    const mesh = parseGlb(toGlb(doc, bin));
    expect([...mesh.colors!]).toEqual([0, 0, 255]);
  });

  it('applies node TRS transforms', () => {
    const { doc, bin } = triangleDoc({ node: { translation: [10, 0, 0], scale: [2, 2, 2] } });
    const mesh = parseGlb(toGlb(doc, bin));
    const b = meshBounds(mesh);
    expect(b.min[0]).toBeCloseTo(10);
    expect(b.max[0]).toBeCloseTo(12);
    expect(b.max[1]).toBeCloseTo(2);
  });

  it('applies node matrix transforms through a parent chain', () => {
    const { doc, bin } = triangleDoc();
    // parent translates +5x (column-major), child holds the mesh
    (doc.nodes as Record<string, unknown>[]).unshift({
      children: [1],
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1],
    });
    (doc.scenes as { nodes: number[] }[])[0]!.nodes = [0];
    const mesh = parseGlb(toGlb(doc, bin));
    expect(meshBounds(mesh).min[0]).toBeCloseTo(5);
  });

  it('quaternion rotation: 90° about Z maps +X to +Y', () => {
    const s = Math.SQRT1_2;
    const { doc, bin } = triangleDoc({ node: { rotation: [0, 0, s, s] } });
    const mesh = parseGlb(toGlb(doc, bin));
    const b = meshBounds(mesh);
    expect(b.max[1]).toBeCloseTo(1); // the (1,0,0) vertex landed at (0,1,0)
    expect(b.min[0]).toBeCloseTo(-1); // the (0,1,0) vertex landed at (-1,0,0)
  });

  it('falls back to root nodes when the file has no scenes array', () => {
    const { doc, bin } = triangleDoc({ omitScenes: true });
    const mesh = parseGlb(toGlb(doc, bin));
    expect(mesh.triangleCount).toBe(1);
  });
});

describe('parseGltf (JSON)', () => {
  it('decodes embedded base64 data: URI buffers', () => {
    const { doc, bin } = triangleDoc({ baseColorFactor: [0, 0, 0, 1] });
    const mesh = parseGltf(toDataUriGltf(doc, bin));
    expect(mesh.triangleCount).toBe(1);
    expect([...mesh.colors!]).toEqual([0, 0, 0].map(() => 0));
  });

  it('resolves external .bin buffers through the callback', () => {
    const { doc, bin } = triangleDoc();
    const withUri = { ...doc, buffers: [{ byteLength: bin.byteLength, uri: 'model.bin' }] };
    const mesh = parseGltf(JSON.stringify(withUri), (uri) => (uri === 'model.bin' ? bin : null));
    expect(mesh.triangleCount).toBe(1);
  });

  it('names the missing buffer when the sidecar was not selected', () => {
    const { doc, bin } = triangleDoc();
    const withUri = { ...doc, buffers: [{ byteLength: bin.byteLength, uri: 'model.bin' }] };
    expect(() => parseGltf(JSON.stringify(withUri))).toThrow(/model\.bin/);
  });

  it('rejects glTF 1.0', () => {
    expect(() => parseGltf(JSON.stringify({ asset: { version: '1.0' } }))).toThrow(/2\.0/);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseGltf('not json')).toThrow(/JSON/i);
  });

  it('non-indexed primitives use sequential vertices', () => {
    const { doc, bin } = triangleDoc();
    const prim = (doc.meshes as { primitives: Record<string, unknown>[] }[])[0]!.primitives[0]!;
    delete prim.indices;
    const mesh = parseGlb(toGlb(doc, bin));
    expect(mesh.triangleCount).toBe(1);
    expect(meshBounds(mesh).max).toEqual([1, 1, 0]);
  });

  it('skips non-TRIANGLES primitives', () => {
    const { doc, bin } = triangleDoc();
    const prim = (doc.meshes as { primitives: Record<string, unknown>[] }[])[0]!.primitives[0]!;
    prim.mode = 1; // LINES
    expect(() => parseGlb(toGlb(doc, bin))).toThrow(/no triangles/i);
  });
});

describe('glTF textures', () => {
  // 2×2 texture: top row red|green, bottom row blue|white (sRGB bytes).
  const IMG = {
    width: 2,
    height: 2,
    data: new Uint8Array([
      255, 0, 0, 255,   0, 255, 0, 255,
      0, 0, 255, 255,   255, 255, 255, 255,
    ]),
  };
  const UV_TOP_LEFT = [[0.1, 0.1], [0.3, 0.2], [0.2, 0.3]]; // centroid (0.2, 0.2)

  it('samples baseColorTexture at the UV centroid', () => {
    const { doc, bin } = triangleDoc({ uv: UV_TOP_LEFT, textureUri: 'tex.png' });
    const mesh = parseGlb(toGlb(doc, bin), undefined, [IMG]);
    expect([...mesh.colors!]).toEqual([255, 0, 0]); // glTF v=0.2 = top row
  });

  it('multiplies the texture by baseColorFactor in linear space', () => {
    const { doc, bin } = triangleDoc({
      uv: [[0.6, 0.6], [0.9, 0.7], [0.7, 0.9]], // centroid in the white texel
      textureUri: 'tex.png',
      baseColorFactor: [1, 0, 0, 1],
    });
    const mesh = parseGlb(toGlb(doc, bin), undefined, [IMG]);
    expect([...mesh.colors!]).toEqual([255, 0, 0]); // white texel × red factor
  });

  it('COLOR_0 vertex colors beat the texture', () => {
    const { doc, bin } = triangleDoc({
      uv: UV_TOP_LEFT,
      textureUri: 'tex.png',
      color0: [[0, 0, 1], [0, 0, 1], [0, 0, 1]],
    });
    const mesh = parseGlb(toGlb(doc, bin), undefined, [IMG]);
    expect([...mesh.colors!]).toEqual([0, 0, 255]);
  });

  it('an undecoded image falls back to the flat factor', () => {
    const { doc, bin } = triangleDoc({
      uv: UV_TOP_LEFT, textureUri: 'tex.png', baseColorFactor: [0, 1, 0, 1],
    });
    const mesh = parseGlb(toGlb(doc, bin), undefined, [null]);
    expect([...mesh.colors!]).toEqual([0, 255, 0]);
  });

  it('UV wrap repeats outside 0–1', () => {
    expect(sampleImage(IMG, 1.1, 2.1)).toEqual([255, 0, 0]); // wraps to (0.1, 0.1)
    expect(sampleImage(IMG, -0.4, 0.1)).toEqual([0, 255, 0]); // u −0.4 → 0.6
  });

  it('gltfImageBytes extracts bufferView-embedded and data:-URI images', () => {
    const fakePng = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
    const { doc, bin } = triangleDoc();
    // Append the "png" to the bin buffer as an extra bufferView image.
    const merged = new Uint8Array(bin.byteLength + fakePng.length);
    merged.set(new Uint8Array(bin), 0);
    merged.set(fakePng, bin.byteLength);
    (doc.bufferViews as Record<string, unknown>[]).push({
      buffer: 0, byteOffset: bin.byteLength, byteLength: fakePng.length,
    });
    (doc.buffers as { byteLength: number }[])[0]!.byteLength = merged.byteLength;
    doc.images = [
      { bufferView: (doc.bufferViews as unknown[]).length - 1, mimeType: 'image/png' },
      { uri: 'data:image/png;base64,' + Buffer.from(fakePng).toString('base64') },
      { uri: 'external.png' },
    ];
    const out = gltfImageBytes(toGlb(doc, merged.buffer as ArrayBuffer));
    expect(out).toHaveLength(3);
    expect([...new Uint8Array(out[0]!)]).toEqual([...fakePng]);
    expect([...new Uint8Array(out[1]!)]).toEqual([...fakePng]);
    expect(out[2]).toBeNull(); // no resolver given
    // With a resolver, the external URI resolves too.
    const out2 = gltfImageBytes(toGlb(doc, merged.buffer as ArrayBuffer), (uri) =>
      uri === 'external.png' ? fakePng.buffer as ArrayBuffer : null);
    expect(out2[2]).not.toBeNull();
  });
});
