/**
 * The importer panel, embedded INSIDE the game frame and styled like the
 * game's own editor UI (same CSS custom properties, the same skewed clip-path
 * panels, and — because the panel lives in the game document — the game's
 * ForcedSquare italic font for free).
 *
 * Flow: load a 3D file → orbit the voxel preview → pick resolution / color →
 * **Insert into editor**, which STAGES the parts (nothing written to the
 * track yet) and shows a translucent ghost of the model in the game viewport
 * plus a floating transform toolbar UNDER the viewport: move / rotate / raise
 * / lower, then Apply does the one real placement. Blender-ish keys while
 * transforming: arrows move, PgUp/PgDn raise/lower, R rotates 90°, Enter
 * applies, Delete cancels.
 *
 * Besides the P keybind there's a persistent “3D IMPORT” launcher button
 * injected into the game UI (re-injected automatically after in-game
 * reloads, which tear down the whole game document).
 */
import { COLOR_SWATCHES } from '../codec/parts';
import { toExportString } from '../codec/encode';
import { createGhost, type Ghost } from '../game/ghost';
import { createGizmo, type Gizmo } from '../game/gizmo';
import { stageParts, type InsertSession } from '../game/insert';
import { findGameWindow, getCapturedRenderer, getCapturedTrack, pickFreeOffsetCells } from '../game/track';
import { parseObj } from '../mesh/obj';
import { parseStl } from '../mesh/stl';
import { applyTransform, IDENTITY, type MeshTransform } from '../mesh/transform';
import type { TriangleMesh } from '../mesh/types';
import { buildParts, PARTS_WARNING, type BuildOptions } from '../voxel/build';
import { voxelize, type VoxelGrid } from '../voxel/voxelize';
import type { TspmlApi } from '../tspml-api';
import { createVoxelPreview, type VoxelPreview } from './preview';

const PANEL_ID = 'poly-to-track-panel';
const TOOLBAR_ID = 'poly-to-track-toolbar';
const LAUNCHER_ID = 'poly-to-track-launcher';
const STYLE_ID = 'poly-to-track-style';
const STORAGE_KEY = 'poly-to-track.settings.v1';
/** How often the launcher button checks it still exists in the (possibly
 *  reloaded) game document. */
const LAUNCHER_POLL_MS = 1500;

interface Settings {
  resolution: number;
  solid: boolean;
  color: number;
  useModelColors: boolean;
  rotate: [number, number, number];
  scale: number;
}

