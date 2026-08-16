/**
 * Dependency-free voxel preview: orthographic projection of the voxel grid
 * onto a canvas, painter-sorted by depth, drag to orbit. Not a full renderer —
 * it exists so you can sanity-check orientation/resolution before generating,
 * exactly like Schematica's ghost preview. When the grid carries model colors
 * (and the toggle is on) each voxel is drawn in its own color.
 *
 * A green ground grid is drawn under the model so it's obvious which way the
 * build will sit on the track (y=0 = track floor). One grid square = one
 * voxel cell, so the squares shrink as the resolution slider goes up.
 */
import type { VoxelGrid } from '../voxel/voxelize';

const MAX_DRAWN_VOXELS = 60_000;
/** Below this projected cell size (device px) cubes are sub-pixel — draw flat squares. */
const CUBE_MIN_PX = 3;

/**
 * Orthographic camera projection shared by the ground grid and the voxels:
 * yaw about Y, then pitch about X, drop z. Returns screen-space offsets from
 * the canvas center (+sx right, +sy down) and depth (LARGER = nearer).
 * Both the ground and the model MUST go through this one function — drawing
 * them with different math is exactly how they stop rotating together.
 */
export function projectPoint(
  x: number, y: number, z: number,
  yaw: number, pitch: number, scale: number,
): { sx: number; sy: number; depth: number } {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const rx = x * cy + z * sy;
  const rz = -x * sy + z * cy;
  const ry = y * cp - rz * sp;
  return { sx: rx * scale, sy: -ry * scale, depth: y * sp + rz * cp };
}

/** World y of the bottom FACE of the bottom voxel layer (centers sit at
 *  layer·ya − midY), i.e. where the ground plane belongs. */
export function groundPlaneY(midY: number, yAspect: number): number {
  return -midY - yAspect / 2;
}

export interface CubeFace {
  /** 4 screen-space corner offsets from the cell center, fan order. */
  readonly corners: readonly (readonly [number, number])[];
  /** Brightness multiplier so the 3 faces read as a cube. */
  readonly shade: number;
}

/**
 * Screen-space geometry of one voxel cell (x/z size 1, y size yAspect) under
 * the current camera: the camera-facing faces with their corner offsets.
 * Orthographic ⇒ identical for every cell, so compute once per frame and
 * translate per voxel. Corners are derived through projectPoint, which is
 * what keeps voxel edges parallel to the ground grid at every angle.
 */
export function cubeGeometry(
  yaw: number, pitch: number, yAspect: number, scale: number,
): readonly CubeFace[] {
  const p = (x: number, y: number, z: number) => projectPoint(x, y, z, yaw, pitch, scale);
  const hx = p(0.5, 0, 0);
  const hy = p(0, yAspect / 2, 0);
  const hz = p(0, 0, 0.5);
  const axes = [hx, hy, hz];
  const shades = [0.8, 1.0, 0.65]; // x sides, top/bottom, z sides
  const faces: CubeFace[] = [];
  for (let a = 0; a < 3; a++) {
    const n = axes[a]!;
    if (n.depth === 0) continue; // edge-on — zero area
    const s = n.depth > 0 ? 1 : -1; // the face whose normal points at the camera
    const u = axes[(a + 1) % 3]!;
    const v = axes[(a + 2) % 3]!;
    faces.push({
      shade: shades[a]!,
      corners: [
        [s * n.sx + u.sx + v.sx, s * n.sy + u.sy + v.sy],
        [s * n.sx + u.sx - v.sx, s * n.sy + u.sy - v.sy],
        [s * n.sx - u.sx - v.sx, s * n.sy - u.sy - v.sy],
        [s * n.sx - u.sx + v.sx, s * n.sy - u.sy + v.sy],
      ],
    });
  }
  return faces;
}

export interface VoxelPreview {
  readonly canvas: HTMLCanvasElement;
  setGrid(grid: VoxelGrid | null, colorHex: string, useModelColors?: boolean): void;
  dispose(): void;
}

