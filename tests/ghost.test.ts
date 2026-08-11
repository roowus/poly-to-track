import { describe, expect, it } from 'vitest';
import type { PlacedPart } from '../src/codec/parts';
import { createGhost, MAX_GHOST_BOXES, mergeGhostBoxes } from '../src/game/ghost';
import type { GameRenderer } from '../src/game/track';

// ---- the same minimal three.js stand-ins the gizmo tests use ----

class FakeBufferAttribute {
  isBufferAttribute = true;
  needsUpdate = false;
  constructor(public array: Float32Array, public itemSize: number) {}
}

class FakeBufferGeometry {
  isBufferGeometry = true;
  attributes: Record<string, FakeBufferAttribute> = {};
  disposed = false;
  setAttribute(name: string, attr: FakeBufferAttribute) { this.attributes[name] = attr; }
  getAttribute(name: string) { return this.attributes[name]; }
  dispose() { this.disposed = true; }
}

class FakeColor {
  hex = 0;
  setHex(h: number) { this.hex = h; return this; }
}

class FakeMaterial {
  isMaterial = true;
  color = new FakeColor();
  map: unknown = { some: 'texture' };
  vertexColors = false;
  transparent = false;
  opacity = 1;
  depthTest = true;
  depthWrite = true;
  disposed = false;
  clone() {
    const m = new FakeMaterial();
    m.map = this.map;
    return m;
  }
  dispose() { this.disposed = true; }
}

class FakePosition {
  x = 0; y = 0; z = 0;
  set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; }
}

class FakeMesh {
  isObject3D = true;
  isMesh = true;
  visible = true;
  frustumCulled = true;
  renderOrder = 0;
  name = '';
  children: unknown[] = [];
  position = new FakePosition();
  constructor(public geometry: FakeBufferGeometry, public material: FakeMaterial) {}
}

function fakeScene(children: unknown[]) {
  const scene = {
    isObject3D: true,
    children,
    add(obj: unknown) { children.push(obj); return scene; },
    remove(obj: unknown) {
      const i = children.indexOf(obj);
      if (i >= 0) children.splice(i, 1);
      return scene;
    },
  };
  return scene;
}

function rendererWithMesh(): { renderer: GameRenderer; children: unknown[] } {
  const geom = new FakeBufferGeometry();
  geom.setAttribute('position', new FakeBufferAttribute(new Float32Array(9), 3));
  const seed = new FakeMesh(geom, new FakeMaterial());
  const children: unknown[] = [{ isObject3D: true, children: [seed] }];
  return { renderer: { scene: fakeScene(children), camera: {} } as unknown as GameRenderer, children };
}

function part(x: number, y: number, z: number, color = 0): PlacedPart {
  return { x, y, z, partId: 29, rotation: 0, rotationAxis: 0, color };
}

const ghostOf = (children: unknown[]) =>
  children.find((c): c is FakeMesh => c instanceof FakeMesh && c.name === 'poly-to-track-ghost');

