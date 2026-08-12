import { describe, expect, it } from 'vitest';
import { AXIS, PART, type PlacedPart } from '../src/codec/parts';
import type { GameTrack } from '../src/game/track';
import { createUndoBridge, gestureFor, isTypingTarget, syncToolbarButtons } from '../src/game/undo';

function part(x: number, y: number, z: number, partId: number = PART.Block, rotation = 0): PlacedPart {
  return { x, y, z, partId, rotation, rotationAxis: AXIS.YPositive, color: 0 };
}

function fakeTrack(): GameTrack & { parts: Map<string, PlacedPart> } {
  const parts = new Map<string, PlacedPart>();
  const key = (p: { x: number; y: number; z: number; partId: number; rotation: number }) =>
    `${p.partId}|${p.x}|${p.y}|${p.z}|${p.rotation}`;
  return {
    parts,
    setPart(x, y, z, partId, rotation, rotationAxis, color) {
      if (y < 0) throw new Error('Track part below ground');
      const p = part(x, y, z, partId, rotation);
      parts.set(key(p), { ...p, rotationAxis, color });
    },
    deleteSpecificPart(partId, x, y, z, rotation) {
      const k = key({ x, y, z, partId, rotation });
      const found = parts.get(k) ?? null;
      parts.delete(k);
      return found;
    },
    refreshMeshes() { /* meshes are the game's business */ },
  };
}

/** Node has EventTarget/Event but no DOM — a plain EventTarget plus
 *  loose keyboard fields is exactly what the bridge duck-types against. */
function fakeWindow(): Window & EventTarget {
  return new EventTarget() as unknown as Window & EventTarget;
}

function press(w: Window, key: string, opts: { shift?: boolean } = {}): boolean {
  const e = new Event('keydown', { cancelable: true }) as Event & Record<string, unknown>;
  e['key'] = key;
  e['ctrlKey'] = true;
  e['metaKey'] = false;
  e['altKey'] = false;
  e['shiftKey'] = opts.shift ?? false;
  (w as unknown as EventTarget).dispatchEvent(e);
  return e.defaultPrevented;
}

const pressUndo = (w: Window) => press(w, 'z');
const pressRedo = (w: Window) => press(w, 'z', { shift: true });

/** An EventTarget that ALSO duck-types as a toolbar button whose icon is
 *  `images/<icon>.svg` — dispatching click on it exercises the DOM path. */
function fakeButton(icon: string): Window & EventTarget {
  const btn = new EventTarget() as unknown as Window & EventTarget & Record<string, unknown>;
  btn['closest'] = () => btn;
  btn['querySelector'] = () => ({ getAttribute: () => `/static/images/${icon}.svg` });
  return btn;
}

describe('gestureFor', () => {
  it('recognizes the undo/redo toolbar buttons by their icon URL', () => {
    expect(gestureFor(fakeButton('undo') as unknown as EventTarget)).toBe('undo');
    expect(gestureFor(fakeButton('redo') as unknown as EventTarget)).toBe('redo');
    expect(gestureFor(fakeButton('copy') as unknown as EventTarget)).toBeNull();
    expect(gestureFor(null)).toBeNull();
    expect(gestureFor(new EventTarget())).toBeNull();
  });
});

/** A duck-typed toolbar button carrying the game's disabled state (attribute
 *  + property + class — the bundle uses all three shapes somewhere). */
function fakeToolbarButton(icon: string, disabled: boolean) {
  const classes = new Set<string>(disabled ? ['disabled'] : []);
  const attrs = new Map<string, string>(disabled ? [['disabled', '']] : []);
  return {
    disabled,
    hasAttribute: (n: string) => attrs.has(n),
    removeAttribute: (n: string) => { attrs.delete(n); },
    setAttribute: (n: string, v: string) => { attrs.set(n, v); },
    querySelector: () => ({ getAttribute: () => `/static/images/${icon}.svg` }),
    classList: {
      contains: (c: string) => classes.has(c),
      add: (c: string) => { classes.add(c); },
      remove: (c: string) => { classes.delete(c); },
    },
    isDisabled() { return this.disabled || attrs.has('disabled') || classes.has('disabled'); },
  };
}

