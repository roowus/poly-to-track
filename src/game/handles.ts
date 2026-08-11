/**
 * Blender-style transform handles, drawn INSIDE the game viewport around a
 * staged model: colored arrows move along X/Y/Z, square frames rotate about
 * each axis (any angle), tip boxes past the arrows scale a SINGLE axis, and
 * the white center box scales uniformly. Built from the same scavenged
 * constructors as the selection frame (gizmo.ts) — one vertex-colored mesh.
 *
 * Interaction is raw pointer math against the game's own camera: we read the
 * camera's matrix elements (three.js keeps them current every frame), cast a
 * ray, and slab-test the handle boxes. Listeners sit on the game window in
 * the CAPTURE phase so a drag on a handle can stop the editor's own camera /
 * block-placement handlers; hover passes everything through untouched.
 */
import type { GameRenderer } from './track';
import {
  PART_SIZE, XZ_HALF_SPAN, pushBox, scavenge,
  type AttributeLike, type GeometryLike, type MaterialLike, type MeshLike, type TileBounds,
} from './gizmo';

export type Vec3 = [number, number, number];
/** Axis-aligned box: x0,y0,z0,x1,y1,z1 (world units). */
export type Box = [number, number, number, number, number, number];
export type HandleAxis = 0 | 1 | 2;

export interface HandlesHost {
  /** Current session bounds (tile space) — null hides the handles. */
  bounds(): TileBounds | null;
  /** A handle drag began — snapshot whatever the deltas apply to. */
  onDragStart(kind: 'move' | 'rotate' | 'scale'): void;
  /** Incremental snapped move steps: tiles for x/z (multiples of 4), y-units for y. */
  onTranslate(dxTiles: number, dyUnits: number, dzTiles: number): void;
  /** TOTAL rotation about `axis` since drag start, degrees (snapped). */
  onRotate(axis: HandleAxis, totalDegrees: number): void;
  /** TOTAL scale factor since drag start (`-1` = uniform), snapped. */
  onScale(axis: HandleAxis | -1, totalFactor: number): void;
  onDragEnd(): void;
}

export interface TransformHandles {
  /** Redraw for the host's current bounds. No-op mid rotate/scale drag —
   *  the debounced re-voxel would otherwise yank the handle off the cursor. */
  refresh(): void;
  dispose(): void;
}

// ---------- pure math (exported for tests) ----------

/** Column-major mat4 × (x,y,z,1) with perspective divide. */
export function applyMat4(e: ArrayLike<number>, v: Vec3): Vec3 {
  const [x, y, z] = v;
  const w = (e[3]! * x + e[7]! * y + e[11]! * z + e[15]!) || 1;
  return [
    (e[0]! * x + e[4]! * y + e[8]! * z + e[12]!) / w,
    (e[1]! * x + e[5]! * y + e[9]! * z + e[13]!) / w,
    (e[2]! * x + e[6]! * y + e[10]! * z + e[14]!) / w,
  ];
}

/** Ray/AABB slab test → distance to entry (0 when starting inside), null on miss. */
export function rayBoxT(ro: Vec3, rd: Vec3, b: Box): number | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  for (let a = 0; a < 3; a++) {
    const o = ro[a]!, d = rd[a]!, lo = b[a]!, hi = b[a + 3]!;
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let t0 = (lo - o) / d;
    let t1 = (hi - o) / d;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return null;
  }
  return tmax < 0 ? null : Math.max(tmin, 0);
}

/** Param t of the closest point on the line C + t·a to the ray ro + s·d
 *  (a and d unit length). 0 when the axis is parallel to the ray. */
export function closestAxisT(c: Vec3, a: Vec3, ro: Vec3, rd: Vec3): number {
  const w0: Vec3 = [c[0] - ro[0], c[1] - ro[1], c[2] - ro[2]];
  const b = a[0] * rd[0] + a[1] * rd[1] + a[2] * rd[2];
  const p = a[0] * w0[0] + a[1] * w0[1] + a[2] * w0[2];
  const q = rd[0] * w0[0] + rd[1] * w0[1] + rd[2] * w0[2];
  const den = 1 - b * b;
  if (Math.abs(den) < 1e-9) return 0;
  return (b * q - p) / den;
}

