import { describe, expect, it } from 'vitest';
import { parseObj } from '../src/mesh/obj';
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
