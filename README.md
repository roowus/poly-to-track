# poly-to-track

A [TSPML](https://github.com/roowus/TSPML) mod that imports 3D models
(**STL** / **OBJ**) into [PolyTrack](https://www.kodub.com/apps/polytrack) as
LEGO-style block builds — think **Schematica / Axiom for PolyTrack**.

Load a model, watch the live voxel preview, pick a resolution and one of the
game's block colors, then **insert it straight into the open track editor**:
the model appears in the world you're editing, still selected, with
move/rotate controls (buttons or Blender-ish keys) until you hit Apply — like
placing a Schematica ghost. The builds use the game's full shape vocabulary
(blocks, half/quarter blocks, slopes) so curved models aren't staircases of
slabs.

There's also a secondary *Save as track* path that encodes a genuine
`PolyTrack2…` track code and registers it into your track list through
TSPML's `api.tracks` registry — indistinguishable from a hand-imported track.

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

Open the **track editor** first (the insert flow needs an open editor), then
press **P**. The panel lives inside the game's UI and follows its styling.

| Control | What it does |
| --- | --- |
| **Load STL / OBJ** | Parses the file (binary + ASCII STL; OBJ with quads/negative indices) |
| Preview canvas | Drag to orbit the voxelized model |
| **Resolution** (4–128) | Longest model axis maps to this many blocks |
| **Fill interior** | Solid flood-fill vs. hollow shell (fewer parts) |
| **Rotate X/Y/Z** | 90° steps, applied to the mesh before voxelization |
| **Scale** | ×0.25 – ×4 relative to the chosen resolution |
| **Block color** | Default + the game's 9 custom block colors |
| **⤓ Insert into editor** | Places the model into the open editor and enters transform mode |
| **Save as track** | Secondary path: encodes + registers a standalone track |

While a model is inserted (transform mode), a Blender-style orange selection
frame is drawn around it in the game viewport (it reads through terrain, so
you always see where the model sits), and the panel's buttons and these keys
drive it — the resolution/scale sliders keep working live too:

| Key | Action |
| --- | --- |
| ← → / ↑ ↓ | Move one cell in x / z |
| PgUp / PgDn | Raise / lower one unit |
| **R** | Rotate 90° about Y |
| **Enter** | Apply — the parts become a normal part of your track |
| **Delete** | Remove the inserted model |

Applied parts are ordinary track parts: the editor's own tools (and its
undo for *your* subsequent edits) treat them like anything you placed by
hand. The insert itself isn't on the editor's undo stack — use the panel's
Remove before applying if you change your mind.

The block counter warns before you exceed the 100,000-part budget — lower the
resolution or uncheck *Fill interior* if you hit it.

## How it works

```
STL/OBJ → TriangleMesh → transform (rotate/scale) → voxelize
  (SAT triangle-box surface pass + 6-connected exterior flood fill,
   anisotropic grid: 4 y-cells per block so builds aren't flattened)
→ shape fitting: Block / HalfBlock / QuarterBlock / slope per voxel column
→ INSERT: a mixin-captured reference to the open editor's track object
  (setPart/deleteSpecificPart/refreshMeshes) places the parts live, with a
  session tracking them for move/rotate/replace/remove until you Apply
→ or SAVE: PolyTrack2 encoder (double deflate + base-62 bitstream)
  → api.tracks.register → your track list
```

The capture mixin (`mixins.json`) anchors on two error strings that exist
only inside the track class's `setPart` and stamps the instance on a global
the mod reads — the editor calls `setPart` for its initial Start part the
moment it opens, so the reference is always fresh.

A second mixin captures the game's renderer wrapper the same way (anchored
on its unique WebGL-failure string, hooked at `setCamera`, which the editor
calls with its camera on entry). That hands the mod the live three.js scene,
where `src/game/gizmo.ts` draws the selection frame. The game doesn't export
the three.js namespace, so the gizmo *scavenges* constructors off a rendered
mesh in the scene — walking the mesh's prototype chain to find the plain
`Mesh` base class (the game's own meshes are instanced subclasses that
ignore constructor args) and allocating its vertex buffer with the game
realm's `Float32Array` (a portal-realm typed array fails three's
`instanceof` check inside the iframe).

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
- `src/voxel/` — voxelizer (surface + solid fill), shape fitting, voxels → parts
- `src/game/` — captured-track access + the insert session (move/rotate/apply)
- `src/ui/` — the in-game panel + canvas voxel preview
- `src/entrypoint.ts` — TSPML mod factory (default export)
- `mixins.json` — the setPart capture patch (declared in mod.json)
- `tests/` — vitest suites incl. a real community-track fixture
- `docs/DESIGN.md` — format notes + architecture

## Compatibility

Targets PolyTrack `>=0.6.0 <0.7.0` via TSPML. Capabilities: `dom`, `storage`
(panel UI + persisted settings). `vanillaSafe: true` — the mixin only
*observes* (it captures a reference to the editor's track object; nothing
about physics or gameplay changes), and everything the mod builds is ordinary
track data.