// ---------- handle layout ----------

const AXIS_DIRS: readonly Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
/** Blender's axis colors, slightly lifted for the game's dark scenes. */
const AXIS_COLORS: readonly Vec3[] = [[1, 0.32, 0.32], [0.42, 0.95, 0.42], [0.42, 0.62, 1]];
const UNIFORM_COLOR: Vec3 = [1, 1, 1];
const SHAFT_R = 1.1;
const HEAD_R = 3.4;
const TIP_R = 2.8;
const FRAME_R = 1.0;
const CENTER_R = 3.6;
const PICK_PAD = 2.5; // inflate hitboxes — handles are thin
/** 3 axes × (arrow shaft + arrow head + scale tip + 4 frame edges) + center. */
const MAX_BOXES = 3 * 7 + 1;
const FLOATS = MAX_BOXES * 36 * 3;
const ROT_SNAP_DEG = 5;
const SCALE_SNAP = 0.05;

interface HandleDef {
  kind: 'move' | 'rotate' | 'scale';
  axis: HandleAxis | -1;
  color: Vec3;
  boxes: Box[];
}

function axisBox(c: Vec3, axis: HandleAxis, from: number, to: number, r: number): Box {
  const lo: Vec3 = [c[0] - r, c[1] - r, c[2] - r];
  const hi: Vec3 = [c[0] + r, c[1] + r, c[2] + r];
  lo[axis] = c[axis] + from;
  hi[axis] = c[axis] + to;
  return [...lo, ...hi] as Box;
}

function tipBox(c: Vec3, axis: HandleAxis, at: number, r: number): Box {
  const p: Vec3 = [...c];
  p[axis] += at;
  return [p[0] - r, p[1] - r, p[2] - r, p[0] + r, p[1] + r, p[2] + r];
}

const PERP: readonly [HandleAxis, HandleAxis][] = [[1, 2], [0, 2], [0, 1]];

/** Square frame in the plane perpendicular to `axis`, half-extent r. */
function frameBoxes(c: Vec3, axis: HandleAxis, r: number, th: number): Box[] {
  const [u, v] = PERP[axis]!;
  const out: Box[] = [];
  for (const side of [-1, 1]) {
    const a: Vec3 = [...c];
    const b: Vec3 = [...c];
    // edge running along u at v = ±r
    a[u] -= r + th; b[u] += r + th;
    a[v] += side * r - th; b[v] += side * r + th;
    a[axis] -= th; b[axis] += th;
    out.push([...a, ...b] as Box);
    // edge running along v at u = ±r
    const a2: Vec3 = [...c];
    const b2: Vec3 = [...c];
    a2[v] -= r + th; b2[v] += r + th;
    a2[u] += side * r - th; b2[u] += side * r + th;
    a2[axis] -= th; b2[axis] += th;
    out.push([...a2, ...b2] as Box);
  }
  return out;
}

// ---------- the factory ----------

interface Mat4Like { elements?: ArrayLike<number> }
interface CameraLike {
  matrixWorld?: Mat4Like;
  matrixWorldInverse?: Mat4Like;
  projectionMatrix?: Mat4Like;
  projectionMatrixInverse?: Mat4Like;
}

interface DragState {
  kind: 'move' | 'rotate' | 'scale';
  axis: HandleAxis | -1;
  // move: the axis LINE is frozen at drag start (the model moves under it)
  lineC: Vec3;
  axisDir: Vec3;
  t0: number;
  emitted: number;
  // rotate/scale: everything is relative to the gizmo center on SCREEN
  centerPx: [number, number];
  prevAngle: number;
  totalRad: number;
  sign: number;
  lastDeg: number;
  d0: number;
  lastFactor: number;
}

/**
 * Build interactive handles inside `renderer.scene`, or null when the camera
 * matrices / canvas / scene ctors aren't reachable — callers just skip them
 * (keyboard + panel sliders still cover every transform).
 */
