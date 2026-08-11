import { describe, expect, it } from 'vitest';
import { applyMat4, closestAxisT, rayBoxT, type Box, type Vec3 } from '../src/game/handles';

describe('applyMat4', () => {
  it('identity leaves points untouched', () => {
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(applyMat4(I, [3, -2, 7])).toEqual([3, -2, 7]);
  });

  it('translation column moves the point', () => {
    const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1];
    expect(applyMat4(T, [1, 2, 3])).toEqual([11, 22, 33]);
  });

  it('performs the perspective divide', () => {
    // w row scales w by 2 → all coords halve
    const P = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2];
    expect(applyMat4(P, [4, 8, 12])).toEqual([2, 4, 6]);
  });
});

describe('rayBoxT', () => {
  const box: Box = [-1, -1, -1, 1, 1, 1];

  it('hits a box straight ahead and reports the entry distance', () => {
    expect(rayBoxT([0, 0, -5], [0, 0, 1], box)).toBeCloseTo(4);
  });

  it('misses a box off to the side', () => {
    expect(rayBoxT([0, 5, -5], [0, 0, 1], box)).toBeNull();
  });

  it('misses when the box is behind the ray', () => {
    expect(rayBoxT([0, 0, 5], [0, 0, 1], box)).toBeNull();
  });

  it('returns 0 when the origin is inside the box', () => {
    expect(rayBoxT([0, 0, 0], [0, 0, 1], box)).toBe(0);
  });

  it('handles rays parallel to a slab (zero direction component)', () => {
    expect(rayBoxT([0, 0.5, -5], [0, 0, 1], box)).toBeCloseTo(4);
    expect(rayBoxT([0, 2, -5], [0, 0, 1], box)).toBeNull();
  });
});

describe('closestAxisT', () => {
  it('recovers the along-axis position the ray points at', () => {
    // Axis = +X line through the origin; ray from above looking straight down
    // at x=7 → the closest point on the axis is x=7.
    const c: Vec3 = [0, 0, 0];
    const a: Vec3 = [1, 0, 0];
    const t = closestAxisT(c, a, [7, 10, 0], [0, -1, 0]);
    expect(t).toBeCloseTo(7);
  });

  it('returns 0 for a ray parallel to the axis (degenerate)', () => {
    expect(closestAxisT([0, 0, 0], [1, 0, 0], [0, 5, 0], [1, 0, 0])).toBe(0);
  });

  it('drag deltas along the axis map 1:1', () => {
    const c: Vec3 = [10, 0, 10];
    const a: Vec3 = [0, 0, 1];
    const t1 = closestAxisT(c, a, [10, 10, 0], [0, -1, 0]);
    const t2 = closestAxisT(c, a, [10, 10, 25], [0, -1, 0]);
    expect(t2 - t1).toBeCloseTo(25);
  });
});
