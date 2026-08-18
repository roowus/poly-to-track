/**
 * Texture sampling shared by the glTF and OBJ/MTL parsers. Image DECODING
 * is the panel's job (createImageBitmap + canvas — browser-only); parsers
 * stay pure and take pre-decoded RGBA pixels, so they remain unit-testable
 * in node with synthetic images.
 *
 * One block can't show a texture — each triangle gets the texel at its UV
 * centroid (nearest-neighbor, repeat wrap), which is exactly the color that
 * dominates that triangle's area on screen.
 */

/** Decoded RGBA pixels, 4 bytes per pixel, row-major from the top-left. */
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray | Uint8Array;
}

/** Nearest-neighbor sample with repeat wrapping. Returns sRGB bytes. */
export function sampleImage(img: DecodedImage, u: number, v: number): [number, number, number] {
  const uu = u - Math.floor(u);
  const vv = v - Math.floor(v);
  const x = Math.min(img.width - 1, Math.floor(uu * img.width));
  const y = Math.min(img.height - 1, Math.floor(vv * img.height));
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
}

/** sRGB byte → linear 0–1 (for spec-correct glTF factor × texture products). */
export function srgbToLinear(byte: number): number {
  const s = byte / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** Linear 0–1 → sRGB byte (glTF colors are linear; the palette wants display RGB). */
export function linearToSrgbByte(linear: number): number {
  const l = Math.max(0, Math.min(1, linear));
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(s * 255)));
}
