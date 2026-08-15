/**
 * The importer panel, embedded INSIDE the game frame and styled like the
 * game's own editor UI (same CSS custom properties, the same skewed clip-path
 * panels, and — because the panel lives in the game document — the game's
 * ForcedSquare italic font for free).
 *
 * Flow: load a 3D file → orbit the voxel preview (a ground grid + label make
 * clear which way is DOWN) → dial in resolution, rotation (three any-angle
 * axis sliders — the mesh is re-voxelized, so diagonal builds are true
 * diagonal voxelizations, not sheared blocks), scale (keeps the BLOCK size
 * constant and grows the build — plain mesh scaling would be normalized away
 * by the longest-axis fit) and color → **Insert into editor**, which STAGES
 * the parts (nothing written to the track yet): a translucent ghost appears
 * in the viewport wearing Blender-style 3D transform handles (game/handles.ts
 * — colored arrows move, square frames rotate any angle, tip boxes scale one
 * axis, the white center box scales uniformly). The floating strip under the
 * viewport is just Apply / Cancel. Keys still work: arrows move, PgUp/PgDn
 * raise/lower, R yaws 90°, Enter applies, Delete cancels.
 *
 * Besides the P keybind there's a white cube launcher button injected at the
 * left of the editor's own cut/copy/paste mini-toolbar (re-injected whenever the editor
 * UI is rebuilt, which happens per editor entry). The import flow is
 * editor-only, so LEAVING the editor auto-hides the panel and drops any
 * staged session.
 */
import { COLOR_SWATCHES } from '../codec/parts';
import { toExportString } from '../codec/encode';
import { createGhost, type Ghost } from '../game/ghost';
import { createGizmo, type Gizmo } from '../game/gizmo';
import { createTransformHandles, type HandlesHost, type TransformHandles } from '../game/handles';
import { stageParts, translateParts, type InsertSession } from '../game/insert';
import { countOverlaps } from '../game/overlap';
import { findGameWindow, getCapturedRenderer, getCapturedTrack, pickFreeOffsetCells, type GameTrack } from '../game/track';
import { createUndoBridge, isTypingTarget, type UndoBridge } from '../game/undo';
import { parseObj } from '../mesh/obj';
import { parseStl } from '../mesh/stl';
import { applyTransform, IDENTITY, type MeshTransform } from '../mesh/transform';
import { meshBounds, type TriangleMesh } from '../mesh/types';
import { buildParts, PARTS_WARNING, type BuildOptions } from '../voxel/build';
import { voxelize, type VoxelGrid } from '../voxel/voxelize';
import type { TspmlApi } from '../tspml-api';
import { createVoxelPreview, type VoxelPreview } from './preview';
import { parseTypedValue } from './slider-value';

const PANEL_ID = 'poly-to-track-panel';
const TOOLBAR_ID = 'poly-to-track-toolbar';
const LAUNCHER_ID = 'poly-to-track-launcher';
/** White isometric-cube icon, matching the game's flat white toolbar icons
 *  (the launcher `img` reuses the game's own `.button-icon` sizing). */
const LAUNCHER_ICON_SRC = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<path fill="#fff" d="M12 1.6 21.5 7v10L12 22.4 2.5 17V7L12 1.6z' +
  'm-7.5 7.13v6.98l6.5 3.69v-6.98l-6.5-3.69zm15 0-6.5 3.69v6.98l6.5-3.69V8.73z' +
  'M12 3.9 5.6 7.53 12 11.16l6.4-3.63L12 3.9z"/></svg>',
);
const STYLE_ID = 'poly-to-track-style';
// v2: rotate/scale moved out of persisted settings into per-session staging
// state, and `solid` now defaults OFF — key bump re-defaults old stores.
const STORAGE_KEY = 'poly-to-track.settings.v2';
/** How often the launcher button checks it still sits in the right host
 *  (game documents and the editor UI are torn down and rebuilt). The check is
 *  two querySelectors — cheap enough to run fast, so the button appears
 *  as soon as the editor does instead of up to 1.5s later. */
const LAUNCHER_POLL_MS = 250;
/** Scale holds BLOCK size constant and grows the voxel resolution instead
 *  (uniform mesh scaling alone is a no-op under longest-axis normalization).
 *  The cap bounds grid memory: 256 → ≤ 256×1024×256 cells worst case. */
const MIN_EFFECTIVE_RESOLUTION = 2;
const MAX_EFFECTIVE_RESOLUTION = 256;
const MIN_SCALE = 0.1;
const MAX_SCALE = 16;

interface Settings {
  resolution: number;
  solid: boolean;
  color: number;
  useModelColors: boolean;
}

const DEFAULTS: Settings = {
  resolution: 24,
  solid: false,
  color: COLOR_SWATCHES[0]!.id,
  useModelColors: true,
};

/** Rotation/scale are per-model staging state, not persisted settings. */
interface ModelPose {
  rotate: [number, number, number];
  scale: [number, number, number];
}
const identityPose = (): ModelPose => ({ rotate: [0, 0, 0], scale: [1, 1, 1] });

/** Normalize degrees into [-180, 180] (slider range). */
const normDeg = (d: number): number => ((d + 180) % 360 + 360) % 360 - 180;
const clampScale = (s: number): number =>
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(s * 100) / 100));