describe('createGhost', () => {
  it('returns null when the scene has nothing to scavenge from', () => {
    const renderer = { scene: fakeScene([]), camera: {} } as unknown as GameRenderer;
    expect(createGhost(renderer, [part(0, 1, 0)])).toBeNull();
  });

  it('adds one translucent vertex-colored mesh with a box per merged run', () => {
    const { renderer, children } = rendererWithMesh();
    // Different colors — un-mergeable, so exactly one box per part.
    const ghost = createGhost(renderer, [part(0, 1, 0, 0), part(4, 1, 0, 1)]);
    expect(ghost).not.toBeNull();
    const mesh = ghostOf(children)!;
    expect(mesh).toBeDefined();
    expect(mesh.material.transparent).toBe(true);
    expect(mesh.material.vertexColors).toBe(true);
    expect(mesh.material.depthWrite).toBe(false);
    // 2 boxes × 36 verts × 3 floats
    expect(mesh.geometry.getAttribute('position')!.array.length).toBe(2 * 36 * 3);
    expect(mesh.geometry.getAttribute('color')!.array.length).toBe(2 * 36 * 3);
  });

  it('merges adjacent same-color parts into single cuboids (no ghost holes)', () => {
    // A 3-wide × 2-tall same-color wall = ONE box; a stray different color stays its own.
    const wall = [
      part(0, 1, 0), part(4, 1, 0), part(8, 1, 0),
      part(0, 2, 0), part(4, 2, 0), part(8, 2, 0),
      part(20, 1, 0, 3),
    ];
    const boxes = mergeGhostBoxes(wall);
    expect(boxes).toHaveLength(2);
    const big = boxes.find((b) => b.color === 0)!;
    expect(big).toMatchObject({ x0: 0, x1: 8, y0: 1, y1: 2, z0: 0, z1: 0 });
  });

  it('merged geometry covers every part — a full solid never samples', () => {
    // 40×40×4 solid (6,400 parts, same color) must collapse WAY under the cap.
    const solid: PlacedPart[] = [];
    for (let y = 0; y < 4; y++) {
      for (let z = 0; z < 40; z++) {
        for (let x = 0; x < 40; x++) solid.push(part(x * 4, y, z * 4));
      }
    }
    const boxes = mergeGhostBoxes(solid);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ x0: 0, x1: 156, y0: 0, y1: 3, z0: 0, z1: 156 });
  });

  it('setOffset moves the mesh in world units without touching the buffers', () => {
    const { renderer, children } = rendererWithMesh();
    const ghost = createGhost(renderer, [part(0, 1, 0)])!;
    const mesh = ghostOf(children)!;
    const posAttr = mesh.geometry.getAttribute('position')!;
    posAttr.needsUpdate = false;
    ghost.setOffset(4, 1, -4);
    // Tiles/y-units × PART_SIZE(5) world units.
    expect(mesh.position).toMatchObject({ x: 20, y: 5, z: -20 });
    expect(posAttr.needsUpdate).toBe(false); // O(1): no buffer rewrite
  });

  it('setParts rewrites the buffers (rotation / rebuild path)', () => {
    const { renderer, children } = rendererWithMesh();
    const ghost = createGhost(renderer, [part(0, 1, 0)])!;
    // 3 different colors — un-mergeable, so 3 boxes.
    ghost.setParts([part(0, 1, 0, 0), part(0, 2, 0, 1), part(0, 3, 0, 2)]);
    const mesh = ghostOf(children)!;
    expect(mesh.geometry.getAttribute('position')!.array.length).toBe(3 * 36 * 3);
    expect(mesh.visible).toBe(true);
  });

  it('samples down beyond the box budget instead of allocating unbounded buffers', () => {
    const { renderer, children } = rendererWithMesh();
    // Gapped positions defeat merging — worst case, one box per part.
    const many: PlacedPart[] = [];
    for (let i = 0; i < MAX_GHOST_BOXES * 2; i++) many.push(part(i * 8, 1, 0));
    const ghost = createGhost(renderer, many);
    expect(ghost).not.toBeNull();
    const mesh = ghostOf(children)!;
    expect(mesh.geometry.getAttribute('position')!.array.length)
      .toBeLessThanOrEqual(MAX_GHOST_BOXES * 36 * 3);
  });

  it('dispose removes the mesh and frees resources', () => {
    const { renderer, children } = rendererWithMesh();
    const ghost = createGhost(renderer, [part(0, 1, 0)])!;
    const mesh = ghostOf(children)!;
    ghost.dispose();
    expect(children.includes(mesh)).toBe(false);
    expect(mesh.geometry.disposed).toBe(true);
    expect(mesh.material.disposed).toBe(true);
    // Post-dispose calls are safe no-ops.
    ghost.setOffset(1, 1, 1);
    ghost.setParts([part(0, 1, 0)]);
    ghost.dispose();
  });
});
