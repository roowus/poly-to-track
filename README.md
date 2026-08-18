# poly-to-track

<img src="assets/icon.svg" alt="poly-to-track icon" width="96" align="right">

A [TSPML](https://github.com/roowus/TSPML) mod that imports 3D models
(**STL** / **OBJ + MTL** / **glTF** / **GLB**) into
[PolyTrack](https://www.kodub.com/apps/polytrack) as LEGO-style block
builds — think **Schematica / Axiom for PolyTrack**.

Load a model, watch the live voxel preview (with a ground grid so you can
see how the build will sit), dial in resolution / any-angle rotation / scale
/ colors, then **insert it straight into the open track editor**: a
translucent ghost of the model appears in the world you're editing wearing
**Blender-style 3D transform handles** — drag the colored arrows to move,
the square frames to rotate about any axis at any angle, the tip boxes to
scale a single axis (or the white center box for uniform) — then Apply does
the one real placement, exactly like placing a Schematica ghost.
Colored models (OBJ vertex colors or MTL materials **including `map_Kd`
textures**, glTF/GLB vertex colors, material base colors **or base color
textures**, colored binary STL) are mapped
per-block onto the game's palette — textures are sampled **per block**
(each voxel looks up its own texel through the triangle's UV mapping), so
a skin or texture atlas genuinely paints the build instead of flattening
to one color per triangle. Palette matching is **hue-first** (the game's
custom swatches are dark, so light tints keep their hue — a pastel maps
to its color, not to white). The builds use the game's full shape
vocabulary (blocks, half/quarter blocks, slopes) so curved models aren't
staircases of slabs.

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

   Either way, the mod's card in the portal sidebar grows a **docs** button
   linking back to this page (the manifest's `homepage`).
4. Open the **track editor** and click the **cube** button at the left of
   the editor's cut/copy/paste toolbar — or press **P** (rebindable in
   TSPML's keybind settings).

## Using it

The importer is editor-only: open the **track editor**, then click the
**cube** button to the left of cut/copy/paste, or press **P**. The panel lives inside
the game's UI and follows its styling, and closes itself when you leave the
editor.

| Control | What it does |
| --- | --- |
| **Load STL / OBJ / glTF** | Parses the file(s): binary + ASCII STL; OBJ with quads/negative indices (select the `.mtl` — and any `map_Kd` texture images — alongside it); glTF 2.0 both as self-contained `.glb` (embedded textures just work) and as `.gltf` JSON (select external `.bin`/image files together with it) |
| Preview canvas | Drag to orbit the voxelized model, drawn as true isometric cubes locked to the green ground grid (the track floor) — one grid square = one block cell at the current resolution |
| **Resolution** (4–256) | Longest model axis maps to this many blocks |
| **Fill interior** | Flood-fill the inside (off by default — hollow shells are far fewer parts) |
| **Rotate X/Y/Z** | Any angle (drag snaps to 5°), applied to the mesh before voxelization — a 45° build is a true diagonal voxelization, not sheared blocks |
| **Scale** | ×0.1 – ×8 — block size stays constant, so ×2 really is a bigger build with more blocks, not the same blocks stretched |

Every slider's number is a button — **click it to type an exact value**
(37°, ×1.55…), free of the drag snap. Enter or clicking away commits,
Escape cancels.
| **Use the model's own colors** | Maps OBJ vertex/MTL colors (incl. sampled textures), glTF vertex/material/texture colors and STL facet colors per block onto the game palette (interior blocks inherit the nearest surface color) |
| **Block color** | Fallback / flat color: Default + the game's 9 custom block colors |
| **⤓ Insert into editor** | Stages the model as a viewport ghost and enters transform mode |
| **Save as track** | Secondary path: encodes + registers a standalone track |

While a model is staged, a translucent colored ghost of the model is drawn
in the game viewport inside a Blender-style orange selection frame (it reads
through terrain, so you always see where the model sits), wearing **3D
transform handles**, Blender-style:

- **Colored arrows** — drag to move along that axis (snaps to the block grid)
- **Square frames** — drag around the model to rotate about that axis, any
  angle (snaps to 5°; the model re-voxelizes as you go)
- **Boxes past the arrow tips** — drag to scale that ONE axis
- **White center box** — drag to scale uniformly

Red = X, green = Y, blue = Z, exactly like Blender. Nothing is written to
the track until Apply, so moving even a 100k-part model is instant. If the
ghost intersects parts you already placed, the Apply strip shows an amber
**overlaps N existing parts** warning (checked against the editor's real
tile occupancy) — you can still Apply if the overlap is intentional. The
panel's sliders mirror the handles (drag a frame and the panel's rotation
slider follows), and these keys work too:

| Key | Action |
| --- | --- |
| ← → / ↑ ↓ | Move one cell in x / z |
| PgUp / PgDn | Raise / lower one unit |
| **R** | Rotate 90° about Y |
| **Enter** | Apply — the parts become a normal part of your track |
| **Delete** | Cancel — drop the ghost, nothing was placed |

Applied parts are ordinary track parts: the editor's own tools treat them
like anything you placed by hand — and the apply itself is undoable. Press
**Ctrl+Z** (or the editor's ↩ undo button) right after applying and the
whole insert lifts back out; **Ctrl+Shift+Z / Ctrl+Y** (or ↪ redo) puts it
back. The moment you edit the track by hand the insert stops being the
newest change, so from then on undo/redo belong to the editor as usual.

There is no hard part limit. The block counter turns amber past 100,000
parts as a heads-up that the game will visibly chug and track codes get
enormous — lower the resolution or uncheck *Fill interior* if that matters.

## How it works

```
STL/OBJ+MTL/glTF/GLB (positions + per-triangle colors) → TriangleMesh
→ transform (rotate/scale) → voxelize
  (SAT triangle-box surface pass + 6-connected exterior flood fill,
   anisotropic grid: 4 y-cells per block so builds aren't flattened;
   colors ride along — textured triangles are re-sampled PER VOXEL via
   barycentric UVs at each cell center; interior cells BFS-inherit the
   nearest surface color)
→ shape fitting: Block / HalfBlock / QuarterBlock / slope per voxel column
  (each part gets the nearest game palette color, HSV hue-weighted)
→ INSERT: stage a session (no track writes) + draw a ghost mesh in the
  game's own three.js scene; move = one mesh.position.set, O(1) at any
  part count; Apply = the single batch of setPart calls (with rollback)
  through the mixin-captured track object
→ or SAVE: PolyTrack2 encoder (double deflate + base-62 bitstream)
  → api.tracks.register → your track list
```

The capture mixin (`mixins.json`) anchors on two error strings that exist
only inside the track class's `setPart` and stamps the instance on a global
the mod reads — the editor calls `setPart` for its initial Start part the
moment it opens, so the reference is always fresh.

A second mixin captures the game's renderer wrapper the same way (anchored
on its unique WebGL-failure string, hooked at `setCamera`, which the editor
calls with its camera on entry). That hands the mod the live three.js scene
and camera, where `src/game/ghost.ts` draws the staged model,
`src/game/gizmo.ts` the selection frame, and `src/game/handles.ts` the
interactive transform handles (picking is a plain ray/AABB slab test against
the camera's own matrices — no raycaster class needed). The game doesn't export
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
- `src/mesh/` — STL, OBJ+MTL and glTF/GLB parsers, transforms
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
