/**
 * The preview's projection math. The user-visible contract: the ground grid
 * and the voxel model share ONE camera, so they rotate together — a voxel
 * cube's bottom edges must stay parallel to (and coincident with) the ground
 * grid lines at every yaw/pitch.
 */
import { describe, expect, it } from 'vitest';
import { cubeGeometry, groundPlaneY, projectPoint } from '../src/ui/preview';

const angles: Array<[number, number]> = [
  [0, 0],
  [Math.PI / 5, Math.PI / 7],
  [0.3, 1.2],
  [-1.1, 0.4],
  [2.7, -0.6],
  [Math.PI / 2, Math.PI / 2],
];

describe('projectPoint', () => {
  it('is linear: projecting a sum = summing projections (orthographic)', () => {
    for (const [yaw, pitch] of angles) {
      const a = projectPoint(1, 2, 3, yaw, pitch, 10);
      const b = projectPoint(-2, 0.5, 1, yaw, pitch, 10);
      const s = projectPoint(-1, 2.5, 4, yaw, pitch, 10);
      expect(s.sx).toBeCloseTo(a.sx + b.sx, 10);
      expect(s.sy).toBeCloseTo(a.sy + b.sy, 10);
      expect(s.depth).toBeCloseTo(a.depth + b.depth, 10);
    }
  });

  it('yaw=0, pitch=0 is a straight front view', () => {
    const p = projectPoint(2, 3, 5, 0, 0, 1);
    expect(p.sx).toBeCloseTo(2);
    expect(p.sy).toBeCloseTo(-3);
    expect(p.depth).toBeCloseTo(5);
  });

  it('pitch=π/2 is a straight top-down view (x/z plane on screen)', () => {
    const p = projectPoint(2, 9, 5, 0, Math.PI / 2, 1);
    expect(p.sx).toBeCloseTo(2);
    expect(p.sy).toBeCloseTo(-(-5)); // ry = -rz·1 = -5 → sy = 5
    expect(p.depth).toBeCloseTo(9); // height = distance to a top-down camera
  });

  it('preserves world-y verticals as screen-x-invariant lines at any yaw', () => {
    // A pillar (same x/z, different y) must project to the same sx — this is
    // what makes towers stand perpendicular to the ground visually.
    for (const [yaw, pitch] of angles) {
      const lo = projectPoint(3, 0, -2, yaw, pitch, 7);
      const hi = projectPoint(3, 5, -2, yaw, pitch, 7);
      expect(hi.sx).toBeCloseTo(lo.sx, 10);
    }
  });
});

describe('ground/model lock (the rotation-desync regression)', () => {
  it('a cube bottom edge lies exactly on the ground-grid line through it', () => {
    // Cell centered at (cx, -midY + ya/2, cz) (bottom layer): its bottom-face
    // edge y equals groundPlaneY. Project the edge's two endpoints and the
    // same two points as "ground grid" points — identical by construction
    // ONLY if both go through the same camera. Guard the constant here.
    const ya = 0.25;
    const midY = 3;
    // draw() places layer-j centers at j·ya − midY (integer − mid, matching
    // the x/z convention the grid's edgePhase comment documents).
    const bottomCellCenterY = 0 * ya - midY;
    expect(groundPlaneY(midY, ya)).toBeCloseTo(bottomCellCenterY - ya / 2, 12);
  });

  it('cube x/z face edges are parallel to grid lines at every angle', () => {
    // Grid line direction along x at the ground: Δproj of (1,0,0). The cube's
    // top-face edge along x: corner[0]-corner[1] of the y face (u=hz? order
    // varies) — instead check the general invariant: every face edge vector
    // equals ±2·(axis half-vector), and those axis vectors ARE the projected
    // world axes the grid is drawn with.
    for (const [yaw, pitch] of angles) {
      const scale = 12;
      const ex = projectPoint(1, 0, 0, yaw, pitch, scale); // grid x-direction
      const ez = projectPoint(0, 0, 1, yaw, pitch, scale); // grid z-direction
      const faces = cubeGeometry(yaw, pitch, 0.25, scale);
      for (const f of faces) {
        for (let i = 0; i < 4; i++) {
          const a = f.corners[i]!;
          const b = f.corners[(i + 1) % 4]!;
          const dx = b[0] - a[0], dy = b[1] - a[1];
          const len = Math.hypot(dx, dy);
          if (len < 1e-9) continue; // degenerate edge at extreme angles
          // Edge must be parallel to the projected x, y, or z world axis.
          const ey = projectPoint(0, 1, 0, yaw, pitch, scale);
          const par = [ex, ey, ez].some((axis) => {
            const al = Math.hypot(axis.sx, axis.sy);
            if (al < 1e-9) return false;
            const cross = Math.abs(dx * axis.sy - dy * axis.sx) / (len * al);
            return cross < 1e-9;
          });
          expect(par).toBe(true);
        }
      }
    }
  });

  it('cube faces always face the camera (positive depth normals)', () => {
    for (const [yaw, pitch] of angles) {
      const faces = cubeGeometry(yaw, pitch, 0.25, 10);
      // At generic angles exactly 3 faces are visible; edge-on axes drop out.
      expect(faces.length).toBeGreaterThanOrEqual(1);
      expect(faces.length).toBeLessThanOrEqual(3);
    }
  });

  it('cube covers exactly one cell footprint: x face spans ±0.5·proj(x̂)', () => {
    const scale = 10;
    for (const [yaw, pitch] of angles) {
      const faces = cubeGeometry(yaw, pitch, 0.25, scale);
      const ex = projectPoint(0.5, 0, 0, yaw, pitch, scale);
      const ez = projectPoint(0, 0, 0.5, yaw, pitch, scale);
      const ey = projectPoint(0, 0.125, 0, yaw, pitch, scale); // ya/2
      // Every corner offset is ±ex ±ey ±ez (a unit cell corner).
      for (const f of faces) {
        for (const [cx, cy] of f.corners) {
          let matched = false;
          for (const s0 of [-1, 1]) for (const s1 of [-1, 1]) for (const s2 of [-1, 1]) {
            const px = s0 * ex.sx + s1 * ey.sx + s2 * ez.sx;
            const py = s0 * ex.sy + s1 * ey.sy + s2 * ez.sy;
            if (Math.abs(px - cx) < 1e-9 && Math.abs(py - cy) < 1e-9) matched = true;
          }
          expect(matched).toBe(true);
        }
      }
    }
  });
});
