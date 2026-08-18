import { describe, expect, it } from 'vitest';
import { parseGlb, parseGltf } from '../src/mesh/gltf';
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
} = {}): { doc: Record<string, unknown>; bin: ArrayBuffer } {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 1, 2, 0]); // padded to 4 bytes
  const colorComps = opts.color0?.[0]?.length ?? 0;
  const colors = opts.color0 ? new Float32Array(opts.color0.flat()) : null;

  const parts: ArrayBuffer[] = [positions.buffer, indices.buffer];
  if (colors) parts.push(colors.buffer as ArrayBuffer);
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
  if (opts.baseColorFactor) {
    primitive.material = 0;
    doc.materials = [{ pbrMetallicRoughness: { baseColorFactor: opts.baseColorFactor } }];
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
