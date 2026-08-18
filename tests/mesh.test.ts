import { describe, expect, it } from 'vitest';
import { parseMtl, parseObj } from '../src/mesh/obj';
import { parseStl } from '../src/mesh/stl';
import { applyTransform, IDENTITY } from '../src/mesh/transform';
import { meshBounds } from '../src/mesh/types';

/** A unit cube as ASCII OBJ (8 vertices, 12 triangles via quad faces). */
const CUBE_OBJ = `
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
v 0 0 1
v 1 0 1
v 1 1 1
v 0 1 1
f 1 2 3 4
f 5 8 7 6
f 1 5 6 2
f 2 6 7 3
f 3 7 8 4
f 4 8 5 1
`;

function binaryStlCube(): ArrayBuffer {
  // one triangle is enough to exercise the binary path
  const tris = [
    [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
    [[0, 0, 0], [0, 1, 0], [0, 0, 1]],
  ];
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const view = new DataView(buf);
  view.setUint32(80, tris.length, true);
  tris.forEach((tri, i) => {
    const base = 84 + i * 50 + 12;
    tri.forEach((v, j) => {
      view.setFloat32(base + j * 12 + 0, v[0]!, true);
      view.setFloat32(base + j * 12 + 4, v[1]!, true);
      view.setFloat32(base + j * 12 + 8, v[2]!, true);
    });
  });
  return buf;
}

describe('parseObj', () => {
  it('fan-triangulates quad faces', () => {
    const mesh = parseObj(CUBE_OBJ);
    expect(mesh.triangleCount).toBe(12);
    const b = meshBounds(mesh);
    expect(b.min).toEqual([0, 0, 0]);
    expect(b.max).toEqual([1, 1, 1]);
  });

  it('supports v/vt/vn face syntax and negative indices', () => {
    const mesh = parseObj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3/1/1 -2/2/2 -1/3/3');
    expect(mesh.triangleCount).toBe(1);
  });

  it('throws on empty input', () => {
    expect(() => parseObj('# nothing')).toThrow(/no faces/i);
  });

  it('reads vertex colors (v x y z r g b, 0–1 floats)', () => {
    const mesh = parseObj('v 0 0 0 1 0 0\nv 1 0 0 1 0 0\nv 0 1 0 1 0 0\nf 1 2 3');
    expect(mesh.colors).toBeDefined();
    expect([...mesh.colors!]).toEqual([255, 0, 0]);
  });

  it('treats components >1 as a 0–255 file', () => {
    const mesh = parseObj('v 0 0 0 255 128 0\nv 1 0 0 255 128 0\nv 0 1 0 255 128 0\nf 1 2 3');
    expect([...mesh.colors!]).toEqual([255, 128, 0]);
  });

  it('averages colored vertices and grays out uncolored triangles', () => {
    const obj = [
      'v 0 0 0 1 0 0', // red
      'v 1 0 0 0 0 1', // blue
      'v 0 1 0',       // uncolored — excluded from the average
      'v 2 2 2', 'v 3 2 2', 'v 2 3 2', // all uncolored
      'f 1 2 3',
      'f 4 5 6',
    ].join('\n');
    const mesh = parseObj(obj);
    expect([...mesh.colors!.slice(0, 3)]).toEqual([128, 0, 128]); // avg(red, blue)
    expect([...mesh.colors!.slice(3, 6)]).toEqual([184, 184, 184]); // neutral gray
  });

  it('emits no color channel when no vertex has one', () => {
    expect(parseObj(CUBE_OBJ).colors).toBeUndefined();
  });

  it('reports mtllib names so the panel can ask for the sidecar', () => {
    const mesh = parseObj('mtllib my materials.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3');
    expect(mesh.mtlLibs).toEqual(['my materials.mtl']);
    expect(mesh.colors).toBeUndefined(); // named but unresolved ⇒ still colorless
  });
});

describe('parseObj + MTL', () => {
  const MTL = `
newmtl red
Kd 1.0 0.0 0.0
newmtl blue
Kd 0.0 0.0 1.0
newmtl bare
`;
  const OBJ = `
mtllib cube.mtl
v 0 0 0
v 1 0 0
v 0 1 0
v 2 0 0
v 3 0 0
v 2 1 0
v 4 0 0
v 5 0 0
v 4 1 0
usemtl red
f 1 2 3
usemtl blue
f 4 5 6
usemtl missing
f 7 8 9
`;

  it('parses Kd diffuse colors into byte triples', () => {
    const mats = parseMtl(MTL);
    expect(mats.get('red')?.kd).toEqual([255, 0, 0]);
    expect(mats.get('blue')?.kd).toEqual([0, 0, 255]);
    expect(mats.get('bare')?.kd).toEqual([230, 230, 230]); // no Kd → near-white
  });

  it('captures map_Kd filenames, skipping dash-options', () => {
    const mats = parseMtl('newmtl skin\nKd 1 1 1\nmap_Kd -o 0 0 0 -s 1 1 1 textures/skin base.png');
    expect(mats.get('skin')?.mapKd).toBe('textures/skin base.png');
  });

  it('samples map_Kd at the triangle UV centroid (v flipped)', () => {
    // 2×2 texture: top row red|green, bottom row blue|white.
    const image = {
      width: 2,
      height: 2,
      data: new Uint8Array([
        255, 0, 0, 255,   0, 255, 0, 255,
        0, 0, 255, 255,   255, 255, 255, 255,
      ]),
    };
    const mats = parseMtl('newmtl tex\nKd 0 0 0\nmap_Kd t.png');
    mats.get('tex')!.image = image;
    // UVs centered in the top-left quadrant (v≈0.75 in OBJ = image top row).
    const obj = [
      'mtllib m.mtl',
      'v 0 0 0', 'v 1 0 0', 'v 0 1 0',
      'vt 0.2 0.7', 'vt 0.3 0.8', 'vt 0.25 0.75',
      'usemtl tex',
      'f 1/1 2/2 3/3',
    ].join('\n');
    const mesh = parseObj(obj, mats);
    expect([...mesh.colors!]).toEqual([255, 0, 0]); // top-left texel = red
  });

  it('a textured material without UVs falls back to its Kd', () => {
    const mats = parseMtl('newmtl tex\nKd 0 1 0\nmap_Kd t.png');
    mats.get('tex')!.image = { width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) };
    const mesh = parseObj('usemtl tex\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3', mats);
    expect([...mesh.colors!]).toEqual([0, 255, 0]); // Kd green, no UVs to sample
  });

  it('usemtl colors the faces that follow it', () => {
    const mesh = parseObj(OBJ, parseMtl(MTL));
    expect(mesh.colors).toBeDefined();
    expect([...mesh.colors!.slice(0, 3)]).toEqual([255, 0, 0]);
    expect([...mesh.colors!.slice(3, 6)]).toEqual([0, 0, 255]);
    expect([...mesh.colors!.slice(6, 9)]).toEqual([184, 184, 184]); // unknown material → gray
  });

  it('vertex colors win over the material', () => {
    const obj = 'mtllib m.mtl\nusemtl red\nv 0 0 0 0 1 0\nv 1 0 0 0 1 0\nv 0 1 0 0 1 0\nf 1 2 3';
    const mesh = parseObj(obj, parseMtl(MTL));
    expect([...mesh.colors!]).toEqual([0, 255, 0]);
  });

  it('without the materials map usemtl is inert', () => {
    const mesh = parseObj(OBJ);
    expect(mesh.colors).toBeUndefined();
    expect(mesh.mtlLibs).toEqual(['cube.mtl']);
  });
});

