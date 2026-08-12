/** Parsing/clamping for the sliders' click-to-type readouts — pure so the
 *  node-env tests can cover it without a DOM. */

/** Parse a typed value ("37", "45°", "×1.5", "2,5") into a number the slider
 *  accepts: clamped to [min, max] and rounded to 2 decimals. Deliberately NOT
 *  snapped to the drag step — typing exists to escape the snap (22.5°, ×1.55);
 *  2 decimals matches the pose's own clampScale precision. Returns null when
 *  there's no number in the text. */
export function parseTypedValue(text: string, min: number, max: number): number | null {
  const m = text.replace(',', '.').match(/-?\d*\.?\d+/);
  if (!m) return null;
  const v = Math.min(max, Math.max(min, Number(m[0])));
  return Math.round(v * 100) / 100;
}
