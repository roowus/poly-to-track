# poly-to-track

A [TSPML](https://github.com/roowus/TSPML) mod that imports 3D models
(**STL** / **OBJ**) into [PolyTrack](https://www.kodub.com/apps/polytrack) as
LEGO-style block builds — think **Schematica / Axiom for PolyTrack**.

Load a model, watch the live voxel preview, rotate / scale / offset it, pick
one of the game's block colors, and hit *Generate*: the mod voxelizes the
mesh, emits one Block per voxel plus a Start/Finish pad, encodes a genuine
`PolyTrack2…` track code with the game's own format, and saves it into your
track list through TSPML's `api.tracks` registry — indistinguishable from a
hand-imported track.

## Installing

1. Open the TSPML portal at [tspml.vercel.app](https://tspml.vercel.app).
2. **URL import** (easiest): paste this mod.json URL into *Add a mod → URL*:

   ```
   https://raw.githubusercontent.com/roowus/poly-to-track/main/mod.json
   ```

   (The manifest's entrypoint resolves to the committed `dist/entrypoint.js`.)
3. Or **paste manually**: copy `mod.json` and `dist/entrypoint.js` into the
   *Add a mod* dialog.
4. Launch the game and press **P** to open the importer panel
   (rebindable in TSPML's keybind settings).

## Using it

| Control | What it does |
| --- | --- |
| **Load STL / OBJ** | Parses the file (binary + ASCII STL; OBJ with quads/negative indices) |
| Preview canvas | Drag to orbit the voxelized model |
| **Resolution** (4–128) | Longest model axis maps to this many blocks |
| **Fill interior** | Solid flood-fill vs. hollow shell (fewer parts) |
| **Rotate X/Y/Z** | 90° steps, applied to the mesh before voxelization |
| **Scale** | ×0.25 – ×4 relative to the chosen resolution |
| **Position offset** | Shifts the whole build in grid cells |
| **Block color** | Default + the game's 9 custom block colors |
| **Generate track** | Encodes + registers the track (overwrites same name) |

The block counter warns before you exceed the 100,000-part budget — lower the
resolution or uncheck *Fill interior* if you hit it.

## How it works

```
STL/OBJ → TriangleMesh → transform (rotate/scale) → voxelize
  (SAT triangle-box surface pass + 6-connected exterior flood fill)
→ one Block (id 29) per voxel, 4-tile x/z stride + Start/Finish pad
→ PolyTrack2 encoder (double deflate + the game's base-62 bitstream)
→ api.tracks.register → your track list
```

The `PolyTrack2` codec in `src/codec/` is a byte-exact mirror of the game's
own encoder (verified round-trip against a real community track in the
tests), including the nonstandard base-62 bitstream and the part sort order
the game uses for track identity.

## Development

```bash
pnpm install
pnpm test        # vitest — codec round-trips, parsers, voxelizer
pnpm typecheck
pnpm build       # esbuild → dist/entrypoint.js (committed for URL import)
```

Repo layout:

- `src/codec/` — PolyTrack2 encode/decode + base-62 bitstream + part/color tables
- `src/mesh/` — STL/OBJ parsers, transforms
- `src/voxel/` — voxelizer (surface + solid fill), voxels → parts
- `src/ui/` — the Schematica-style panel + canvas voxel preview
- `src/entrypoint.ts` — TSPML mod factory (default export)
- `tests/` — vitest suites incl. a real community-track fixture
- `docs/DESIGN.md` — format notes + architecture

## Compatibility

Targets PolyTrack `>=0.6.0 <0.7.0` via TSPML. Capabilities: `dom`, `storage`
(panel UI + persisted settings). `vanillaSafe: true` — it only *adds* tracks;
no game code is patched.
