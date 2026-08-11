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

    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
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
    // Drawn first so the model always reads as resting ON it.
    const proj = (x: number, y: number, z: number): [number, number] => {
      const rx = x * cy + z * sy;
      const rz = -x * sy + z * cy;
      const ry = y * cp - rz * sp;
      return [w / 2 + rx * scale, h / 2 - ry * scale];
    };
    const gy = -midY; // model min-y sits at the ground
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
      // yaw about Y, then pitch about X; orthographic drop of z.
      const rx = x * cy + z * sy;
      const rz = -x * sy + z * cy;
      const ry = y * cp - rz * sp;
      const depth = y * sp + rz * cp;
      pts.push(w / 2 + rx * scale, h / 2 - ry * scale, depth, i);
    }
    const order: number[] = [];
    for (let i = 0; i < pts.length; i += 4) order.push(i);
    order.sort((a, b) => pts[a + 2]! - pts[b + 2]!);

    const size = Math.max(1.5 * devicePixelRatio, scale * 0.92);
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
      ctx.fillStyle = shade(r, g, b, t);
      ctx.fillRect(pts[i]! - size / 2, pts[i + 1]! - size / 2, size, size);
    }
  }

  const onPointerDown = (e: PointerEvent) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
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
    canvas.releasePointerCapture(e.pointerId);
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
