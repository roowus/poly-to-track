/**
 * Undo/redo bridge — makes an applied insert respond to the editor's own
 * undo/redo buttons and Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y.
 *
 * The editor's real undo stack lives in an untransformed lazy chunk that
 * mixins can't reach (TSPML#87), so applied batches are invisible to it. The
 * bridge keeps its OWN stack of applied batches and intercepts the user's
 * undo gesture in the capture phase while one of our batches is the newest
 * change to the track: it reverts/re-applies the batch itself and stops the
 * event so the editor's stack never sees it. The moment the user edits the
 * track by hand (detected by wrapping the captured track's setPart /
 * deleteSpecificPart), our batches are no longer top-of-history — the bridge
 * goes dormant and native undo behaves exactly as before. That trades depth
 * for correctness: we never mis-order history, and the common case (apply →
 * "oops" → Ctrl+Z) just works.
 */
import type { PlacedPart } from '../codec/parts';
import type { GameTrack } from './track';

export interface UndoBridge {
  /** Push an applied batch (FINAL coordinates) as the newest undoable change. */
  recordBatch(parts: readonly PlacedPart[]): void;
  /** Run `fn` (e.g. session.commit()) without its track writes counting as
   *  the user's own edits. */
  runInternal<T>(fn: () => T): T;
  /** Batches currently undoable / redoable (for status UI + tests). */
  readonly undoDepth: number;
  readonly redoDepth: number;
  dispose(): void;
}

type TrackFn = (...args: unknown[]) => unknown;

/** Structural Element view — the bridge runs against the game frame's DOM
 *  classes (a different realm), so duck-typing beats instanceof anyway. */
interface Elementish {
  closest?(sel: string): Elementish | null;
  querySelector?(sel: string): Elementish | null;
  getAttribute?(name: string): string | null;
}

/** Toolbar-button view for the force-enable pass. */
interface Buttonish extends Elementish {
  hasAttribute?(name: string): boolean;
  removeAttribute?(name: string): void;
  setAttribute?(name: string, value: string): void;
  classList?: { contains(c: string): boolean; add(c: string): void; remove(c: string): void };
}

/** The game greys its undo/redo buttons out (`disabled` attribute and/or a
 *  `.disabled` class — the bundle has CSS for both) whenever ITS OWN stack is
 *  empty. A disabled button never emits real clicks, so our batches would be
 *  unreachable from the toolbar exactly when they matter most (apply as the
 *  first edit). While the bridge has history it force-enables the buttons and
 *  hands the state back the moment it doesn't. */
const BUTTON_SYNC_MS = 250;

/** True when `target` is something the user types into (text input, textarea,
 *  contenteditable) — undo/redo hotkeys must edit THAT text, not the track. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const t = target as { tagName?: unknown; type?: unknown; isContentEditable?: unknown } | null;
  if (!t) return false;
  if (t.isContentEditable === true) return true;
  if (typeof t.tagName !== 'string') return false;
  if (t.tagName === 'TEXTAREA') return true;
  if (t.tagName !== 'INPUT') return false;
  const type = typeof t.type === 'string' ? t.type : 'text';
  return type !== 'range' && type !== 'checkbox' && type !== 'button' && type !== 'file' && type !== 'color';
}

/** The editor toolbar's undo/redo buttons carry webpack-emitted icon URLs
 *  ending in images/undo.svg / images/redo.svg — the one stable marker. */
export function gestureFor(target: EventTarget | null): 'undo' | 'redo' | null {
  const el = (target as Elementish | null)?.closest?.('button') ?? null;
  const src = el?.querySelector?.('img')?.getAttribute?.('src') ?? '';
  if (/undo\.svg/.test(src)) return 'undo';
  if (/redo\.svg/.test(src)) return 'redo';
  return null;
}

/** Find the editor toolbar's undo/redo buttons in `doc` and force-enable the
 *  ones whose bridge stack has something to do. One-way: we never re-disable
 *  (a hand edit both clears our stacks AND gives the game a reason to enable
 *  its own button — re-disabling would fight it; the game re-asserts the
 *  state itself on its next edit). Exported for tests. */
export function syncToolbarButtons(
  doc: { querySelectorAll?(sel: string): ArrayLike<Buttonish> } | null | undefined,
  undoDepth: number,
  redoDepth: number,
): void {
  const buttons = doc?.querySelectorAll?.('button');
  if (!buttons) return;
  for (let i = 0; i < buttons.length; i++) {
    const b = buttons[i]!;
    const src = b.querySelector?.('img')?.getAttribute?.('src') ?? '';
    const wants = /undo\.svg/.test(src) ? undoDepth > 0 : /redo\.svg/.test(src) ? redoDepth > 0 : false;
    if (!wants) continue;
    if (b.hasAttribute?.('disabled')) b.removeAttribute?.('disabled');
    if ((b as { disabled?: boolean }).disabled) (b as { disabled?: boolean }).disabled = false;
    if (b.classList?.contains('disabled')) b.classList.remove('disabled');
  }
}

