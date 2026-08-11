/**
 * The importer panel, embedded INSIDE the game frame and styled like the
 * game's own editor UI (same CSS custom properties, the same skewed clip-path
 * panels, and — because the panel lives in the game document — the game's
 * ForcedSquare italic font for free).
 *
 * Flow: load a 3D file → orbit the voxel preview → pick resolution / color →
 * **Insert into editor**, which places the parts into the OPEN editor via the
 * mixin-captured track instance and enters transform mode: move / rotate /
 * scale the placed model (buttons or keyboard), then Apply or Remove.
 * Blender-ish keys while transforming: arrows move, PgUp/PgDn raise/lower,
 * R rotates 90°, Enter applies, Delete removes.
 *
 * The game document is torn down on every in-game reload, so the panel
 * rebuilds itself lazily on toggle whenever its root is orphaned.
 */
import { COLOR_SWATCHES } from '../codec/parts';
import { toExportString } from '../codec/encode';
import { createGizmo, type Gizmo } from '../game/gizmo';
import { insertParts, type InsertSession } from '../game/insert';
import { findGameWindow, getCapturedRenderer, getCapturedTrack, pickFreeOffsetCells } from '../game/track';
import { parseObj } from '../mesh/obj';
import { parseStl } from '../mesh/stl';
import { applyTransform, IDENTITY, type MeshTransform } from '../mesh/transform';
import type { TriangleMesh } from '../mesh/types';
import { buildParts, MAX_PARTS, type BuildOptions } from '../voxel/build';
import { voxelize, type VoxelGrid } from '../voxel/voxelize';
import type { TspmlApi } from '../tspml-api';
import { createVoxelPreview, type VoxelPreview } from './preview';

const PANEL_ID = 'poly-to-track-panel';
const STYLE_ID = 'poly-to-track-style';
const STORAGE_KEY = 'poly-to-track.settings.v1';

interface Settings {
  resolution: number;
  solid: boolean;
  color: number;
  rotate: [number, number, number];
  scale: number;
}

const DEFAULTS: Settings = {
  resolution: 24,
  solid: true,
  color: COLOR_SWATCHES[0]!.id,
  rotate: [0, 0, 0],
  scale: 1,
};

