# poly-to-track — design

Import a 3D model file (STL/OBJ), voxelize it, and build it inside a PolyTrack
map out of the game's own parts — like building the model out of LEGO. The UX
model is **Schematica / Axiom for Minecraft**: load a schematic (here: a 3D
file), see a ghost preview, move/rotate/scale it, then materialize it into the
world (here: a generated track saved into the player's track list).

Runs as a [TSPML](https://github.com/roowus/TSPML) mod in the portal.

## How it fits TSPML

TSPML mods are an ES module entrypoint + `mod.json`, pasted or URL-imported in
the portal sidebar. The mod receives a typed `api` object. Everything this mod
needs is already Tier-1:

- **`api.tracks.register({ code })`** — takes a `PolyTrack2…` export code,
  parses it with the *game's* codec, saves it through the *game's* track store.
  The track list UI refreshes itself. This is our only game-facing surface —
  no mixins needed.
- **`api.keybinds.register`** — toggle the panel (default `KeyM`).
- **DOM access** — mods run same-realm; the panel is a plain DOM overlay
  (declared via `capabilities: ["dom"]`).

So the mod's real job is pure computation: **3D file → voxels → part list →
PolyTrack2 code**, plus UI.

## The PolyTrack2 export code (reverse-engineered from 0.6.2)

Verified against the game's own codec chunks (webcrack'd bundle, chunks
`6582.js` (parse), `9117.js` (TrackData + serialize), `7754.js` (base62)):

```
"PolyTrack2" + B62( deflate_raw15( B62( deflate(win9)( header ++ body ) ) ) )
```

- **B62** is a custom 62-char bitstream (A–Z a–z 0–9): symbols are 6 bits,
  except values where `(v & 30) == 30` which are 5-bit symbols (values 30/31),
  written LSB-first into a byte stream.
- Double deflate: inner `pako.Deflate({level:9, windowBits:9, memLevel:9})`,
  the b62 of that (a *string*) is deflated again with `windowBits:15`.
- **header**: `nameLen u8, nameUtf8, authorLen u8, authorUtf8, dateFlag u8
  (0 or 1), [epochSecs u32le]`
- **body**: `envId u8 (0 Summer/1 Winter/2 Desert), sunRotation u8 (0..179,
  degrees/2), minX i32le, minY i32le, minZ i32le, packByte u8
  (bx | by<<2 | bz<<4, each 1..4 bytes per coordinate)` then per part id
  (ascending): `partId u8, count u32le`, then per placed part:
  `x,y,z (bx/by/bz bytes, little-endian, offset by min)`,
  `rot|axis byte (rotation 0-3 | rotationAxis 0-5 << 2)`, `color u8`,
  `+u16 checkpointOrder` for ids {52,65,75,77}, `+u32 startOrder` for ids
  {5,91,92,93}.
- Parts within an id are sorted by (x,y,z,rotation,axis,color,…) — the game's
  `addPart` maintains sorted order; we match it so `getId()` hashes agree.

## Grid + parts we use

- Grid unit = 1 part cell; `partSize = 5` world units. A `Block` (id 29) is a
  full 1×1×1 cell cube. `HalfBlock` (53) and `QuarterBlock` (54) are thinner
  slabs. `Plane` (25) is a paper-thin floor.
- Voxel building uses **`Block` (29)** as the 1:1 LEGO brick. That's the whole
  voxel alphabet for v1 — sloped/corner block variants (68–73, 151–158, 174+)
  are a later "smart smoothing" upgrade, and colors already give visual detail.
- A playable track needs a **Start (5)** + **Finish (6)**; we drop a small
  Plane pad with Start and Finish next to the build so the track loads and you
  can drive around/on the model. Start parts carry `startOrder u32`,
  checkpoints `checkpointOrder u16`.

## Colors

`color u8` per part. Valid values (enum 2498.js): `0 Default, 1 Summer,
2 Winter, 3 Desert, 32..40 Custom0..Custom8`. Custom BlockSurface swatches
(from 2600.js): `#131313 #501b1b #7f4d2b #93862d #2a5e30 #236363 #20244b
#592759 #302318`. v1 ships single-color builds with a swatch picker; v2 can
nearest-match mesh/vertex colors per voxel.

## Pipeline

1. **Parse** — STL (binary + ASCII) and OBJ (v/f, poly faces fan-triangulated)
   → `{ positions: Float32Array }` triangle soup. Both parsers are ~100 lines,
   zero deps.
2. **Transform** — user translate/rotate(XYZ)/scale, applied to the mesh
   before voxelization (Schematica-style gizmo values in the panel).
3. **Voxelize** — target height in blocks (resolution slider) sets cell size.
   Surface pass: triangle/AABB overlap (separating-axis test) marks shell
   voxels. Optional **solid fill**: 6-connected flood fill from the bounding
   shell exterior; anything unreached is interior → filled.
4. **Budget guard** — part count preview + hard warn above ~50k blocks (codes
   get huge and the game chugs).
5. **Encode** — part list → PolyTrack2 code (our codec, pako bundled).
6. **Register** — `api.tracks.register({ code, name, overwrite, persist })`.

## UI (Schematica-style panel)

Toggle with keybind. Panel (right side, draggable):
- file picker (drag-drop or browse) for `.stl` / `.obj`
- live **3D preview** (small canvas, orthographic-ish orbit view, no deps —
  we render voxels as quads on a 2D canvas with painter's sort; good enough
  and keeps the bundle tiny)
- transform controls: position X/Y/Z, rotation X/Y/Z (90° steps free-form
  degrees), scale (uniform + per-axis)
- resolution slider (max dimension in blocks), solid/hollow toggle
- color swatch row (13 valid colors)
- stats: voxel count, code size
- "Build track" → name field → register; success/failure surfaced inline

## Restrictions found in TSPML (issue candidates)

- `api.tracks.register` is the only insertion path — you can't add parts to
  the *currently open editor session*; the flow is "generate → new track in
  list → open it in editor". True Schematica-style in-editor ghost placement
  would need editor-session mappings. Fine for v1; file as enhancement issue.

## Repo layout

```
mod.json            manifest (TSPML schemaVersion 1)
src/
  entrypoint.ts     factory: keybind + panel mount
  codec/            b62.ts, encode.ts, parts.ts (ids/colors/enums)
  mesh/             stl.ts, obj.ts, transform.ts
  voxel/            voxelize.ts (SAT tri-box + flood fill)
  ui/               panel.ts, preview.ts
tests/              vitest; fixture round-trip vs real community track code
dist/entrypoint.js  single-file esbuild bundle (pako inlined) — paste this
```