export function createUndoBridge(track: GameTrack, gameWindow: Window): UndoBridge {
  const undoStack: (readonly PlacedPart[])[] = [];
  const redoStack: (readonly PlacedPart[])[] = [];
  let internal = false;
  let disposed = false;

  // The game re-renders/re-disables its toolbar on its own schedule — keep
  // (re-)enabling until our history empties. setInterval off the GAME window
  // so a torn-down frame stops the timer with it.
  const syncButtons = (): void => {
    if (disposed || (undoStack.length === 0 && redoStack.length === 0)) return;
    try {
      syncToolbarButtons((gameWindow as { document?: Document }).document, undoStack.length, redoStack.length);
    } catch { /* frame gone */ }
  };
  let buttonTimer = 0;
  try { buttonTimer = (gameWindow.setInterval as typeof setInterval)(syncButtons, BUTTON_SYNC_MS) as unknown as number; } catch { /* no timers on fake windows */ }

  // ---- foreign-edit detection: shadow the instance methods ----
  const trackRec = track as unknown as Record<string, TrackFn>;
  const origSetPart = trackRec['setPart']!;
  const origDelete = trackRec['deleteSpecificPart']!;
  const onForeignEdit = (): void => {
    // A hand edit sits on top of our batches in real history — undoing ours
    // first would reorder time. Go dormant until the next apply.
    undoStack.length = 0;
    redoStack.length = 0;
  };
  trackRec['setPart'] = function (this: unknown, ...args: unknown[]) {
    if (!internal) onForeignEdit();
    return origSetPart.apply(this, args);
  };
  trackRec['deleteSpecificPart'] = function (this: unknown, ...args: unknown[]) {
    if (!internal) onForeignEdit();
    return origDelete.apply(this, args);
  };

  function runInternal<T>(fn: () => T): T {
    const prev = internal;
    internal = true;
    try { return fn(); } finally { internal = prev; }
  }

  function revertBatch(parts: readonly PlacedPart[]): void {
    runInternal(() => {
      for (const p of parts) {
        try { track.deleteSpecificPart(p.partId, p.x, p.y, p.z, p.rotation, p.rotationAxis); } catch { /* already gone */ }
      }
      track.refreshMeshes();
    });
  }

  function reapplyBatch(parts: readonly PlacedPart[]): boolean {
    return runInternal(() => {
      const done: PlacedPart[] = [];
      try {
        for (const p of parts) {
          track.setPart(p.x, p.y, p.z, p.partId, p.rotation, p.rotationAxis, p.color, null, null);
          done.push(p);
        }
      } catch {
        for (const p of done) {
          try { track.deleteSpecificPart(p.partId, p.x, p.y, p.z, p.rotation, p.rotationAxis); } catch { /* best effort */ }
        }
        track.refreshMeshes();
        return false;
      }
      track.refreshMeshes();
      return true;
    });
  }

  /** Handle a gesture if it's ours to handle. Returns true when consumed. */
  function handle(gesture: 'undo' | 'redo'): boolean {
    if (gesture === 'undo') {
      const batch = undoStack.pop();
      if (!batch) return false;
      revertBatch(batch);
      redoStack.push(batch);
      return true;
    }
    const batch = redoStack.pop();
    if (!batch) return false;
    if (reapplyBatch(batch)) undoStack.push(batch);
    return true;
  }

  const swallow = (e: Event): void => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  // The game acts on click, but stop the whole pointer sequence so nothing
  // else (hover/active handlers) reacts to a press we consumed.
  const onPointer = (e: PointerEvent | MouseEvent): void => {
    if (disposed) return;
    const g = gestureFor(e.target);
    if (!g) return;
    const willHandle = g === 'undo' ? undoStack.length > 0 : redoStack.length > 0;
    if (!willHandle) return;
    swallow(e);
    if (e.type === 'click') { handle(g); syncButtons(); }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (disposed || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (isTypingTarget(e.target)) return; // Ctrl+Z in a text field edits text
    const k = e.key.toLowerCase();
    const g: 'undo' | 'redo' | null =
      k === 'z' ? (e.shiftKey ? 'redo' : 'undo') : k === 'y' && !e.shiftKey ? 'redo' : null;
    if (!g) return;
    const willHandle = g === 'undo' ? undoStack.length > 0 : redoStack.length > 0;
    if (!willHandle) return;
    swallow(e);
    handle(g);
    syncButtons();
  };

  gameWindow.addEventListener('pointerdown', onPointer, true);
  gameWindow.addEventListener('pointerup', onPointer, true);
  gameWindow.addEventListener('click', onPointer, true);
  gameWindow.addEventListener('keydown', onKeyDown, true);

  return {
    recordBatch(parts) {
      if (disposed || parts.length === 0) return;
      undoStack.push([...parts]);
      redoStack.length = 0; // a new apply is a new change — redo history dies
      syncButtons(); // make the toolbar undo button clickable right away
    },
    runInternal,
    get undoDepth() { return undoStack.length; },
    get redoDepth() { return redoStack.length; },
    dispose() {
      if (disposed) return;
      disposed = true;
      undoStack.length = 0;
      redoStack.length = 0;
      try { gameWindow.clearInterval(buttonTimer); } catch { /* frame gone */ }
      // Restore the original track methods (the instance outlives the editor).
      try {
        trackRec['setPart'] = origSetPart;
        trackRec['deleteSpecificPart'] = origDelete;
      } catch { /* frame gone */ }
      try {
        gameWindow.removeEventListener('pointerdown', onPointer, true);
        gameWindow.removeEventListener('pointerup', onPointer, true);
        gameWindow.removeEventListener('click', onPointer, true);
        gameWindow.removeEventListener('keydown', onKeyDown, true);
      } catch { /* frame gone */ }
    },
  };
}
