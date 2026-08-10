/**
 * PolyTrack's custom base-62 bitstream codec (not standard base64/62).
 *
 * Mirrors the game's implementation (0.6.2 bundle, webpack chunk 7754):
 * the byte stream is read LSB-first; each symbol normally carries 6 bits,
 * but when the next 6 bits have `(v & 30) === 30` (i.e. the value would be
 * 30, 31, 62 or 63 — outside or at the edge of one 62-char alphabet run),
 * only 5 bits are consumed and the symbol is `v & 31` (30 or 31).
 * The alphabet is A–Z a–z 0–9.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const REVERSE: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

const FIVE_BIT_MASK = 30;

/** Read up to 6 bits at bit offset `t` (LSB-first), as the game does. */
function readBits(bytes: Uint8Array, t: number): number {
  const n = Math.floor(t / 8);
  const i = bytes[n]!;
  const r = t - n * 8;
  if (r <= 2 || n >= bytes.length - 1) {
    return (i & (63 << r)) >>> r;
  }
  return ((i & (63 << r)) >>> r) | ((bytes[n + 1]! & (63 >>> (8 - r))) << (8 - r));
}

export function b62Encode(bytes: Uint8Array): string {
  let t = 0;
  let out = '';
  const totalBits = bytes.length * 8;
  while (t < totalBits) {
    const r = readBits(bytes, t);
    let symbol: number;
    if ((r & FIVE_BIT_MASK) === FIVE_BIT_MASK) {
      symbol = r & 31;
      t += 5;
    } else {
      symbol = r;
      t += 6;
    }
    out += ALPHABET[symbol];
  }
  return out;
}

/** Write `width` bits of `value` at bit offset `t` into `out` (LSB-first). */
function writeBits(out: number[], t: number, width: number, value: number, isLast: boolean): void {
  const byteIndex = Math.floor(t / 8);
  while (byteIndex >= out.length) out.push(0);
  const shift = t - byteIndex * 8;
  out[byteIndex]! |= (value << shift) & 255;
  if (shift > 8 - width && !isLast) {
    const next = byteIndex + 1;
    if (next >= out.length) out.push(0);
    out[next]! |= value >> (8 - shift);
  }
}

export function b62Decode(text: string): Uint8Array | null {
  let t = 0;
  const out: number[] = [];
  const len = text.length;
  for (let i = 0; i < len; i++) {
    const code = text.charCodeAt(i);
    if (code >= REVERSE.length) return null;
    const value = REVERSE[code]!;
    if (value === -1) return null;
    if ((value & FIVE_BIT_MASK) === FIVE_BIT_MASK) {
      writeBits(out, t, 5, value, i === len - 1);
      t += 5;
    } else {
      writeBits(out, t, 6, value, i === len - 1);
      t += 6;
    }
  }
  return new Uint8Array(out);
}