describe('syncToolbarButtons', () => {
  it('force-enables the undo button while there is undo history', () => {
    const undoBtn = fakeToolbarButton('undo', true);
    const redoBtn = fakeToolbarButton('redo', true);
    const copyBtn = fakeToolbarButton('copy', true);
    const doc = { querySelectorAll: () => [undoBtn, redoBtn, copyBtn] };
    syncToolbarButtons(doc, 1, 0);
    expect(undoBtn.isDisabled()).toBe(false);
    expect(redoBtn.isDisabled()).toBe(true); // no redo history — untouched
    expect(copyBtn.isDisabled()).toBe(true); // not ours — untouched
  });

  it('force-enables the redo button while there is redo history', () => {
    const undoBtn = fakeToolbarButton('undo', true);
    const redoBtn = fakeToolbarButton('redo', true);
    const doc = { querySelectorAll: () => [undoBtn, redoBtn] };
    syncToolbarButtons(doc, 0, 1);
    expect(undoBtn.isDisabled()).toBe(true);
    expect(redoBtn.isDisabled()).toBe(false);
  });

  it('never re-disables (the game owns the enabled state for its own edits)', () => {
    const undoBtn = fakeToolbarButton('undo', false);
    const doc = { querySelectorAll: () => [undoBtn] };
    syncToolbarButtons(doc, 0, 0);
    expect(undoBtn.isDisabled()).toBe(false);
  });

  it('survives a missing/odd document', () => {
    expect(() => syncToolbarButtons(null, 1, 1)).not.toThrow();
    expect(() => syncToolbarButtons({}, 1, 1)).not.toThrow();
  });
});