const DEFAULTS: Settings = {
  resolution: 24,
  solid: true,
  color: COLOR_SWATCHES[0]!.id,
  useModelColors: true,
  rotate: [0, 0, 0],
  scale: 1,
};

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
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  min-height: 0;
  scrollbar-width: thin;
}
#${PANEL_ID} button.ptt-btn, #${TOOLBAR_ID} button.ptt-btn, #${LAUNCHER_ID} {
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
#${PANEL_ID} button.ptt-btn:hover, #${TOOLBAR_ID} button.ptt-btn:hover, #${LAUNCHER_ID}:hover { background-color: var(--button-hover-color, #334b77); }
#${PANEL_ID} button.ptt-btn:active, #${TOOLBAR_ID} button.ptt-btn:active, #${LAUNCHER_ID}:active { background-color: var(--button-active-color, #151f41); }
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
  margin-top: 2px;
}
#${PANEL_ID} .ptt-note { font-size: 17px; opacity: 0.75; min-height: 18px; }
#${PANEL_ID} .ptt-status { font-size: 18px; min-height: 19px; }
#${PANEL_ID} .ptt-row { display: flex; gap: 5px; }
#${PANEL_ID} .ptt-row > .ptt-btn { flex: 1; text-align: center; }
#${PANEL_ID} .ptt-slider-top { display: flex; justify-content: space-between; font-size: 20px; }
#${PANEL_ID} input[type="range"] { width: 100%; height: 24px; }
#${PANEL_ID} .ptt-swatch {
  width: 30px; height: 30px;
  border: 2px solid var(--surface-color, #28346a);
  cursor: pointer;
  clip-path: polygon(0 0, 100% 0, calc(100% - 6px) 100%, 0 100%);
}
#${PANEL_ID} .ptt-swatch.selected { border-color: var(--text-color, #fff); box-shadow: inset 0 0 5px #fff; }
#${PANEL_ID} canvas { background: var(--surface-tertiary-color, #192042); }
#${PANEL_ID} label { font-size: 20px; display: flex; gap: 8px; align-items: center; cursor: pointer; }
#${PANEL_ID} input[type="checkbox"] { width: 20px; height: 20px; accent-color: var(--surface-color, #28346a); }
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
#${LAUNCHER_ID} {
  position: absolute;
  right: calc(var(--safe-area-right, 0px) + 10px);
  top: 68px;
  font-size: 19px;
  pointer-events: auto;
  z-index: 5;
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
  let revoxTimer = 0;
  let session: InsertSession | null = null;
  let sessionBaseOffset: [number, number, number] = [0, 0, 0];
  let sessionKeyWindow: Window | null = null;
  let gizmo: Gizmo | null = null;
  let ghost: Ghost | null = null;

  // ---- per-build DOM refs ----
  let root: HTMLDivElement | null = null;
  let toolbar: HTMLDivElement | null = null;
  let preview: VoxelPreview | null = null;
  let fileLabel: HTMLDivElement | null = null;
  let stats: HTMLDivElement | null = null;
  let status: HTMLDivElement | null = null;
  let insertBtn: HTMLButtonElement | null = null;
  let saveBtn: HTMLButtonElement | null = null;
  let nameInput: HTMLInputElement | null = null;
  let modelColorsLabel: HTMLLabelElement | null = null;
  let modelColorsCheck: HTMLInputElement | null = null;

  const onSessionKey = (e: KeyboardEvent): void => {
    if (!session?.alive) return;
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
      case 'KeyR': rotateSession(); return true;
      case 'Enter': endSession('apply'); return true;
      case 'Delete': case 'Backspace': endSession('remove'); return true;
      default: return false;
    }
  }

  function moveSession(dx: number, dy: number, dz: number): void {
    if (!session?.translate(dx, dy, dz)) return;
    ghost?.setOffset(session.offset.x, session.offset.y, session.offset.z);
    syncGizmo();
  }

  function rotateSession(): void {
    if (!session?.alive) return;
    session.rotateY();
    ghost?.setParts(session.parts);
    syncGizmo();
  }

  /** Track the selection frame to the session's current bounds. */
  function syncGizmo(): void {
    gizmo?.update(session?.alive ? session.bounds : null);
  }

  function startSessionKeys(w: Window): void {
    stopSessionKeys();
    sessionKeyWindow = w;
    w.addEventListener('keydown', onSessionKey, true);
  }

  function stopSessionKeys(): void {
    sessionKeyWindow?.removeEventListener('keydown', onSessionKey, true);
    sessionKeyWindow = null;
  }

  /** Tear down ghost/gizmo/toolbar/keys — everything visual about a session. */
  function clearSessionUi(): void {
    ghost?.dispose();
    ghost = null;
    gizmo?.dispose();
    gizmo = null;
    stopSessionKeys();
    if (toolbar) toolbar.style.display = 'none';
    if (insertBtn) insertBtn.disabled = grid === null || grid.filledCount === 0;
  }

  function endSession(how: 'apply' | 'remove'): void {
    if (session?.alive && how === 'apply') {
      try {
        session.commit(); // the ONE real write into the track
      } catch (err) {
        setStatus(`✗ ${err instanceof Error ? err.message : String(err)} — move the model and try again`, true);
        return; // session stays alive, ghost stays up
      }
    } else {
      session?.remove();
    }
    session = null;
    clearSessionUi();
    setStatus(how === 'apply' ? '✓ Applied — the parts are part of the track now' : 'Canceled — nothing was placed.', false);
  }

  /** Drop a session whose game document (and track) no longer exists. */
  function abandonSession(): void {
    session?.remove();
    session = null;
    clearSessionUi();
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
    body.appendChild(slider(doc, 'Resolution', 4, 128, settings.resolution, 1, String, (v) => {
      settings.resolution = v;
      scheduleRevoxel();
    }));
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

    // rotate + scale
    body.appendChild(sectionTitle(doc, 'Rotate model (90° steps)'));
    const rotRow = doc.createElement('div');
    rotRow.className = 'ptt-row';
    (['X', 'Y', 'Z'] as const).forEach((axis, i) => {
      rotRow.appendChild(btn(doc, `${axis} +90°`, () => {
        settings.rotate[i] = (settings.rotate[i]! + 90) % 360;
        scheduleRevoxel();
      }));
    });
    body.appendChild(rotRow);
    body.appendChild(slider(doc, 'Scale', 0.25, 4, settings.scale, 0.25, (v) => `×${v}`, (v) => {
      settings.scale = v;
      scheduleRevoxel();
    }));

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

    // Floating transform toolbar — lives in the game viewport, shown only
    // while a session is being positioned. Independent of the panel, so the
    // panel can be closed while the ghost is moved around.
    toolbar = doc.createElement('div');
    toolbar.id = TOOLBAR_ID;
    const hint = doc.createElement('span');
    hint.className = 'ptt-hint';
    hint.textContent = 'arrows move · PgUp/PgDn raise · R rotates · Enter applies';
    const applyBtn = btn(doc, '✓ Apply', () => endSession('apply'));
    applyBtn.classList.add('primary');
    toolbar.append(
      hint,
      btn(doc, '◀', () => moveSession(-4, 0, 0)),
      btn(doc, '▶', () => moveSession(4, 0, 0)),
      btn(doc, '▲', () => moveSession(0, 0, -4)),
      btn(doc, '▼', () => moveSession(0, 0, 4)),
      btn(doc, 'Up', () => moveSession(0, 1, 0)),
      btn(doc, 'Down', () => moveSession(0, -1, 0)),
      btn(doc, '⟳ 90°', () => rotateSession()),
      applyBtn,
      btn(doc, '✕ Cancel', () => endSession('remove')),
    );

    // The game's #ui layer is scaled with the game UI and has
    // pointer-events:none — the panel re-enables its own. Fall back to body
    // (e.g. running outside the game frame in tests).
    const host = doc.getElementById('ui') ?? doc.body;
    host.append(root, toolbar);

    if (grid) refreshStats();
    refreshPreview();
  }

  /** Persistent “3D IMPORT” button in the game UI (task: no P key needed).
   *  Re-injected by the poll whenever a reload replaced the game document. */
  function ensureLauncher(): void {
    const w = findGameWindow();
    if (!w) return;
    const doc = w.document;
    if (doc.getElementById(LAUNCHER_ID)) return;
    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = PANEL_CSS;
      doc.head.appendChild(style);
    }
    const b = doc.createElement('button');
    b.id = LAUNCHER_ID;
    b.textContent = '🧊 3D IMPORT';
    b.title = 'poly-to-track — import an STL/OBJ model (P)';
    b.addEventListener('click', () => toggle());
    (doc.getElementById('ui') ?? doc.body).appendChild(b);
  }
  const launcherTimer = window.setInterval(ensureLauncher, LAUNCHER_POLL_MS);
  ensureLauncher();

  // ---------- behaviour ----------

  async function loadFile(file: File): Promise<void> {
    try {
      const lower = file.name.toLowerCase();
      mesh = lower.endsWith('.obj') ? parseObj(await file.text()) : parseStl(await file.arrayBuffer());
      meshName = file.name.replace(/\.(stl|obj)$/i, '');
      if (nameInput && !nameInput.value) nameInput.value = meshName;
      const colorNote = mesh.colors ? ' · has colors' : '';
      if (fileLabel) fileLabel.textContent = `${file.name} — ${mesh.triangleCount.toLocaleString()} triangles${colorNote}`;
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

  function currentTransform(): MeshTransform {
    return {
      ...IDENTITY,
      rotate: [...settings.rotate],
      scale: [settings.scale, settings.scale, settings.scale],
    };
  }

  function refreshPreview(): void {
    preview?.setGrid(grid, swatchHex(settings.color), settings.useModelColors);
    // The toggle only means something when the model actually has colors.
    if (modelColorsCheck) modelColorsCheck.disabled = !grid?.colors;
    if (modelColorsLabel) modelColorsLabel.style.opacity = grid?.colors ? '' : '0.45';
  }

  function revoxel(): void {
    if (!mesh) return;
    grid = voxelize(applyTransform(mesh, currentTransform()), {
      resolution: settings.resolution,
      solid: settings.solid,
    });
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
    try {
      sessionBaseOffset = pickFreeOffsetCells(track);
      session = stageParts(track, buildParts(grid, sessionBuildOptions()));
      if (toolbar) toolbar.style.display = 'flex';
      if (insertBtn) insertBtn.disabled = true;
      if (w) startSessionKeys(w);
      // Ghost + Blender-style selection frame in the game viewport (need the
      // renderer capture; harmless to skip when it's absent — the toolbar and
      // panel stats still work, there's just no visual until Apply).
      const renderer = getCapturedRenderer(w);
      ghost?.dispose();
      ghost = renderer ? createGhost(renderer, session.parts) : null;
      ghost?.setOffset(0, 0, 0);
      gizmo?.dispose();
      gizmo = renderer ? createGizmo(renderer) : null;
      syncGizmo();
      setStatus(`Staged ${session.count.toLocaleString()} parts — position the ghost, then Apply.`, false);
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

function slider(
  doc: Document, label: string, min: number, max: number, value: number,
  step: number, fmt: (v: number) => string, onChange: (v: number) => void,
): HTMLDivElement {
  const el = doc.createElement('div');
  const top = doc.createElement('div');
  top.className = 'ptt-slider-top';
  const readout = doc.createElement('span');
  readout.textContent = fmt(value);
  top.append(doc.createTextNode(label), readout);
  const input = doc.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    readout.textContent = fmt(v);
    onChange(v);
  });
  el.append(top, input);
  return el;
}

function swatchHex(colorId: number): string {
  return COLOR_SWATCHES.find((s) => s.id === colorId)?.hex ?? '#b8b8b8';
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const merged = { ...DEFAULTS, ...JSON.parse(raw) as Partial<Settings> };
      return { ...merged, rotate: [...merged.rotate] as [number, number, number] };
    }
  } catch { /* corrupted settings fall back to defaults */ }
  return { ...DEFAULTS, rotate: [...DEFAULTS.rotate] };
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch { /* storage full/blocked — settings just won't persist */ }
}
