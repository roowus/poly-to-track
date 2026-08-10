/**
 * Minimal structural types for the TSPML bridge API — just the surface this
 * mod touches (tracks, keybinds, logger). Kept local so the mod builds
 * without a workspace dependency on the loader repo; shapes mirror
 * tspml-docs "The api object" + source/api-bridge.
 */

export interface TrackRegisterResult {
  readonly ok: boolean;
  readonly name?: string;
  readonly trackId?: string;
  readonly reason?: 'invalid-code' | 'name-exists' | 'save-failed' | 'not-ready';
}

export interface TspmlApi {
  readonly tracks: {
    register(opts: {
      code: string;
      name?: string;
      author?: string;
      overwrite?: boolean;
      persist?: boolean;
    }): Promise<TrackRegisterResult>;
  };
  readonly keybinds: {
    register(opts: {
      id: string;
      key: string;
      description: string;
      onDown?: () => void;
      onUp?: () => void;
    }): () => void;
  };
  readonly logger: {
    log(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
}
