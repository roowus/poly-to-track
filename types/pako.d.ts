/**
 * Minimal local typings for pako 2.x — its published package ships no .d.ts
 * (the @types/pako stub wrongly claims it does). Only the surface this repo
 * uses: raw/zlib deflate + inflate with the options we pass.
 */
declare module 'pako' {
  export interface DeflateOptions {
    level?: number;
    windowBits?: number;
    memLevel?: number;
    raw?: boolean;
  }
  export interface InflateOptions {
    windowBits?: number;
    raw?: boolean;
    to?: 'string';
  }
  export function deflate(data: Uint8Array | string, options?: DeflateOptions): Uint8Array;
  export function inflate(data: Uint8Array, options: InflateOptions & { to: 'string' }): string;
  export function inflate(data: Uint8Array, options?: InflateOptions): Uint8Array;
  const pako: {
    deflate: typeof deflate;
    inflate: typeof inflate;
  };
  export default pako;
}