export function createTransformHandles(
  renderer: GameRenderer, gameWindow: Window, host: HandlesHost,
): TransformHandles | null {
  const cam = renderer.camera as CameraLike | undefined;
  const canvas = gameWindow.document.querySelector('canvas');
  if (
    !canvas || !cam?.matrixWorld?.elements || !cam.projectionMatrixInverse?.elements ||
    !cam.matrixWorldInverse?.elements || !cam.projectionMatrix?.elements
  ) return null;
  const kit = scavenge(renderer.scene);
  if (!kit) return null;

  let mesh: MeshLike | null = null;
  let geometry: GeometryLike | null = null;
  let posAttr: AttributeLike | null = null;
  let colAttr: AttributeLike | null = null;
  let positions: Float32Array | null = null;
  let colors: Float32Array | null = null;
  const material: MaterialLike = kit.material;
  let disposed = false;

  try {
    material.color?.setHex?.(0xffffff); // white base × vertex colors
    material.emissive?.setHex?.(0x1a1a1a);
    if ('map' in material) material.map = null;
    material.vertexColors = true;
    material.transparent = true;
    material.opacity = 0.95;
    material.depthTest = false; // handles read through terrain, like Blender
    material.depthWrite = false;
    material.fog = false;
    material.toneMapped = false;
    (material as { needsUpdate?: boolean }).needsUpdate = true;

    positions = new kit.Float32(FLOATS);
    colors = new kit.Float32(FLOATS);
    geometry = new kit.BufferGeometry();
    posAttr = new kit.BufferAttribute(positions, 3);
    colAttr = new kit.BufferAttribute(colors, 3);
    geometry.setAttribute?.('position', posAttr);
    geometry.setAttribute?.('color', colAttr);
    mesh = new kit.Mesh(geometry, material);
    mesh.name = 'poly-to-track-handles';
    mesh.frustumCulled = false;
    mesh.renderOrder = 10000; // over the ghost (9998) and the frame (9999)
    mesh.visible = false;
    renderer.scene.add(mesh);
  } catch {
    try { material.dispose?.(); } catch { /* best effort */ }
    return null;
  }

  let defs: HandleDef[] = [];
  let center: Vec3 = [0, 0, 0];
  let hovered = -1;
  let drag: DragState | null = null;

  function writeColors(): void {
    if (!colors || !colAttr) return;
    let o = 0;
    for (let i = 0; i < defs.length; i++) {
      const d = defs[i]!;
      const lift = i === hovered ? 0.65 : 0;
      const r = Math.min(1, d.color[0] + lift);
      const g = Math.min(1, d.color[1] + lift);
      const b = Math.min(1, d.color[2] + lift);
      for (let n = 0; n < d.boxes.length * 36; n++) {
        colors[o++] = r; colors[o++] = g; colors[o++] = b;
      }
    }
    colAttr.needsUpdate = true;
  }

  function draw(): void {
    const b = host.bounds();
    if (!mesh || !positions || !posAttr) return;
    if (!b) {
      mesh.visible = false;
      defs = [];
      hovered = -1;
      return;
    }
    const x0 = b.min[0] * PART_SIZE - XZ_HALF_SPAN;
    const y0 = b.min[1] * PART_SIZE;
    const z0 = b.min[2] * PART_SIZE - XZ_HALF_SPAN;
    const x1 = b.max[0] * PART_SIZE + XZ_HALF_SPAN;
    const y1 = (b.max[1] + 1) * PART_SIZE;
    const z1 = b.max[2] * PART_SIZE + XZ_HALF_SPAN;
    center = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
    const half: Vec3 = [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2];

    defs = [];
    for (let a = 0 as HandleAxis; a < 3; a = (a + 1) as HandleAxis) {
      const len = half[a]! + 26;
      defs.push({
        kind: 'move', axis: a, color: AXIS_COLORS[a]!,
        boxes: [axisBox(center, a, half[a]! + 3, len, SHAFT_R), tipBox(center, a, len + 3, HEAD_R)],
      });
      defs.push({ kind: 'scale', axis: a, color: AXIS_COLORS[a]!, boxes: [tipBox(center, a, len + 13, TIP_R)] });
      const [u, v] = PERP[a]!;
      defs.push({
        kind: 'rotate', axis: a, color: AXIS_COLORS[a]!,
        boxes: frameBoxes(center, a, Math.max(half[u]!, half[v]!) + 12, FRAME_R),
      });
    }
    defs.push({ kind: 'scale', axis: -1, color: UNIFORM_COLOR, boxes: [tipBox(center, 0, 0, CENTER_R)] });

    let o = 0;
    for (const d of defs) for (const box of d.boxes) o = pushBox(positions, o, ...box);
    positions.fill(0, o);
    posAttr.needsUpdate = true;
    writeColors();
    mesh.visible = true;
  }

  // ---------- pointer math ----------

  function pointerNdc(e: PointerEvent): [number, number] | null {
    const r = canvas!.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const x = ((e.clientX - r.left) / r.width) * 2 - 1;
    const y = -((e.clientY - r.top) / r.height) * 2 + 1;
    return x < -1 || x > 1 || y < -1 || y > 1 ? null : [x, y];
  }

  function pointerRay(nx: number, ny: number): { ro: Vec3; rd: Vec3 } | null {
    const mw = cam!.matrixWorld?.elements;
    const pmi = cam!.projectionMatrixInverse?.elements;
    if (!mw || !pmi) return null;
    const ro: Vec3 = [mw[12] as number, mw[13] as number, mw[14] as number];
    const pt = applyMat4(mw, applyMat4(pmi, [nx, ny, 0.5]));
    const dx = pt[0] - ro[0], dy = pt[1] - ro[1], dz = pt[2] - ro[2];
    const l = Math.hypot(dx, dy, dz) || 1;
    return { ro, rd: [dx / l, dy / l, dz / l] };
  }

  function toScreen(v: Vec3): [number, number] | null {
    const mwi = cam!.matrixWorldInverse?.elements;
    const pm = cam!.projectionMatrix?.elements;
    if (!mwi || !pm) return null;
    const ndc = applyMat4(pm, applyMat4(mwi, v));
    const r = canvas!.getBoundingClientRect();
    return [r.left + ((ndc[0] + 1) / 2) * r.width, r.top + ((1 - ndc[1]) / 2) * r.height];
  }

  function pick(ro: Vec3, rd: Vec3): number {
    let best = -1;
    let bestT = Infinity;
    for (let i = 0; i < defs.length; i++) {
      for (const b of defs[i]!.boxes) {
        const t = rayBoxT(ro, rd, [
          b[0] - PICK_PAD, b[1] - PICK_PAD, b[2] - PICK_PAD,
          b[3] + PICK_PAD, b[4] + PICK_PAD, b[5] + PICK_PAD,
        ]);
        if (t !== null && t < bestT) { bestT = t; best = i; }
      }
    }
    return best;
  }

  // ---------- drag/hover handlers (capture phase on the game window) ----------

  const onPointerDown = (e: PointerEvent): void => {
    if (disposed || e.button !== 0 || !mesh?.visible || defs.length === 0) return;
    const ndc = pointerNdc(e);
    if (!ndc) return;
    const rr = pointerRay(ndc[0], ndc[1]);
    if (!rr) return;
    const hit = pick(rr.ro, rr.rd);
    if (hit < 0) return;
    const def = defs[hit]!;
    // Our drag — the editor's camera orbit / block placement must not see it.
    e.preventDefault();
    e.stopImmediatePropagation();
    const base: DragState = {
      kind: def.kind, axis: def.axis,
      lineC: [...center], axisDir: AXIS_DIRS[def.axis === -1 ? 0 : def.axis]!, t0: 0, emitted: 0,
      centerPx: [0, 0], prevAngle: 0, totalRad: 0, sign: 1, lastDeg: 0,
      d0: 1, lastFactor: 1,
    };
    if (def.kind === 'move') {
      base.t0 = closestAxisT(base.lineC, base.axisDir, rr.ro, rr.rd);
    } else {
      const cpx = toScreen(center);
      if (!cpx) return; // camera matrices unreadable — don't start a half-drag
      base.centerPx = cpx;
      if (def.kind === 'rotate') {
        base.prevAngle = Math.atan2(e.clientY - cpx[1], e.clientX - cpx[0]);
        // Screen-CCW maps to +rotation when the axis points AT the camera.
        const view: Vec3 = [center[0] - rr.ro[0], center[1] - rr.ro[1], center[2] - rr.ro[2]];
        const dot = base.axisDir[0] * view[0] + base.axisDir[1] * view[1] + base.axisDir[2] * view[2];
        base.sign = dot > 0 ? 1 : -1;
      } else {
        base.d0 = Math.max(4, Math.hypot(e.clientX - cpx[0], e.clientY - cpx[1]));
      }
    }
    host.onDragStart(def.kind);
    drag = base;
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (disposed) return;
    if (!drag) {
      // hover feedback only — never intercept
      let h = -1;
      if (mesh?.visible && defs.length > 0) {
        const ndc = pointerNdc(e);
        const rr = ndc ? pointerRay(ndc[0], ndc[1]) : null;
        if (rr) h = pick(rr.ro, rr.rd);
      }
      if (h !== hovered) {
        hovered = h;
        writeColors();
        canvas!.style.cursor = h >= 0 ? 'grab' : '';
      }
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (drag.kind === 'move') {
      const ndc = pointerNdc(e);
      const rr = ndc ? pointerRay(ndc[0], ndc[1]) : null;
      if (!rr) return;
      const t = closestAxisT(drag.lineC, drag.axisDir, rr.ro, rr.rd);
      const stepWorld = drag.axis === 1 ? PART_SIZE : PART_SIZE * 4; // y-unit vs 4-tile cell
      const steps = Math.round((t - drag.t0) / stepWorld);
      if (steps !== drag.emitted) {
        const d = steps - drag.emitted;
        drag.emitted = steps;
        host.onTranslate(drag.axis === 0 ? d * 4 : 0, drag.axis === 1 ? d : 0, drag.axis === 2 ? d * 4 : 0);
      }
    } else if (drag.kind === 'rotate') {
      const ang = Math.atan2(e.clientY - drag.centerPx[1], e.clientX - drag.centerPx[0]);
      let dA = ang - drag.prevAngle;
      if (dA > Math.PI) dA -= 2 * Math.PI;
      if (dA < -Math.PI) dA += 2 * Math.PI;
      drag.prevAngle = ang;
      drag.totalRad += dA;
      const deg = Math.round((drag.totalRad * 180 / Math.PI) * drag.sign / ROT_SNAP_DEG) * ROT_SNAP_DEG;
      if (deg !== drag.lastDeg) {
        drag.lastDeg = deg;
        host.onRotate(drag.axis as HandleAxis, deg);
      }
    } else {
      const d = Math.hypot(e.clientX - drag.centerPx[0], e.clientY - drag.centerPx[1]);
      const raw = Math.min(20, Math.max(0.05, d / drag.d0));
      const factor = Math.round(raw / SCALE_SNAP) * SCALE_SNAP;
      if (factor !== drag.lastFactor) {
        drag.lastFactor = factor;
        host.onScale(drag.axis, factor);
      }
    }
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (disposed || !drag) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    drag = null;
    host.onDragEnd();
  };

  gameWindow.addEventListener('pointerdown', onPointerDown, true);
  gameWindow.addEventListener('pointermove', onPointerMove, true);
  gameWindow.addEventListener('pointerup', onPointerUp, true);
  gameWindow.addEventListener('pointercancel', onPointerUp, true);

  draw();

  return {
    refresh() {
      if (disposed) return;
      // Mid rotate/scale drag the (debounced) re-voxel changes the bounds —
      // freezing the visuals keeps the handle under the cursor. Move drags
      // redraw so the arrows follow the model, Blender-style.
      if (drag && drag.kind !== 'move') return;
      draw();
    },
    dispose() {
      disposed = true;
      drag = null;
      gameWindow.removeEventListener('pointerdown', onPointerDown, true);
      gameWindow.removeEventListener('pointermove', onPointerMove, true);
      gameWindow.removeEventListener('pointerup', onPointerUp, true);
      gameWindow.removeEventListener('pointercancel', onPointerUp, true);
      try { canvas.style.cursor = ''; } catch { /* frame gone */ }
      if (mesh) {
        try { renderer.scene.remove(mesh); } catch { /* scene torn down */ }
      }
      try { geometry?.dispose?.(); } catch { /* best effort */ }
      try { material.dispose?.(); } catch { /* best effort */ }
      mesh = null;
      geometry = null;
      positions = null;
      colors = null;
      posAttr = null;
      colAttr = null;
    },
  };
}