describe('isTypingTarget', () => {
  it('recognizes text-entry elements', () => {
    expect(isTypingTarget({ tagName: 'INPUT', type: 'text' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true); // default type=text
    expect(isTypingTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ isContentEditable: true } as unknown as EventTarget)).toBe(true);
  });

  it('lets non-text targets through', () => {
    expect(isTypingTarget({ tagName: 'INPUT', type: 'range' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'checkbox' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(new EventTarget())).toBe(false);
  });
});

describe('createUndoBridge', () => {
  it('Ctrl+Z reverts a recorded batch; Ctrl+Shift+Z / Ctrl+Y re-applies it', () => {
    const track = fakeTrack();
    const w = fakeWindow();
    const bridge = createUndoBridge(track, w);
    const batch = [part(0, 1, 0), part(4, 1, 0)];
    bridge.runInternal(() => {
      for (const p of batch) track.setPart(p.x, p.y, p.z, p.partId, p.rotation, p.rotationAxis, p.color, null, null);
    });
    bridge.recordBatch(batch);
    expect(track.parts.size).toBe(2);
    expect(bridge.undoDepth).toBe(1);

    expect(pressUndo(w)).toBe(true); // consumed
    expect(track.parts.size).toBe(0);
    expect(bridge.undoDepth).toBe(0);
    expect(bridge.redoDepth).toBe(1);

    expect(pressRedo(w)).toBe(true);
    expect(track.parts.size).toBe(2);

    expect(pressUndo(w)).toBe(true);
    expect(press(w, 'y')).toBe(true); // Ctrl+Y redo
    expect(track.parts.size).toBe(2);
    bridge.dispose();
  });

  it('passes the gesture through to the game when it has nothing to undo', () => {
    const track = fakeTrack();
    const w = fakeWindow();
    const bridge = createUndoBridge(track, w);
    expect(pressUndo(w)).toBe(false); // NOT consumed — native undo runs
    bridge.dispose();
  });

  it('a hand edit invalidates the history (our batch is no longer newest)', () => {
    const track = fakeTrack();
    const w = fakeWindow();
    const bridge = createUndoBridge(track, w);
    bridge.runInternal(() => {
      track.setPart(0, 1, 0, PART.Block, 0, AXIS.YPositive, 0, null, null);
    });
    bridge.recordBatch([part(0, 1, 0)]);
    // The user places a part by hand — a plain setPart, not runInternal.
    track.setPart(20, 1, 0, PART.Block, 0, AXIS.YPositive, 0, null, null);
    expect(bridge.undoDepth).toBe(0);
    expect(pressUndo(w)).toBe(false); // native undo handles the hand edit
    expect(track.parts.size).toBe(2); // nothing of ours was reverted
    bridge.dispose();
  });

  it('a hand DELETE invalidates the history too', () => {
    const track = fakeTrack();
    const w = fakeWindow();
    const bridge = createUndoBridge(track, w);
    bridge.runInternal(() => {
      track.setPart(0, 1, 0, PART.Block, 0, AXIS.YPositive, 0, null, null);
    });
    bridge.recordBatch([part(0, 1, 0)]);
    track.deleteSpecificPart(PART.Block, 0, 1, 0, 0, AXIS.YPositive);
    expect(bridge.undoDepth).toBe(0);
    bridge.dispose();
  });

  it('a new apply clears redo history', () => {
    const track = fakeTrack();
    const w = fakeWindow();
    const bridge = createUndoBridge(track, w);
    bridge.recordBatch([part(0, 1, 0)]);
    pressUndo(w);
    expect(bridge.redoDepth).toBe(1);
    bridge.recordBatch([part(8, 1, 0)]);
    expect(bridge.redoDepth).toBe(0);
    expect(bridge.undoDepth).toBe(1);
    bridge.dispose();
  });

  it('stacks multiple applies and undoes them newest-first', () => {
    const track = fakeTrack();
    const w = fakeWindow();
    const bridge = createUndoBridge(track, w);
    const a = [part(0, 1, 0)];
    const b = [part(8, 1, 0)];
    bridge.runInternal(() => {
      for (const p of [...a, ...b]) track.setPart(p.x, p.y, p.z, p.partId, p.rotation, p.rotationAxis, p.color, null, null);
    });
    bridge.recordBatch(a);
    bridge.recordBatch(b);
    pressUndo(w);
    expect(track.parts.size).toBe(1);
    expect([...track.parts.values()][0]!.x).toBe(0); // b (newest) went first
    pressUndo(w);
    expect(track.parts.size).toBe(0);
    bridge.dispose();
  });

  it('undo/redo via the editor toolbar buttons (undo.svg / redo.svg icons)', () => {
    const track = fakeTrack();
    // Click events bubble to the window in the game; here the "button" IS the
    // event target the bridge listens on.
    const w = fakeButton('undo');
    const bridge = createUndoBridge(track, w);
    bridge.runInternal(() => {
      track.setPart(0, 1, 0, PART.Block, 0, AXIS.YPositive, 0, null, null);
    });
    bridge.recordBatch([part(0, 1, 0)]);

    const click = new Event('click', { cancelable: true });
    (w as unknown as EventTarget).dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true); // consumed — the game never sees it
    expect(track.parts.size).toBe(0);
    expect(bridge.redoDepth).toBe(1);
    bridge.dispose();
  });

  it('leaves other buttons alone even with history stacked', () => {
    const track = fakeTrack();
    const w = fakeButton('copy');
    const bridge = createUndoBridge(track, w);
    bridge.recordBatch([part(0, 1, 0)]);
    const click = new Event('click', { cancelable: true });
    (w as unknown as EventTarget).dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(bridge.undoDepth).toBe(1);
    bridge.dispose();
  });

  it('recordBatch immediately force-enables a disabled toolbar undo button', () => {
    const track = fakeTrack();
    const undoBtn = fakeToolbarButton('undo', true);
    const w = fakeWindow() as Window & { document?: unknown };
    w.document = { querySelectorAll: () => [undoBtn] } as unknown as Document;
    const bridge = createUndoBridge(track, w);
    expect(undoBtn.isDisabled()).toBe(true); // nothing recorded yet — untouched
    bridge.recordBatch([part(0, 1, 0)]);
    expect(undoBtn.isDisabled()).toBe(false); // clickable the moment we have history
    bridge.dispose();
  });

  it('undo hands the redo button over: redo enabled after a consumed undo', () => {
    const track = fakeTrack();
    const undoBtn = fakeToolbarButton('undo', true);
    const redoBtn = fakeToolbarButton('redo', true);
    const w = fakeWindow() as Window & { document?: unknown };
    w.document = { querySelectorAll: () => [undoBtn, redoBtn] } as unknown as Document;
    const bridge = createUndoBridge(track, w);
    bridge.runInternal(() => {
      track.setPart(0, 1, 0, PART.Block, 0, AXIS.YPositive, 0, null, null);
    });
    bridge.recordBatch([part(0, 1, 0)]);
    pressUndo(w);
    expect(redoBtn.isDisabled()).toBe(false);
    bridge.dispose();
  });

  it('ignores Ctrl+Z typed into a text field (typing must not undo the track)', () => {
    const track = fakeTrack();
    // The event target duck-types as a focused text input.
    const w = fakeWindow() as Window & EventTarget & Record<string, unknown>;
    w['tagName'] = 'INPUT';
    w['type'] = 'text';
    const bridge = createUndoBridge(track, w);
    bridge.runInternal(() => {
      track.setPart(0, 1, 0, PART.Block, 0, AXIS.YPositive, 0, null, null);
    });
    bridge.recordBatch([part(0, 1, 0)]);
    expect(pressUndo(w)).toBe(false); // NOT consumed — the field keeps its Ctrl+Z
    expect(track.parts.size).toBe(1); // nothing reverted
    bridge.dispose();
  });

  it('dispose restores the track methods and stops listening', () => {
    const track = fakeTrack();
    const w = fakeWindow();
    const origSetPart = track.setPart;
    const bridge = createUndoBridge(track, w);
    expect(track.setPart).not.toBe(origSetPart); // shadowed
    bridge.recordBatch([part(0, 1, 0)]);
    bridge.dispose();
    expect(track.setPart).toBe(origSetPart); // restored
    expect(pressUndo(w)).toBe(false);
  });
});