describe('parseStl', () => {
  it('parses binary STL', () => {
    const mesh = parseStl(binaryStlCube());
    expect(mesh.triangleCount).toBe(2);
  });

  it('parses ASCII STL', () => {
    const ascii = `solid t
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 1 0
endloop
endfacet
endsolid t`;
    const mesh = parseStl(new TextEncoder().encode(ascii).buffer as ArrayBuffer);
    expect(mesh.triangleCount).toBe(1);
  });

  it('rejects truncated binary files', () => {
    const buf = binaryStlCube().slice(0, 100);
    expect(() => parseStl(buf)).toThrow(/truncated/i);
  });

  it('plain binary STL (zero attributes) has no color channel', () => {
    expect(parseStl(binaryStlCube()).colors).toBeUndefined();
  });

  it('decodes VisCAM/SolidView facet colors (bit15=1, blue in low bits)', () => {
    const buf = binaryStlCube();
    const view = new DataView(buf);
    // Facet 0: red=31, green=0, blue=0 → bits 10-14, valid bit set.
    view.setUint16(84 + 12 + 36, 0x8000 | (31 << 10), true);
    const mesh = parseStl(buf);
    expect(mesh.colors).toBeDefined();
    expect([...mesh.colors!.slice(0, 3)]).toEqual([248, 0, 0]); // 31<<3
    expect([...mesh.colors!.slice(3, 6)]).toEqual([184, 184, 184]); // facet 1 uncolored
  });

  it('decodes Materialise Magics colors (COLOR= header, red in low bits)', () => {
    const buf = binaryStlCube();
    new Uint8Array(buf).set(new TextEncoder().encode('COLOR=....'), 0);
    const view = new DataView(buf);
    // Facet 0: red in the LOW 5 bits, bit15 CLEAR = per-facet color.
    view.setUint16(84 + 12 + 36, 31, true);
    const mesh = parseStl(buf);
    expect([...mesh.colors!.slice(0, 3)]).toEqual([248, 0, 0]);
  });
});

describe('applyTransform', () => {
  it('identity leaves positions unchanged', () => {
    const mesh = parseObj(CUBE_OBJ);
    const out = applyTransform(mesh, IDENTITY);
    expect([...out.positions]).toEqual([...mesh.positions]);
  });

  it('scale then translate', () => {
    const mesh = parseObj(CUBE_OBJ);
    const out = applyTransform(mesh, { rotate: [0, 0, 0], scale: [2, 2, 2], translate: [10, 0, 0] });
    const b = meshBounds(out);
    expect(b.min[0]).toBeCloseTo(10);
    expect(b.max[0]).toBeCloseTo(12);
    expect(b.max[1]).toBeCloseTo(2);
  });

  it('rotating 90° about Z maps +X to +Y', () => {
    const mesh = { positions: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0, 1]), triangleCount: 1 };
    const out = applyTransform(mesh, { rotate: [0, 0, 90], scale: [1, 1, 1], translate: [0, 0, 0] });
    expect(out.positions[0]).toBeCloseTo(0);
    expect(out.positions[1]).toBeCloseTo(1);
  });
});