export function createVoxelPreview(width: number, height: number, doc: Document = document): VoxelPreview {
  const canvas = doc.createElement('canvas');
  canvas.width = width * devicePixelRatio;
  canvas.height = height * devicePixelRatio;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.style.cursor = 'grab';
  canvas.style.touchAction = 'none';
  const ctx = canvas.getContext('2d')!;

  let grid: VoxelGrid | null = null;
  let colorHex = '#b8b8b8';
  let modelColors = true;
  let yaw = Math.PI / 5;
  let pitch = Math.PI / 7;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let raf = 0;

  const requestDraw = () => {
    if (raf === 0) raf = requestAnimationFrame(() => { raf = 0; draw(); });
  };

  function draw(): void {
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!grid || grid.filledCount === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.font = `${13 * devicePixelRatio}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('no model loaded', w / 2, h / 2);
      return;
    }

    // y cells are anisotropic (¼ height by default); squash y so the preview
    // shows real-world proportions.
    const ya = grid.yAspect;
    const midX = grid.nx / 2, midY = (grid.ny * ya) / 2, midZ = grid.nz / 2;
    const extent = Math.max(grid.nx, grid.ny * ya, grid.nz);
    const scale = (Math.min(w, h) * 0.72) / extent;

    const voxColors = modelColors ? grid.colors ?? null : null;
    const base = parseInt(colorHex.slice(1), 16);
    const baseR = (base >> 16) & 255, baseG = (base >> 8) & 255, baseB = base & 255;

    // ---- ground plane (y = 0 = the track floor the build sits on) ----
    // Drawn first so the model always reads as resting ON it. Same
    // projectPoint as the voxels — one camera, so they rotate together.
    const proj = (x: number, y: number, z: number): [number, number] => {
      const q = projectPoint(x, y, z, yaw, pitch, scale);
      return [w / 2 + q.sx, h / 2 + q.sy];
    };
    // Bottom FACE of the bottom voxel layer (cell centers sit half a cell
    // higher) — with gy at the centers, the model floated half a cell and
    // orbit parallax read as the ground sliding against it.
    const gy = groundPlaneY(midY, ya);
    const gExt = Math.max(midX, midZ) * 1.7 + 2;
    // One grid square = one voxel cell: lines fall on cell EDGES (centers sit
    // at integer − mid, so edges sit at integer − mid − 0.5 per axis). At high
    // resolutions one-cell squares go sub-pixel; step whole-cell multiples so
    // the grid stays a grid instead of a solid wash (edges stay cell-aligned).
    const gStep = Math.max(1, Math.ceil((4 * devicePixelRatio) / scale));
    const edgePhase = (mid: number): number => {
      const p = (-mid - 0.5) % gStep;
      return p < 0 ? p + gStep : p;
    };
    const phaseX = edgePhase(midX);
    const phaseZ = edgePhase(midZ);
    ctx.strokeStyle = 'rgba(96, 200, 120, 0.4)';
    ctx.lineWidth = 1 * devicePixelRatio;
    ctx.beginPath();
    for (let x = Math.ceil((-gExt - phaseX) / gStep) * gStep + phaseX; x <= gExt + 1e-6; x += gStep) {
      ctx.moveTo(...proj(x, gy, -gExt));
      ctx.lineTo(...proj(x, gy, gExt));
    }
    for (let z = Math.ceil((-gExt - phaseZ) / gStep) * gStep + phaseZ; z <= gExt + 1e-6; z += gStep) {
      ctx.moveTo(...proj(-gExt, gy, z));
      ctx.lineTo(...proj(gExt, gy, z));
    }
    ctx.stroke();

    // Project every filled voxel; sample uniformly if over the draw budget.
    const total = grid.nx * grid.ny * grid.nz;
    const step = Math.max(1, Math.ceil(grid.filledCount / MAX_DRAWN_VOXELS));
    const pts: number[] = []; // sx, sy, depth, cellIndex quads
    let seen = 0;
    for (let i = 0; i < total; i++) {
      if (!grid.cells[i]) continue;
      if (seen++ % step !== 0) continue;
      const x = (i % grid.nx) - midX;
      const y = (Math.floor(i / grid.nx) % grid.ny) * ya - midY;
      const z = Math.floor(i / (grid.nx * grid.ny)) - midZ;
      const q = projectPoint(x, y, z, yaw, pitch, scale);
      pts.push(w / 2 + q.sx, h / 2 + q.sy, q.depth, i);
    }
    const order: number[] = [];
    for (let i = 0; i < pts.length; i += 4) order.push(i);
    order.sort((a, b) => pts[a + 2]! - pts[b + 2]!);

    // Each voxel is drawn as its camera-facing cube faces (same projection as
    // the ground grid — screen-aligned axis squares were what made the model
    // look detached from the ground: their edges never rotated with the
    // camera). Orthographic ⇒ the face polygons are identical for every cell;
    // compute once, translate per voxel. Sub-pixel cells fall back to dots.
    const faces = cubeGeometry(yaw, pitch, ya, scale);
    // Dots are ~5× cheaper than 3 filled paths — use them when cells are
    // sub-pixel anyway or the drawn count would make orbiting stutter.
    const tiny = scale < CUBE_MIN_PX * devicePixelRatio || faces.length === 0 || order.length > 24_000;
    const dotSize = Math.max(1.5 * devicePixelRatio, scale * 0.92);
    for (const i of order) {
      // Cheap depth shading keeps the silhouette readable without lighting.
      const t = (pts[i + 2]! / extent + 0.5) * 0.55 + 0.45;
      let r = baseR, g = baseG, b = baseB;
      if (voxColors) {
        const ci = pts[i + 3]! * 3;
        // (0,0,0) = uncolored cell sentinel → keep the base swatch color.
        if (voxColors[ci] || voxColors[ci + 1] || voxColors[ci + 2]) {
          r = voxColors[ci]!; g = voxColors[ci + 1]!; b = voxColors[ci + 2]!;
        }
      }
      const cx0 = pts[i]!, cy0 = pts[i + 1]!;
      if (tiny) {
        ctx.fillStyle = shade(r, g, b, t);
        ctx.fillRect(cx0 - dotSize / 2, cy0 - dotSize / 2, dotSize, dotSize);
        continue;
      }
      for (const f of faces) {
        ctx.fillStyle = shade(r, g, b, t * f.shade);
        const c = f.corners;
        ctx.beginPath();
        ctx.moveTo(cx0 + c[0]![0], cy0 + c[0]![1]);
        ctx.lineTo(cx0 + c[1]![0], cy0 + c[1]![1]);
        ctx.lineTo(cx0 + c[2]![0], cy0 + c[2]![1]);
        ctx.lineTo(cx0 + c[3]![0], cy0 + c[3]![1]);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  const onPointerDown = (e: PointerEvent) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    // Capture can throw for pointers the browser no longer tracks (e.g.
    // synthetic events); dragging works either way, capture is best-effort.
    try { canvas.setPointerCapture(e.pointerId); } catch { /* best-effort */ }
    canvas.style.cursor = 'grabbing';
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    yaw += (e.clientX - lastX) * 0.01;
    pitch = Math.min(Math.PI / 2, Math.max(-Math.PI / 2, pitch + (e.clientY - lastY) * 0.01));
    lastX = e.clientX;
    lastY = e.clientY;
    requestDraw();
  };
  const onPointerUp = (e: PointerEvent) => {
    dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* best-effort */ }
    canvas.style.cursor = 'grab';
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  requestDraw();

  return {
    canvas,
    setGrid(g, hex, useModelColors = true) {
      grid = g;
      colorHex = hex;
      modelColors = useModelColors;
      requestDraw();
    },
    dispose() {
      if (raf !== 0) cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.remove();
    },
  };
}

function shade(r: number, g: number, b: number, t: number): string {
  const R = Math.min(255, Math.round(r * t + 24));
  const G = Math.min(255, Math.round(g * t + 24));
  const B = Math.min(255, Math.round(b * t + 24));
  return `rgb(${R},${G},${B})`;
}