/** Game-look stylesheet, scoped under the panel/toolbar/launcher ids. Colors
 *  ride the game's own CSS variables so a future palette change restyles us. */
const PANEL_CSS = `
#${PANEL_ID} {
  position: absolute;
  left: var(--safe-area-left, 0px);
  top: 68px;
  width: 360px;
  max-height: calc(100% - 68px);
  display: flex;
  flex-direction: column;
  background-color: var(--surface-secondary-color, #212b58);
  color: var(--text-color, #fff);
  pointer-events: auto;
  z-index: 5;
}
#${PANEL_ID} .ptt-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  font-size: 26px;
  background-color: var(--surface-color, #28346a);
  clip-path: polygon(0 0, 100% 0, calc(100% - 12px) 100%, 0 100%);
}
#${PANEL_ID} .ptt-body {
  padding: 14px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
  min-height: 0;
  scrollbar-width: thin;
}
#${PANEL_ID} button.ptt-btn, #${TOOLBAR_ID} button.ptt-btn {
  margin: 0;
  padding: 6px 14px;
  font-size: 22px;
  font-style: italic;
  color: var(--text-color, #fff);
  background-color: var(--button-color, #112052);
  border: none;
  cursor: pointer;
  clip-path: polygon(0 0, 100% 0, calc(100% - 8px) 100%, 0 100%);
}
#${PANEL_ID} button.ptt-btn:hover, #${TOOLBAR_ID} button.ptt-btn:hover { background-color: var(--button-hover-color, #334b77); }
#${PANEL_ID} button.ptt-btn:active, #${TOOLBAR_ID} button.ptt-btn:active { background-color: var(--button-active-color, #151f41); }
#${PANEL_ID} button.ptt-btn:disabled {
  background-color: var(--button-disabled-color, #313d53);
  color: var(--text-disabled-color, #5d6a7c);
  cursor: default;
}
#${PANEL_ID} button.ptt-btn.primary, #${TOOLBAR_ID} button.ptt-btn.primary { background-color: var(--surface-color, #28346a); font-weight: bold; }
#${PANEL_ID} button.ptt-btn.primary:hover, #${TOOLBAR_ID} button.ptt-btn.primary:hover { background-color: var(--button-hover-color, #334b77); }
#${PANEL_ID} .ptt-title {
  font-size: 16px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.75;
  margin-top: 6px;
}
#${PANEL_ID} .ptt-note { font-size: 17px; opacity: 0.75; min-height: 18px; }
#${PANEL_ID} .ptt-status { font-size: 18px; min-height: 19px; }
#${PANEL_ID} .ptt-row { display: flex; gap: 8px; flex-wrap: wrap; }
#${PANEL_ID} .ptt-row > .ptt-btn { flex: 1; text-align: center; }
#${PANEL_ID} .ptt-slider-top { display: flex; justify-content: space-between; align-items: center; font-size: 18px; }
#${PANEL_ID} button.ptt-readout {
  margin: 0;
  padding: 1px 8px;
  font: inherit;
  color: var(--text-color, #fff);
  background-color: var(--button-color, #112052);
  border: none;
  cursor: text;
  clip-path: polygon(0 0, 100% 0, calc(100% - 4px) 100%, 0 100%);
}
#${PANEL_ID} button.ptt-readout:hover { background-color: var(--button-hover-color, #334b77); }
#${PANEL_ID} input.ptt-readout-edit {
  width: 76px;
  padding: 1px 8px;
  font: inherit;
  color: var(--text-color, #fff);
  background-color: var(--surface-tertiary-color, #192042);
  border: 1px solid var(--button-hover-color, #334b77);
  outline: none;
  text-align: right;
}
#${PANEL_ID} input[type="range"] {
  width: 100%;
  height: 22px;
  margin: 0;
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  cursor: pointer;
}
#${PANEL_ID} input[type="range"]::-webkit-slider-runnable-track {
  height: 6px;
  background-color: var(--button-color, #112052);
  clip-path: polygon(0 0, 100% 0, calc(100% - 4px) 100%, 0 100%);
}
#${PANEL_ID} input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 22px;
  margin-top: -8px;
  background-color: var(--text-color, #fff);
  clip-path: polygon(0 0, 100% 0, calc(100% - 5px) 100%, 0 100%);
}
#${PANEL_ID} input[type="range"]::-moz-range-track {
  height: 6px;
  background-color: var(--button-color, #112052);
  clip-path: polygon(0 0, 100% 0, calc(100% - 4px) 100%, 0 100%);
}
#${PANEL_ID} input[type="range"]::-moz-range-thumb {
  width: 16px;
  height: 22px;
  border: none;
  border-radius: 0;
  background-color: var(--text-color, #fff);
  clip-path: polygon(0 0, 100% 0, calc(100% - 5px) 100%, 0 100%);
}
#${PANEL_ID} .ptt-swatch {
  width: 30px; height: 30px;
  border: 2px solid var(--surface-color, #28346a);
  cursor: pointer;
  clip-path: polygon(0 0, 100% 0, calc(100% - 6px) 100%, 0 100%);
}
#${PANEL_ID} .ptt-swatch.selected { border-color: var(--text-color, #fff); box-shadow: inset 0 0 5px #fff; }
#${PANEL_ID} canvas { background: var(--surface-tertiary-color, #192042); }
#${PANEL_ID} label { font-size: 20px; display: flex; gap: 10px; align-items: center; cursor: pointer; }
#${PANEL_ID} input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  width: 22px;
  height: 22px;
  margin: 0;
  flex: none;
  cursor: pointer;
  background-color: var(--button-color, #112052);
  clip-path: polygon(0 0, 100% 0, calc(100% - 5px) 100%, 0 100%);
  display: grid;
  place-content: center;
}
#${PANEL_ID} input[type="checkbox"]:hover { background-color: var(--button-hover-color, #334b77); }
#${PANEL_ID} input[type="checkbox"]::before {
  content: "";
  width: 12px;
  height: 12px;
  transform: scale(0);
  background-color: var(--text-color, #fff);
  clip-path: polygon(14% 44%, 0 65%, 50% 100%, 100% 16%, 80% 0%, 43% 62%);
}
#${PANEL_ID} input[type="checkbox"]:checked::before { transform: scale(1); }
#${PANEL_ID} input[type="checkbox"]:disabled { background-color: var(--button-disabled-color, #313d53); cursor: default; }
#${TOOLBAR_ID} {
  position: absolute;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  display: none;
  gap: 6px;
  align-items: center;
  padding: 8px 14px;
  background-color: var(--surface-secondary-color, #212b58);
  clip-path: polygon(8px 0, calc(100% - 8px) 0, 100% 100%, 0 100%);
  pointer-events: auto;
  z-index: 6;
}
#${TOOLBAR_ID} .ptt-hint {
  font-size: 15px;
  opacity: 0.7;
  color: var(--text-color, #fff);
  margin-right: 6px;
  max-width: 210px;
}
#${TOOLBAR_ID} .ptt-overlap {
  font-size: 16px;
  color: #ffd27d;
  margin-right: 6px;
  white-space: nowrap;
}
`;

