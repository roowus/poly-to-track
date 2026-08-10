/**
 * poly-to-track — import 3D models (STL/OBJ) as LEGO-style block builds in
 * PolyTrack, Schematica-style: load, preview, rotate/scale/offset, pick a
 * color, generate a playable track through TSPML's api.tracks registry.
 *
 * Toggle the panel with the ⌨ P key (rebindable in TSPML's keybind UI).
 */
import type { TspmlApi } from './tspml-api';
import { createPanel } from './ui/panel';

export default function polyToTrack(api: TspmlApi, _game: unknown): () => void {
  const panel = createPanel(api);

  const unbind = api.keybinds.register({
    id: 'poly-to-track.toggle',
    key: 'KeyP',
    description: 'poly-to-track: toggle importer panel',
    onDown: () => panel.toggle(),
  });

  api.logger.log('[poly-to-track] loaded — press P to open the importer');

  return () => {
    unbind();
    panel.dispose();
    api.logger.log('[poly-to-track] unloaded');
  };
}
