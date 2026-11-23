import { GiorgiaMark } from '@modoitaliano/giorgia/scenes';
import { SceneTransitionOverlay as BleeckerSceneTransitionOverlay } from '../bleecker';
import type { SceneTransitionPreset } from '../utils/sceneTransitions';

/** The scene transition overlays come from the library; the hit-parade wipe carries this app's brand mark. */
export function SceneTransitionOverlay({ transition }: { transition: SceneTransitionPreset }) {
  return <BleeckerSceneTransitionOverlay transition={transition} brandMark={<GiorgiaMark width={340} />} />;
}
