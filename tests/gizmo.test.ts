import { describe, expect, it } from 'vitest';
import { createGizmo } from '../src/game/gizmo';
import { asGameRenderer, type GameRenderer } from '../src/game/track';

// ---- minimal three.js stand-ins with the same duck-typed surface ----

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

class FakeMesh {
  isObject3D = true;
  isMesh = true;
  visible = true;
  frustumCulled = true;
  renderOrder = 0;
  name = '';
  children: unknown[] = [];
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

/** A scene that already renders one mesh — what the editor scene looks like. */
function rendererWithMesh(): { renderer: GameRenderer; children: unknown[] } {
  const geom = new FakeBufferGeometry();
  geom.setAttribute('position', new FakeBufferAttribute(new Float32Array(9), 3));
  const seed = new FakeMesh(geom, new FakeMaterial());
  const children: unknown[] = [{ isObject3D: true, children: [seed] }];
  return { renderer: { scene: fakeScene(children), camera: {} } as unknown as GameRenderer, children };
}

describe('asGameRenderer', () => {
  it('accepts a wrapper exposing a real scene and rejects junk', () => {
    expect(asGameRenderer(rendererWithMesh().renderer)).not.toBeNull();
    expect(asGameRenderer(null)).toBeNull();
    expect(asGameRenderer({})).toBeNull();
    expect(asGameRenderer({ scene: {} })).toBeNull();
    expect(asGameRenderer({ scene: { isObject3D: true } })).toBeNull(); // no add/remove
  });
});

describe('createGizmo', () => {
  it('returns null when the scene has no mesh to scavenge from', () => {
    const renderer = { scene: fakeScene([]), camera: {} } as unknown as GameRenderer;
    expect(createGizmo(renderer)).toBeNull();
  });

  it('adds a hidden selection mesh built from scavenged constructors', () => {
    const { renderer, children } = rendererWithMesh();
    const gizmo = createGizmo(renderer);
    expect(gizmo).not.toBeNull();
    const added = children.find((c): c is FakeMesh => c instanceof FakeMesh);
    expect(added).toBeDefined();
    expect(added!.name).toBe('poly-to-track-gizmo');
    expect(added!.visible).toBe(false);
    // Material was cloned + restyled, not the scavenged mesh's own.
    expect(added!.material.color.hex).toBe(0xff9822);
    expect(added!.material.map).toBeNull();
    expect(added!.material.depthTest).toBe(false);
  });

  it('update(bounds) shows the frame with world-scaled coordinates', () => {
    const { renderer, children } = rendererWithMesh();
    const gizmo = createGizmo(renderer)!;
    gizmo.update({ min: [0, 0, 0], max: [4, 2, 4] });
    const added = children.find((c): c is FakeMesh => c instanceof FakeMesh)!;
    expect(added.visible).toBe(true);
    const attr = added.geometry.getAttribute('position')!;
    expect(attr.needsUpdate).toBe(true);
    // Frame corners: x spans [0*5−10, 4*5+10] = [−10, 30]; y spans [0, (2+1)*5] = [0, 15].
    const xs = Array.from(attr.array).filter((_, i) => i % 3 === 0);
    const ys = Array.from(attr.array).filter((_, i) => i % 3 === 1);
    // Corner cubes extend the extremes by CORNER_R (1.4).
    expect(Math.min(...xs)).toBeCloseTo(-10 - 1.4);
    expect(Math.max(...xs)).toBeCloseTo(30 + 1.4);
    expect(Math.min(...ys)).toBeCloseTo(0 - 1.4);
    expect(Math.max(...ys)).toBeCloseTo(15 + 1.4);
  });

  it('update(null) hides the frame; dispose removes it and frees resources', () => {
    const { renderer, children } = rendererWithMesh();
    const gizmo = createGizmo(renderer)!;
    gizmo.update({ min: [0, 0, 0], max: [0, 0, 0] });
    gizmo.update(null);
    const added = children.find((c): c is FakeMesh => c instanceof FakeMesh)!;
    expect(added.visible).toBe(false);
    gizmo.dispose();
    expect(children.includes(added)).toBe(false);
    expect(added.geometry.disposed).toBe(true);
    expect(added.material.disposed).toBe(true);
    // Post-dispose calls are safe no-ops.
    gizmo.update({ min: [0, 0, 0], max: [1, 1, 1] });
    gizmo.dispose();
  });
});

describe('InsertSession.bounds', () => {
  it('exposes tile-space bounds that follow translation', async () => {
    const { insertParts } = await import('../src/game/insert');
    const track = {
      setPart() { /* accept everything */ },
      deleteSpecificPart() { return null; },
      refreshMeshes() { /* no-op */ },
    };
    const p = (x: number, y: number, z: number) =>
      ({ x, y, z, partId: 29, rotation: 0, rotationAxis: 0, color: 0 });
    const session = insertParts(track, [p(0, 0, 0), p(8, 2, 4)]);
    expect(session.bounds).toEqual({ min: [0, 0, 0], max: [8, 2, 4] });
    session.translate(4, 1, 0);
    expect(session.bounds).toEqual({ min: [4, 1, 0], max: [12, 3, 4] });
    session.remove();
    expect(session.bounds).toBeNull();
  });
});
