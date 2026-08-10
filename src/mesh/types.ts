/** Triangle soup: 9 floats per triangle (3 vertices × xyz). */
export interface TriangleMesh {
  readonly positions: Float32Array;
  readonly triangleCount: number;
}

export interface Bounds {
  readonly min: [number, number, number];
  readonly max: [number, number, number];
}

export function meshBounds(mesh: TriangleMesh): Bounds {
  const p = mesh.positions;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = p[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  return { min, max };
}