export interface Panel {
  toggle(): void;
  dispose(): void;
}

export function createPanel(api: TspmlApi): Panel {
  // ---- state that survives panel rebuilds (frame reloads) ----
  let mesh: TriangleMesh | null = null;
  let meshName = '';
  let grid: VoxelGrid | null = null;
  let settings = loadSettings();
  let pose = identityPose();
  let revoxTimer = 0;
  let session: InsertSession | null = null;
  let sessionBaseOffset: [number, number, number] = [0, 0, 0];
  let sessionKeyWindow: Window | null = null;
  /** The captured track the live session stages into — overlap checks read it. */
  let sessionTrack: GameTrack | null = null;
  let overlapTimer = 0;
  let gizmo: Gizmo | null = null;
  let ghost: Ghost | null = null;
  let handles: TransformHandles | null = null;
  /** Undo/redo bridge for APPLIED batches (the editor's own stack can't see
   *  them — TSPML#87); recreated per game window. */
  let undoBridge: UndoBridge | null = null;
  let undoWindow: Window | null = null;
  /** Pose snapshot at handle-drag start — drag deltas are TOTALS. */
  let dragPose: ModelPose | null = null;
  /** Editor presence last poll — a true→false edge auto-closes the panel. */
  let wasInEditor = false;
  /** The exit edge closed a panel the user had open — reopen it when they
   *  come back (leaving the editor even briefly, e.g. Escape to the menu,
   *  should not cost them their place). */
  let reopenOnEditorEnter = false;

  // ---- per-build DOM refs ----
  let root: HTMLDivElement | null = null;
  let toolbar: HTMLDivElement | null = null;
  let preview: VoxelPreview | null = null;
  let fileLabel: HTMLDivElement | null = null;
  let poseSliders: SliderCtl[] = []; // X°, Y°, Z°, ×scale — for pose reset
  let stats: HTMLDivElement | null = null;
  let status: HTMLDivElement | null = null;
  let insertBtn: HTMLButtonElement | null = null;
  let saveBtn: HTMLButtonElement | null = null;
  let nameInput: HTMLInputElement | null = null;
  let modelColorsLabel: HTMLLabelElement | null = null;
  let modelColorsCheck: HTMLInputElement | null = null;

  const onSessionKey = (e: KeyboardEvent): void => {
    if (!session?.alive) return;
    if (isTypingTarget(e.target)) return; // Enter in a text field must not Apply
    const handled = handleTransformKey(e.code);
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };

  function handleTransformKey(code: string): boolean {
    const s = session;
    if (!s?.alive) return false;
    switch (code) {
      case 'ArrowLeft': moveSession(-4, 0, 0); return true;
      case 'ArrowRight': moveSession(4, 0, 0); return true;
      case 'ArrowUp': moveSession(0, 0, -4); return true;
      case 'ArrowDown': moveSession(0, 0, 4); return true;
      case 'PageUp': moveSession(0, 1, 0); return true;
      case 'PageDown': moveSession(0, -1, 0); return true;
      case 'KeyR': setPose({ rotate: [pose.rotate[0], normDeg(pose.rotate[1] + 90), pose.rotate[2]] }); return true;
      case 'Enter': endSession('apply'); return true;
      case 'Delete': case 'Backspace': endSession('remove'); return true;
      default: return false;
    }
  }

  function moveSession(dx: number, dy: number, dz: number): void {
    if (!session?.translate(dx, dy, dz)) return;
    ghost?.setOffset(session.offset.x, session.offset.y, session.offset.z);
    syncGizmo();
    scheduleOverlapCheck();
  }

  /** Debounced ghost-vs-track overlap warning (game/overlap.ts — the read
   *  methods come from TSPML's #87 editor research). Runs off the move/rotate
   *  hot path: a drag only pays for the one check after it settles. */
  function scheduleOverlapCheck(): void {
    window.clearTimeout(overlapTimer);
    overlapTimer = window.setTimeout(() => {
      const warn = toolbar?.querySelector<HTMLElement>('.ptt-overlap');
      if (!warn) return;
      if (!session?.alive || !sessionTrack) { warn.style.display = 'none'; return; }
      const res = countOverlaps(sessionTrack, session.parts, session.offset);
      if (!res.supported || res.overlapping === 0) {
        warn.style.display = 'none';
        return;
      }
      warn.style.display = '';
      warn.textContent = `⚠ overlaps ${res.overlapping.toLocaleString()}${res.capped ? '+' : ''} existing part${res.overlapping === 1 && !res.capped ? '' : 's'}`;
    }, 120);
  }

  /** The ONE way pose changes (panel sliders, handles, R key): update state,
   *  mirror the sliders, re-voxelize (debounced — sessions rebuild live). */
  function setPose(next: Partial<ModelPose>): void {
    if (next.rotate) pose.rotate = next.rotate.map(normDeg) as [number, number, number];
    if (next.scale) pose.scale = next.scale.map(clampScale) as [number, number, number];
    syncPoseSliders();
    scheduleRevoxel();
  }

  function syncPoseSliders(): void {
    poseSliders[0]?.set(pose.rotate[0], `${pose.rotate[0]}°`);
    poseSliders[1]?.set(pose.rotate[1], `${pose.rotate[1]}°`);
    poseSliders[2]?.set(pose.rotate[2], `${pose.rotate[2]}°`);
    const [sx, sy, sz] = pose.scale;
    poseSliders[3]?.set(sx, sx === sy && sy === sz ? `×${sx}` : `×${sx}/${sy}/${sz}`);
  }

  /** Track the selection frame + transform handles to the session bounds. */
  function syncGizmo(): void {
    gizmo?.update(session?.alive ? session.bounds : null);
    handles?.refresh();
  }

  /** Callbacks the in-viewport Blender-style handles drive. Rotate/scale
   *  drags report TOTALS since drag start, applied over a pose snapshot. */
  const handlesHost: HandlesHost = {
    bounds: () => (session?.alive ? session.bounds : null),
    onDragStart() {
      dragPose = { rotate: [...pose.rotate], scale: [...pose.scale] };
    },
    onTranslate(dx, dy, dz) {
      moveSession(dx, dy, dz);
    },
    onRotate(axis, totalDegrees) {
      if (!dragPose) return;
      const rotate: [number, number, number] = [...dragPose.rotate];
      rotate[axis] = rotate[axis]! + totalDegrees;
      setPose({ rotate });
    },
    onScale(axis, totalFactor) {
      if (!dragPose) return;
      const scale: [number, number, number] = [...dragPose.scale];
      if (axis === -1) {
        for (let i = 0; i < 3; i++) scale[i] = scale[i]! * totalFactor;
      } else {
        scale[axis] = scale[axis]! * totalFactor;
      }
      setPose({ scale });
    },
    onDragEnd() {
      dragPose = null;
      handles?.refresh();
    },
  };

  function startSessionKeys(w: Window): void {
    stopSessionKeys();
    sessionKeyWindow = w;
    w.addEventListener('keydown', onSessionKey, true);
  }

  function stopSessionKeys(): void {
    sessionKeyWindow?.removeEventListener('keydown', onSessionKey, true);
    sessionKeyWindow = null;
  }

  /** Tear down ghost/gizmo/handles/toolbar/keys — everything visual about a session. */
  function clearSessionUi(): void {
    window.clearTimeout(overlapTimer);
    sessionTrack = null;
    const warn = toolbar?.querySelector<HTMLElement>('.ptt-overlap');
    if (warn) warn.style.display = 'none';
    ghost?.dispose();
    ghost = null;
    gizmo?.dispose();
    gizmo = null;
    handles?.dispose();
    handles = null;
    dragPose = null;
    stopSessionKeys();
    if (toolbar) toolbar.style.display = 'none';
    if (insertBtn) insertBtn.disabled = grid === null || grid.filledCount === 0;
  }

  function endSession(how: 'apply' | 'remove'): void {
    if (session?.alive && how === 'apply') {
      // Final coordinates BEFORE commit clears the session — the undo bridge
      // needs them to revert/re-apply this batch on the editor's undo/redo.
      const applied = translateParts(
        session.parts, session.offset.x, session.offset.y, session.offset.z,
      );
      try {
        const s = session;
        // Commit through the bridge so our own writes don't read as the
        // user's hand edits (which would wipe the undo history).
        if (undoBridge) undoBridge.runInternal(() => s.commit());
        else s.commit(); // the ONE real write into the track
      } catch (err) {
        setStatus(`✗ ${err instanceof Error ? err.message : String(err)} — move the model and try again`, true);
        return; // session stays alive, ghost stays up
      }
      undoBridge?.recordBatch(applied);
    } else {
      session?.remove();
    }
    session = null;
    clearSessionUi();
    setStatus(
      how === 'apply'
        ? '✓ Applied — the parts are part of the track now (the game’s undo button takes them back)'
        : 'Canceled — nothing was placed.',
      false,
    );
  }

  /** Drop a session whose game document (and track) no longer exists. Also
   *  the end of undo history — the edited track left the screen with it. */
  function abandonSession(): void {
    session?.remove();
    session = null;
    clearSessionUi();
    undoBridge?.dispose();
    undoBridge = null;
    undoWindow = null;
  }

  // ---------- UI construction (rebuilt per game document) ----------

  function build(doc: Document): void {
    doc.getElementById(PANEL_ID)?.remove();
    doc.getElementById(TOOLBAR_ID)?.remove();
    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = PANEL_CSS;
      doc.head.appendChild(style);
    }

    root = doc.createElement('div');
    root.id = PANEL_ID;
    root.style.display = 'none';

    const header = doc.createElement('div');
    header.className = 'ptt-header';
    const title = doc.createElement('span');
    title.textContent = 'MODEL IMPORTER';
    const closeBtn = btn(doc, '✕', () => { if (root) root.style.display = 'none'; });
    closeBtn.style.padding = '2px 10px';
    header.append(title, closeBtn);
    root.appendChild(header);

    const body = doc.createElement('div');
    body.className = 'ptt-body';
    root.appendChild(body);

    // file
    const fileInput = doc.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.stl,.obj';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      if (f) void loadFile(f);
    });
    const fileBtn = btn(doc, 'Load STL / OBJ…', () => fileInput.click());
    fileBtn.classList.add('primary');
    fileLabel = doc.createElement('div');
    fileLabel.className = 'ptt-note';
    if (mesh) fileLabel.textContent = `${meshName} — ${mesh.triangleCount.toLocaleString()} triangles`;
    body.append(fileBtn, fileInput, fileLabel);

    // preview
    preview = createVoxelPreview(336, 210, doc);
    body.appendChild(preview.canvas);

    // resolution + solid
    body.appendChild(slider(doc, 'Resolution', 4, MAX_EFFECTIVE_RESOLUTION, settings.resolution, 1, String, (v) => {
      settings.resolution = v;
      scheduleRevoxel();
    }).el);
    const solidLabel = doc.createElement('label');
    const solidCheck = doc.createElement('input');
    solidCheck.type = 'checkbox';
    solidCheck.checked = settings.solid;
    solidCheck.addEventListener('change', () => {
      settings.solid = solidCheck.checked;
      scheduleRevoxel();
    });
    solidLabel.append(solidCheck, doc.createTextNode('Fill interior (solid)'));
    body.appendChild(solidLabel);

    // rotate + scale — one drag anywhere on a slider = any angle; snaps to 5°.
    // Everything here mirrors the in-viewport Blender handles via setPose.
    body.appendChild(sectionTitle(doc, 'Rotate (drag — any angle)'));
    poseSliders = (['X', 'Y', 'Z'] as const).map((axis, i) => {
      const ctl = slider(doc, `${axis} axis`, -180, 180, pose.rotate[i]!, 5, (v) => `${v}°`, (v) => {
        const rotate: [number, number, number] = [...pose.rotate];
        rotate[i] = v;
        pose.rotate = rotate;
        scheduleRevoxel();
      });
      body.appendChild(ctl.el);
      return ctl;
    });
    const scaleCtl = slider(doc, 'Scale', MIN_SCALE, 8, pose.scale[0]!, 0.1, (v) => `×${v}`, (v) => {
      pose.scale = [v, v, v]; // the panel slider scales uniformly; per-axis lives on the 3D handles
      scheduleRevoxel();
    });
    poseSliders.push(scaleCtl);
    body.appendChild(scaleCtl.el);
    const resetBtn = btn(doc, '⟲ Reset rotation & scale', () => setPose(identityPose()));
    body.appendChild(resetBtn);
    syncPoseSliders();

    // color
    body.appendChild(sectionTitle(doc, 'Block color'));
    modelColorsLabel = doc.createElement('label');
    modelColorsCheck = doc.createElement('input');
    modelColorsCheck.type = 'checkbox';
    modelColorsCheck.checked = settings.useModelColors;
    modelColorsCheck.addEventListener('change', () => {
      settings.useModelColors = modelColorsCheck!.checked;
      saveSettings(settings);
      refreshPreview();
      rebuildSessionParts();
    });
    modelColorsLabel.append(modelColorsCheck, doc.createTextNode('Use the model’s own colors'));
    body.appendChild(modelColorsLabel);
    const swatchRow = doc.createElement('div');
    swatchRow.className = 'ptt-row';
    swatchRow.style.flexWrap = 'wrap';
    for (const sw of COLOR_SWATCHES) {
      const b = doc.createElement('button');
      b.className = `ptt-swatch${sw.id === settings.color ? ' selected' : ''}`;
      b.title = sw.name;
      b.style.backgroundColor = sw.hex;
      b.style.flex = 'none';
      b.addEventListener('click', () => {
        settings.color = sw.id;
        saveSettings(settings);
        for (const el of Array.from(swatchRow.children)) el.classList.remove('selected');
        b.classList.add('selected');
        refreshPreview();
        rebuildSessionParts();
      });
      swatchRow.appendChild(b);
    }
    body.appendChild(swatchRow);

    // stats + actions
    stats = doc.createElement('div');
    stats.className = 'ptt-note';
    body.appendChild(stats);

    insertBtn = btn(doc, '⤓ Insert into editor', () => insert());
    insertBtn.classList.add('primary');
    insertBtn.disabled = grid === null || grid.filledCount === 0;
    body.appendChild(insertBtn);

    // save-as-track (secondary path — the old flow, still useful for sharing)
    body.appendChild(sectionTitle(doc, 'Or save as a new track'));
    nameInput = doc.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Track name';
    if (meshName) nameInput.value = meshName;
    saveBtn = btn(doc, 'Save as track', () => void saveAsTrack());
    saveBtn.disabled = grid === null || grid.filledCount === 0;
    body.append(nameInput, saveBtn);

    status = doc.createElement('div');
    status.className = 'ptt-status';
    body.appendChild(status);

    // Floating Apply/Cancel strip — the actual transforms happen on the 3D
    // handles (drag arrows/frames/tips in the viewport) or the keyboard.
    // Independent of the panel, so the panel can be closed while positioning.
    toolbar = doc.createElement('div');
    toolbar.id = TOOLBAR_ID;
    const hint = doc.createElement('span');
    hint.className = 'ptt-hint';
    hint.textContent = 'drag arrows to move, frames to rotate, tips to scale one axis · Enter applies';
    const applyBtn = btn(doc, '✓ Apply', () => endSession('apply'));
    applyBtn.classList.add('primary');
    // Overlap warning — filled in by scheduleOverlapCheck, hidden while clear.
    const overlapWarn = doc.createElement('span');
    overlapWarn.className = 'ptt-overlap';
    overlapWarn.style.display = 'none';
    toolbar.append(hint, overlapWarn, applyBtn, btn(doc, '✕ Cancel', () => endSession('remove')));

    // The game's #ui layer is scaled with the game UI and has
    // pointer-events:none — the panel re-enables its own. Fall back to body
    // (e.g. running outside the game frame in tests).
    const host = doc.getElementById('ui') ?? doc.body;
    host.append(root, toolbar);

    if (grid) refreshStats();
    refreshPreview();
  }

  /** The cube launcher rides INSIDE the editor's own cut/copy/paste
   *  mini-toolbar (leftmost) as one more game-native `button.button` — the editor UI is
   *  rebuilt on every editor entry, so the poll re-injects it each time. The
   *  same poll watches for LEAVING the editor: import is editor-only, so the
   *  panel auto-closes and any staged session is dropped. */
  function pollEditor(): void {
    const w = findGameWindow();
    const doc = w?.document;
    const editorUi = doc?.querySelector('.editor-ui') ?? null;

    const inEditor = editorUi !== null;
    if (wasInEditor && !inEditor) {
      // left the editor — the track being edited is gone from the screen
      abandonSession();
      // Remember an open panel and bring it back on re-entry: Escape to the
      // game menu and back should not silently eat the importer.
      reopenOnEditorEnter = root?.style.display === 'flex' && root.isConnected;
      if (root) root.style.display = 'none';
    }
    if (!wasInEditor && inEditor && reopenOnEditorEnter) {
      reopenOnEditorEnter = false;
      if (root?.isConnected && root.ownerDocument === doc) root.style.display = 'flex';
    }
    wasInEditor = inEditor;
    if (!doc || !editorUi) return;

    // An existing launcher only counts if it lives inside THIS editor UI —
    // a leftover from a previous editor instance (or an orphaned node from a
    // torn-down document) satisfied getElementById and blocked re-injection,
    // which is why the button sometimes never came back on editor re-entry.
    const existing = doc.getElementById(LAUNCHER_ID);
    if (existing) {
      if (existing.isConnected && editorUi.contains(existing)) return;
      existing.remove();
    }
    const host = editorUi.querySelector('.mini-toolbar-container');
    if (!host) return;
    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = PANEL_CSS;
      doc.head.appendChild(style);
    }
    const b = doc.createElement('button');
    b.id = LAUNCHER_ID;
    b.className = 'button'; // the game's own editor-button styling
    b.title = 'Import a 3D model (STL/OBJ) — poly-to-track (P)';
    const icon = doc.createElement('img');
    icon.className = 'button-icon'; // the game's own icon sizing
    icon.src = LAUNCHER_ICON_SRC;
    b.appendChild(icon);
    b.addEventListener('click', () => toggle());
    host.prepend(b); // leftmost, before the game's cut/copy/paste
  }
  const launcherTimer = window.setInterval(pollEditor, LAUNCHER_POLL_MS);
  pollEditor();

  // ---------- behaviour ----------

  async function loadFile(file: File): Promise<void> {
    try {
      const lower = file.name.toLowerCase();
      mesh = lower.endsWith('.obj') ? parseObj(await file.text()) : parseStl(await file.arrayBuffer());
      meshName = file.name.replace(/\.(stl|obj)$/i, '');
      if (nameInput && !nameInput.value) nameInput.value = meshName;
      const colorNote = mesh.colors ? ' · has colors' : '';
      if (fileLabel) fileLabel.textContent = `${file.name} — ${mesh.triangleCount.toLocaleString()} triangles${colorNote}`;
      setPose(identityPose()); // rotation/scale are per-model — new model, fresh pose
      revoxel();
    } catch (err) {
      mesh = null;
      grid = null;
      if (fileLabel) fileLabel.textContent = `⚠ ${err instanceof Error ? err.message : String(err)}`;
      refreshPreview();
      if (stats) stats.textContent = '';
    }
  }

  function scheduleRevoxel(): void {
    saveSettings(settings);
    clearTimeout(revoxTimer);
    revoxTimer = window.setTimeout(revoxel, 150);
  }

  function refreshPreview(): void {
    preview?.setGrid(grid, swatchHex(settings.color), settings.useModelColors);
    // The toggle only means something when the model actually has colors.
    if (modelColorsCheck) modelColorsCheck.disabled = !grid?.colors;
    if (modelColorsLabel) modelColorsLabel.style.opacity = grid?.colors ? '' : '0.45';
  }

  function revoxel(): void {
    if (!mesh) return;
    // Rotate first, THEN derive the voxel cell size from the UNSCALED rotated
    // bounds — scaling must keep block size constant and add blocks (a plain
    // mesh scale would be cancelled by voxelize's longest-axis fit, which is
    // the "scale just makes the map bigger" bug). Equivalent formulation: the
    // effective resolution is resolution × (scaled longest / unscaled longest).
    const rotated = applyTransform(mesh, { ...IDENTITY, rotate: [...pose.rotate] } as MeshTransform);
    const { min, max } = meshBounds(rotated);
    const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const [sx, sy, sz] = pose.scale;
    const l0 = Math.max(size[0]!, size[1]!, size[2]!);
    const l1 = Math.max(size[0]! * sx, size[1]! * sy, size[2]! * sz);
    const effRes = Math.min(
      MAX_EFFECTIVE_RESOLUTION,
      Math.max(MIN_EFFECTIVE_RESOLUTION, Math.round(settings.resolution * (l0 > 0 ? l1 / l0 : 1))),
    );
    // `rotated` is our private copy — scale its positions in place.
    const p = rotated.positions;
    for (let i = 0; i < p.length; i += 3) {
      p[i] = p[i]! * sx;
      p[i + 1] = p[i + 1]! * sy;
      p[i + 2] = p[i + 2]! * sz;
    }
    grid = voxelize(rotated, { resolution: effRes, solid: settings.solid });
    refreshPreview();
    refreshStats();
    rebuildSessionParts();
  }

  /** A live session tracks the sliders/color settings: rebuild in place. */
  function rebuildSessionParts(): void {
    if (!session?.alive || !grid) return;
    try {
      session.replaceParts(buildParts(grid, sessionBuildOptions()));
      ghost?.setParts(session.parts);
      syncGizmo();
      scheduleOverlapCheck();
    } catch (err) {
      setStatus(`⚠ ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  function refreshStats(): void {
    if (!stats || !grid) return;
    const over = grid.filledCount > PARTS_WARNING;
    stats.textContent = `${grid.nx}×${grid.ny}×${grid.nz} grid — ${grid.filledCount.toLocaleString()} blocks${over ? ' — huge build, the game may chug' : ''}`;
    stats.style.color = over ? '#ffd27d' : '';
    const disabled = grid.filledCount === 0;
    if (insertBtn && !session?.alive) insertBtn.disabled = disabled;
    if (saveBtn) saveBtn.disabled = disabled;
  }

  function sessionBuildOptions(): BuildOptions {
    return {
      color: settings.color,
      useModelColors: settings.useModelColors,
      withPad: false,
      offset: sessionBaseOffset,
    };
  }

  function insert(): void {
    if (!grid || grid.filledCount === 0) {
      setStatus('Load a model first.', true);
      return;
    }
    const w = findGameWindow();
    const track = getCapturedTrack(w);
    if (!track) {
      setStatus('No open editor found — open the track editor first, then try again.', true);
      return;
    }
    // One bridge per game window — it survives session end so Applied batches
    // stay undoable, and rebuilds after frame reloads (new window = new one).
    if (w && (undoWindow !== w || !undoBridge)) {
      undoBridge?.dispose();
      undoBridge = createUndoBridge(track, w);
      undoWindow = w;
    }
    try {
      sessionBaseOffset = pickFreeOffsetCells(track);
      session = stageParts(track, buildParts(grid, sessionBuildOptions()));
      sessionTrack = track;
      if (toolbar) toolbar.style.display = 'flex';
      if (insertBtn) insertBtn.disabled = true;
      if (w) startSessionKeys(w);
      // Ghost + selection frame + Blender-style transform handles, all in the
      // game viewport (need the renderer capture; harmless to skip when it's
      // absent — keyboard, sliders and panel stats still work, there's just
      // no visual until Apply).
      const renderer = getCapturedRenderer(w);
      ghost?.dispose();
      ghost = renderer ? createGhost(renderer, session.parts) : null;
      ghost?.setOffset(0, 0, 0);
      gizmo?.dispose();
      gizmo = renderer ? createGizmo(renderer) : null;
      handles?.dispose();
      handles = renderer && w ? createTransformHandles(renderer, w, handlesHost) : null;
      syncGizmo();
      scheduleOverlapCheck(); // pickFreeOffsetCells aims past the build, but verify
      setStatus(`Staged ${session.count.toLocaleString()} parts — drag the handles, then Apply.`, false);
    } catch (err) {
      session = null;
      setStatus(`✗ ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  async function saveAsTrack(): Promise<void> {
    if (!grid || grid.filledCount === 0) {
      setStatus('Load a model first.', true);
      return;
    }
    try {
      const name = nameInput?.value.trim() || meshName || 'poly-to-track model';
      const parts = buildParts(grid, { color: settings.color, useModelColors: settings.useModelColors });
      const code = toExportString(parts, { name, author: 'poly-to-track' });
      setStatus('Saving…', false);
      const res = await api.tracks.register({ code, name, overwrite: true, persist: true });
      setStatus(res.ok ? `✓ Saved “${res.name ?? name}” — check your track list` : `✗ ${res.reason ?? 'failed'}`, !res.ok);
    } catch (err) {
      setStatus(`✗ ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  function setStatus(text: string, isError: boolean): void {
    if (!status) return;
    status.textContent = text;
    status.style.color = isError ? '#ff9696' : '#96ff96';
  }

  function toggle(): void {
    // Rebuild when unbuilt or orphaned (frame reload replaced the document).
    const gameDoc = findGameWindow()?.document ?? document;
    if (!root || !root.isConnected || root.ownerDocument !== gameDoc) {
      abandonSession(); // the old document's track/scene is gone; nothing was placed
      preview?.dispose();
      build(gameDoc);
      root!.style.display = 'flex';
      return;
    }
    root.style.display = root.style.display === 'none' ? 'flex' : 'none';
  }

  return {
    toggle,
    dispose() {
      clearTimeout(revoxTimer);
      clearInterval(launcherTimer);
      abandonSession(); // staged-only — unload must not silently write the track
      preview?.dispose();
      root?.remove();
      toolbar?.remove();
      try { findGameWindow()?.document.getElementById(LAUNCHER_ID)?.remove(); } catch { /* frame gone */ }
    },
  };
}

// ---------- small helpers ----------

function btn(doc: Document, text: string, onClick: () => void): HTMLButtonElement {
  const b = doc.createElement('button');
  b.className = 'ptt-btn';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function sectionTitle(doc: Document, text: string): HTMLDivElement {
  const d = doc.createElement('div');
  d.className = 'ptt-title';
  d.textContent = text;
  return d;
}

interface SliderCtl {
  el: HTMLDivElement;
  /** Move the slider + readout WITHOUT firing onChange (external updates —
   *  e.g. the 3D handles rotating the model — mirror into the panel). */
  set(value: number, readout?: string): void;
}

function slider(
  doc: Document, label: string, min: number, max: number, value: number,
  step: number, fmt: (v: number) => string, onChange: (v: number) => void,
): SliderCtl {
  const el = doc.createElement('div');
  const top = doc.createElement('div');
  top.className = 'ptt-slider-top';
  const readout = doc.createElement('button');
  readout.type = 'button';
  readout.className = 'ptt-readout';
  readout.title = 'Click to type an exact value';
  readout.textContent = fmt(value);
  top.append(doc.createTextNode(label), readout);
  const input = doc.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  // step="any" + manual drag snapping: a native step would also snap values
  // ASSIGNED to the input, silently turning a typed 37° into 35.
  input.step = 'any';
  input.value = String(value);
  const decimals = (String(step).split('.')[1] ?? '').length;
  input.addEventListener('input', () => {
    const v = Number((Math.round(Number(input.value) / step) * step).toFixed(decimals));
    input.value = String(v);
    readout.textContent = fmt(v);
    onChange(v);
  });

  // Click the number → an inline text field; Enter/blur commits (clamped to
  // the range, free of the drag snap), Escape cancels. This is the only way
  // to enter exact values like 37° or ×1.55.
  readout.addEventListener('click', () => {
    const edit = doc.createElement('input');
    edit.type = 'text';
    edit.className = 'ptt-readout-edit';
    edit.value = String(Number(input.value));
    edit.setAttribute('inputmode', 'decimal');
    readout.style.display = 'none';
    top.appendChild(edit);
    edit.focus();
    edit.select();
    let done = false;
    const close = (commit: boolean): void => {
      if (done) return;
      done = true;
      if (commit) {
        const v = parseTypedValue(edit.value, min, max);
        if (v !== null) {
          input.value = String(v);
          readout.textContent = fmt(v);
          onChange(v);
        }
      }
      edit.remove();
      readout.style.display = '';
    };
    edit.addEventListener('keydown', (e) => {
      // Capture-phase window listeners (session keys, undo bridge, the game)
      // fire BEFORE this — they carry their own typing-target guards; this
      // stops anything listening in the bubble phase.
      e.stopPropagation();
      if (e.key === 'Enter') close(true);
      else if (e.key === 'Escape') close(false);
    });
    edit.addEventListener('blur', () => close(true));
  });

  el.append(top, input);
  return {
    el,
    set(v, text) {
      input.value = String(v);
      readout.textContent = text ?? fmt(v);
    },
  };
}

function swatchHex(colorId: number): string {
  return COLOR_SWATCHES.find((s) => s.id === colorId)?.hex ?? '#b8b8b8';
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) as Partial<Settings> };
  } catch { /* corrupted settings fall back to defaults */ }
  return { ...DEFAULTS };
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch { /* storage full/blocked — settings just won't persist */ }
}
