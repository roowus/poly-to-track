/**
 * Schematica-style floating panel: load a 3D file, orbit the voxel preview,
 * rotate/scale/nudge the model, pick resolution + color, then generate a
 * playable PolyTrack track via api.tracks.register.
 *
 * All DOM lives under one root with inline styles (no page CSS dependencies);
 * dispose() removes everything.
 */
import { COLOR_SWATCHES } from '../codec/parts';
import { toExportString } from '../codec/encode';
import { parseObj } from '../mesh/obj';
import { parseStl } from '../mesh/stl';
import { applyTransform, IDENTITY, type MeshTransform } from '../mesh/transform';
import type { TriangleMesh } from '../mesh/types';
import { buildParts, MAX_PARTS } from '../voxel/build';
import { voxelize, type VoxelGrid } from '../voxel/voxelize';
import type { TspmlApi } from '../tspml-api';
import { createVoxelPreview } from './preview';

const PANEL_ID = 'poly-to-track-panel';
const STORAGE_KEY = 'poly-to-track.settings.v1';

interface Settings {
  resolution: number;
  solid: boolean;
  color: number;
  rotate: [number, number, number];
  scale: number;
  offset: [number, number, number];
}

const DEFAULTS: Settings = {
  resolution: 24,
  solid: true,
  color: COLOR_SWATCHES[0]!.id,
  rotate: [0, 0, 0],
  scale: 1,
  offset: [0, 0, 0],
};

export interface Panel {
  toggle(): void;
  dispose(): void;
}