/** Game-look stylesheet, scoped under the panel id. Colors ride the game's
 *  own CSS variables so a future palette change restyles us too. */
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
#${PANEL_ID} button.ptt-btn {
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
#${PANEL_ID} button.ptt-btn:hover { background-color: var(--button-hover-color, #334b77); }
#${PANEL_ID} button.ptt-btn:active { background-color: var(--button-active-color, #151f41); }
#${PANEL_ID} button.ptt-btn:disabled {
  background-color: var(--button-disabled-color, #313d53);
  color: var(--text-disabled-color, #5d6a7c);
  cursor: default;
}
#${PANEL_ID} button.ptt-btn.primary { background-color: var(--surface-color, #28346a); font-weight: bold; }
#${PANEL_ID} button.ptt-btn.primary:hover { background-color: var(--button-hover-color, #334b77); }
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

  // ---- per-build DOM refs ----
  let root: HTMLDivElement | null = null;
  let preview: VoxelPreview | null = null;
  let fileLabel: HTMLDivElement | null = null;
  let stats: HTMLDivElement | null = null;
  let status: HTMLDivElement | null = null;
  let insertBtn: HTMLButtonElement | null = null;
  let saveBtn: HTMLButtonElement | null = null;
  let nameInput: HTMLInputElement | null = null;
  let transformBox: HTMLDivElement | null = null;

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
    session?.translate(dx, dy, dz);
    syncGizmo();
  }

  function rotateSession(): void {
    session?.rotateY();
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

  function endSession(how: 'apply' | 'remove'): void {
    if (session) {
      if (how === 'apply') session.commit();
      else session.remove();
      session = null;
    }
    gizmo?.dispose();
    gizmo = null;
    stopSessionKeys();
    if (transformBox) transformBox.style.display = 'none';
    if (insertBtn) insertBtn.disabled = grid === null || grid.filledCount === 0;
    setStatus(how === 'apply' ? '✓ Applied — the parts are part of the track now' : 'Removed.', false);
  }

  // ---------- UI construction (rebuilt per game document) ----------

  function build(doc: Document): void {
    doc.getElementById(PANEL_ID)?.remove();
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
        preview?.setGrid(grid, swatchHex(settings.color));
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

    // transform mode (hidden until an insert succeeds)
    transformBox = doc.createElement('div');
    transformBox.style.cssText = 'display:none;flex-direction:column;gap:5px';
    transformBox.appendChild(sectionTitle(doc, 'Transform — arrows move · PgUp/PgDn raise · R rotates'));
    const moveRow1 = doc.createElement('div');
    moveRow1.className = 'ptt-row';
    moveRow1.append(
      btn(doc, '◀ X', () => moveSession(-4, 0, 0)),
      btn(doc, 'X ▶', () => moveSession(4, 0, 0)),
      btn(doc, '▲ Z', () => moveSession(0, 0, -4)),
      btn(doc, 'Z ▼', () => moveSession(0, 0, 4)),
    );
    const moveRow2 = doc.createElement('div');
    moveRow2.className = 'ptt-row';
    moveRow2.append(
      btn(doc, 'Up', () => moveSession(0, 1, 0)),
      btn(doc, 'Down', () => moveSession(0, -1, 0)),
      btn(doc, '⟳ 90°', () => rotateSession()),
    );
    const endRow = doc.createElement('div');
    endRow.className = 'ptt-row';
    const applyBtn = btn(doc, '✓ Apply (Enter)', () => endSession('apply'));
    applyBtn.classList.add('primary');
    endRow.append(applyBtn, btn(doc, '✕ Remove (Del)', () => endSession('remove')));
    transformBox.append(moveRow1, moveRow2, endRow);
    body.appendChild(transformBox);

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

    // The game's #ui layer is scaled with the game UI and has
    // pointer-events:none — the panel re-enables its own. Fall back to body
    // (e.g. running outside the game frame in tests).
    (doc.getElementById('ui') ?? doc.body).appendChild(root);

    if (grid) refreshStats();
    preview.setGrid(grid, swatchHex(settings.color));
  }

  // ---------- behaviour ----------

  async function loadFile(file: File): Promise<void> {
    try {
      const lower = file.name.toLowerCase();
      mesh = lower.endsWith('.obj') ? parseObj(await file.text()) : parseStl(await file.arrayBuffer());
      meshName = file.name.replace(/\.(stl|obj)$/i, '');
      if (nameInput && !nameInput.value) nameInput.value = meshName;
      if (fileLabel) fileLabel.textContent = `${file.name} — ${mesh.triangleCount.toLocaleString()} triangles`;
      revoxel();
    } catch (err) {
      mesh = null;
      grid = null;
      if (fileLabel) fileLabel.textContent = `⚠ ${err instanceof Error ? err.message : String(err)}`;
      preview?.setGrid(null, swatchHex(settings.color));
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

  function revoxel(): void {
    if (!mesh) return;
    grid = voxelize(applyTransform(mesh, currentTransform()), {
      resolution: settings.resolution,
      solid: settings.solid,
    });
    preview?.setGrid(grid, swatchHex(settings.color));
    refreshStats();
    // A live session tracks the sliders: rebuild and swap in place.
    if (session?.alive && grid) {
      try {
        session.replaceParts(buildParts(grid, sessionBuildOptions()));
        syncGizmo();
      } catch (err) {
        setStatus(`⚠ ${err instanceof Error ? err.message : String(err)}`, true);
      }
    }
  }

  function refreshStats(): void {
    if (!stats || !grid) return;
    const over = grid.filledCount > MAX_PARTS;
    stats.textContent = `${grid.nx}×${grid.ny}×${grid.nz} grid — ${grid.filledCount.toLocaleString()} blocks${over ? ` (over the ${MAX_PARTS.toLocaleString()} limit!)` : ''}`;
    stats.style.color = over ? '#ff9696' : '';
    const disabled = over || grid.filledCount === 0;
    if (insertBtn && !session?.alive) insertBtn.disabled = disabled;
    if (saveBtn) saveBtn.disabled = disabled;
  }

  function sessionBuildOptions(): BuildOptions {
    return { color: settings.color, withPad: false, offset: sessionBaseOffset };
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
      session = insertParts(track, buildParts(grid, sessionBuildOptions()));
      if (transformBox) transformBox.style.display = 'flex';
      if (insertBtn) insertBtn.disabled = true;
      if (w) startSessionKeys(w);
      // Blender-style selection frame in the game viewport (needs the
      // renderer capture; harmless to skip when it's absent).
      const renderer = getCapturedRenderer(w);
      gizmo?.dispose();
      gizmo = renderer ? createGizmo(renderer) : null;
      syncGizmo();
      setStatus(`Inserted ${session.count.toLocaleString()} parts — move/rotate, then Apply.`, false);
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
      const parts = buildParts(grid, { color: settings.color });
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

  return {
    toggle() {
      // Rebuild when unbuilt or orphaned (frame reload replaced the document).
      const gameDoc = findGameWindow()?.document ?? document;
      if (!root || !root.isConnected || root.ownerDocument !== gameDoc) {
        if (session?.alive) endSession('apply'); // old document's track is gone; drop tracking
        preview?.dispose();
        build(gameDoc);
        root!.style.display = 'flex';
        return;
      }
      root.style.display = root.style.display === 'none' ? 'flex' : 'none';
    },
    dispose() {
      clearTimeout(revoxTimer);
      if (session?.alive) session.commit();
      gizmo?.dispose();
      gizmo = null;
      stopSessionKeys();
      preview?.dispose();
      root?.remove();
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