export function createPanel(api: TspmlApi): Panel {
  document.getElementById(PANEL_ID)?.remove();

  let mesh: TriangleMesh | null = null;
  let meshName = '';
  let grid: VoxelGrid | null = null;
  let settings = loadSettings();
  let revoxTimer = 0;

  // ---------- root ----------
  const root = document.createElement('div');
  root.id = PANEL_ID;
  root.style.cssText = [
    'position:fixed', 'top:64px', 'right:16px', 'width:320px', 'z-index:99999',
    'background:rgba(18,20,28,0.95)', 'color:#e8e8f0', 'border:1px solid #3a3f55',
    'border-radius:10px', 'font:13px/1.45 system-ui,sans-serif',
    'box-shadow:0 8px 32px rgba(0,0,0,0.5)', 'display:none', 'user-select:none',
  ].join(';');

  // ---------- header (drag handle) ----------
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 12px;cursor:move;border-bottom:1px solid #3a3f55';
  header.innerHTML = '<b>poly-to-track</b>';
  const closeBtn = button('✕', () => { root.style.display = 'none'; });
  closeBtn.style.padding = '0 6px';
  header.appendChild(closeBtn);
  root.appendChild(header);
  makeDraggable(root, header);

  const body = document.createElement('div');
  body.style.cssText = 'padding:12px;display:flex;flex-direction:column;gap:10px';
  root.appendChild(body);

  // ---------- file row ----------
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.stl,.obj';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) void loadFile(f);
  });
  const fileBtn = button('📂 Load STL / OBJ…', () => fileInput.click());
  fileBtn.style.width = '100%';
  const fileLabel = document.createElement('div');
  fileLabel.style.cssText = 'color:#9aa0b8;font-size:12px;min-height:15px';
  body.append(fileBtn, fileInput, fileLabel);

  // ---------- preview ----------
  const preview = createVoxelPreview(294, 200);
  preview.canvas.style.cssText += ';border:1px solid #3a3f55;border-radius:6px;background:#0c0e14';
  body.appendChild(preview.canvas);

  // ---------- resolution + solid ----------
  const resRow = sliderRow('Resolution', 4, 128, settings.resolution, (v) => {
    settings.resolution = v;
    scheduleRevoxel();
  });
  body.appendChild(resRow.el);

  const solidLabel = document.createElement('label');
  solidLabel.style.cssText = 'display:flex;gap:6px;align-items:center;cursor:pointer';
  const solidCheck = document.createElement('input');
  solidCheck.type = 'checkbox';
  solidCheck.checked = settings.solid;
  solidCheck.addEventListener('change', () => {
    settings.solid = solidCheck.checked;
    scheduleRevoxel();
  });
  solidLabel.append(solidCheck, document.createTextNode('Fill interior (solid)'));
  body.appendChild(solidLabel);

  // ---------- rotate ----------
  body.appendChild(sectionTitle('Rotate (90° steps)'));
  const rotRow = document.createElement('div');
  rotRow.style.cssText = 'display:flex;gap:6px';
  (['X', 'Y', 'Z'] as const).forEach((axis, i) => {
    const b = button(`${axis} +90°`, () => {
      settings.rotate[i] = (settings.rotate[i]! + 90) % 360;
      rotState.textContent = rotateText();
      scheduleRevoxel();
    });
    b.style.flex = '1';
    rotRow.appendChild(b);
  });
  const rotState = document.createElement('div');
  rotState.style.cssText = 'color:#9aa0b8;font-size:12px';
  rotState.textContent = rotateText();
  body.append(rotRow, rotState);

  // ---------- scale + offset ----------
  const scaleRow = sliderRow('Scale', 0.25, 4, settings.scale, (v) => {
    settings.scale = v;
    scheduleRevoxel();
  }, 0.25, (v) => `×${v}`);
  body.appendChild(scaleRow.el);

  body.appendChild(sectionTitle('Position offset (grid cells)'));
  const offRow = document.createElement('div');
  offRow.style.cssText = 'display:flex;gap:6px';
  (['X', 'Y', 'Z'] as const).forEach((axis, i) => {
    const input = document.createElement('input');
    input.type = 'number';
    input.value = String(settings.offset[i]);
    input.title = `offset ${axis}`;
    input.style.cssText = 'flex:1;width:0;background:#0c0e14;color:#e8e8f0;border:1px solid #3a3f55;border-radius:5px;padding:4px 6px';
    input.addEventListener('change', () => {
      settings.offset[i] = Math.trunc(Number(input.value) || 0);
      saveSettings(settings);
    });
    offRow.appendChild(input);
  });
  body.appendChild(offRow);

  // ---------- color ----------
  body.appendChild(sectionTitle('Block color'));
  const swatchRow = document.createElement('div');
  swatchRow.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap';
  const swatchEls: HTMLButtonElement[] = [];
  for (const sw of COLOR_SWATCHES) {
    const b = document.createElement('button');
    b.title = sw.name;
    b.style.cssText = `width:24px;height:24px;border-radius:5px;cursor:pointer;background:${sw.hex};border:2px solid ${sw.id === settings.color ? '#8ab4ff' : '#3a3f55'}`;
    b.addEventListener('click', () => {
      settings.color = sw.id;
      for (const el of swatchEls) el.style.borderColor = '#3a3f55';
      b.style.borderColor = '#8ab4ff';
      saveSettings(settings);
      preview.setGrid(grid, swatchHex(settings.color));
    });
    swatchEls.push(b);
    swatchRow.appendChild(b);
  }
  body.appendChild(swatchRow);

  // ---------- stats + generate ----------
  const stats = document.createElement('div');
  stats.style.cssText = 'color:#9aa0b8;font-size:12px;min-height:15px';
  body.appendChild(stats);

  const nameInput = document.createElement('input');
  nameInput.placeholder = 'Track name';
  nameInput.style.cssText = 'background:#0c0e14;color:#e8e8f0;border:1px solid #3a3f55;border-radius:5px;padding:6px 8px';
  body.appendChild(nameInput);

  const generateBtn = button('⚡ Generate track', () => void generate());
  generateBtn.style.cssText += ';width:100%;padding:8px;background:#2b3f73;font-weight:600';
  const status = document.createElement('div');
  status.style.cssText = 'font-size:12px;min-height:15px';
  body.append(generateBtn, status);

  document.body.appendChild(root);

  // ---------- behaviour ----------
  function rotateText(): string {
    return `current: ${settings.rotate[0]}° / ${settings.rotate[1]}° / ${settings.rotate[2]}°`;
  }

  async function loadFile(file: File): Promise<void> {
    try {
      const lower = file.name.toLowerCase();
      if (lower.endsWith('.obj')) {
        mesh = parseObj(await file.text());
      } else {
        mesh = parseStl(await file.arrayBuffer());
      }
      meshName = file.name.replace(/\.(stl|obj)$/i, '');
      if (!nameInput.value) nameInput.value = meshName;
      fileLabel.textContent = `${file.name} — ${mesh.triangleCount.toLocaleString()} triangles`;
      revoxel();
    } catch (err) {
      mesh = null;
      grid = null;
      fileLabel.textContent = `⚠ ${err instanceof Error ? err.message : String(err)}`;
      preview.setGrid(null, swatchHex(settings.color));
      stats.textContent = '';
    }
  }

  function scheduleRevoxel(): void {
    saveSettings(settings);
    clearTimeout(revoxTimer);
    revoxTimer = window.setTimeout(revoxel, 150);
  }

  function revoxel(): void {
    if (!mesh) return;
    const transform: MeshTransform = {
      ...IDENTITY,
      rotate: [...settings.rotate],
      scale: [settings.scale, settings.scale, settings.scale],
    };
    grid = voxelize(applyTransform(mesh, transform), {
      resolution: settings.resolution,
      solid: settings.solid,
    });
    preview.setGrid(grid, swatchHex(settings.color));
    const over = grid.filledCount > MAX_PARTS;
    stats.textContent = `${grid.nx}×${grid.ny}×${grid.nz} grid — ${grid.filledCount.toLocaleString()} blocks${over ? ` (over ${MAX_PARTS.toLocaleString()} limit!)` : ''}`;
    stats.style.color = over ? '#ff8a8a' : '#9aa0b8';
    generateBtn.disabled = over;
  }

  async function generate(): Promise<void> {
    if (!grid || grid.filledCount === 0) {
      setStatus('Load a model first.', true);
      return;
    }
    try {
      const name = nameInput.value.trim() || meshName || 'poly-to-track model';
      const parts = buildParts(grid, { color: settings.color, offset: [...settings.offset] });
      const code = toExportString(parts, { name, author: 'poly-to-track' });
      setStatus('Registering…', false);
      const res = await api.tracks.register({ code, name, overwrite: true, persist: true });
      if (res.ok) {
        setStatus(`✓ Saved “${res.name ?? name}” — check your track list`, false);
      } else {
        setStatus(`✗ ${res.reason ?? 'failed'}`, true);
      }
    } catch (err) {
      setStatus(`✗ ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  function setStatus(text: string, isError: boolean): void {
    status.textContent = text;
    status.style.color = isError ? '#ff8a8a' : '#8adf9a';
  }

  return {
    toggle() {
      root.style.display = root.style.display === 'none' ? 'block' : 'none';
    },
    dispose() {
      clearTimeout(revoxTimer);
      preview.dispose();
      root.remove();
    },
  };
}

// ---------- small helpers ----------

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.style.cssText = 'background:#232838;color:#e8e8f0;border:1px solid #3a3f55;border-radius:6px;padding:5px 9px;cursor:pointer';
  b.addEventListener('click', onClick);
  return b;
}

function sectionTitle(text: string): HTMLDivElement {
  const d = document.createElement('div');
  d.textContent = text;
  d.style.cssText = 'font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#9aa0b8;margin-top:2px';
  return d;
}

function sliderRow(
  label: string, min: number, max: number, value: number,
  onChange: (v: number) => void, step = 1, fmt: (v: number) => string = String,
): { el: HTMLDivElement } {
  const el = document.createElement('div');
  const top = document.createElement('div');
  top.style.cssText = 'display:flex;justify-content:space-between';
  const readout = document.createElement('span');
  readout.textContent = fmt(value);
  readout.style.color = '#9aa0b8';
  top.append(document.createTextNode(label), readout);
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(value);
  slider.style.width = '100%';
  slider.addEventListener('input', () => {
    const v = Number(slider.value);
    readout.textContent = fmt(v);
    onChange(v);
  });
  el.append(top, slider);
  return { el };
}

function makeDraggable(root: HTMLElement, handle: HTMLElement): void {
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  handle.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    const r = root.getBoundingClientRect();
    ox = r.left; oy = r.top;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    root.style.left = `${ox + e.clientX - sx}px`;
    root.style.top = `${oy + e.clientY - sy}px`;
    root.style.right = 'auto';
  });
  handle.addEventListener('pointerup', () => { dragging = false; });
}

function swatchHex(colorId: number): string {
  return COLOR_SWATCHES.find((s) => s.id === colorId)?.hex ?? '#b8b8b8';
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) as Partial<Settings> };
  } catch { /* corrupted settings fall back to defaults */ }
  return { ...DEFAULTS, rotate: [...DEFAULTS.rotate], offset: [...DEFAULTS.offset] };
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch { /* storage full/blocked — settings just won't persist */ }
}
