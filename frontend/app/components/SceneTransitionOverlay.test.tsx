import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { getSceneTransitionPreset } from '../utils/sceneTransitions';
import { SceneTransitionOverlay } from './SceneTransitionOverlay';

afterEach(cleanup);

describe('SceneTransitionOverlay: hit parade', () => {
  it('renders the Giorgia wipe with the MI mark and none of the legacy layers', () => {
    const preset = getSceneTransitionPreset('hit-parade');
    const { container } = render(<SceneTransitionOverlay transition={preset} />);
    const overlay = container.querySelector<HTMLElement>('.scene-transition-overlay--hit-parade');
    expect(overlay?.style.getPropertyValue('--scene-transition-duration')).toBe(`${preset.durationMs}ms`);
    expect(overlay?.querySelector('.scene-transition-overlay__giorgia-panel svg[aria-label="ModoItaliano"]')).not.toBeNull();
    expect(overlay?.querySelectorAll('.scene-transition-overlay__giorgia-light')).toHaveLength(3);
    expect(overlay?.querySelector('.scene-transition-overlay__giorgia-bar')).not.toBeNull();
    expect(overlay?.querySelector('[class*="__hit-"], [class*="--hit-band"], [class*="__sheen"], [class*="__grain"]')).toBeNull();
    expect(overlay?.querySelector('img')).toBeNull();
  });

  it('keeps the cut point inside the fully covered part of the wipe', () => {
    const preset = getSceneTransitionPreset('hit-parade');
    const cut = preset.cutPointMs / preset.durationMs;
    expect(cut).toBeGreaterThan(0.38);
    expect(cut).toBeLessThan(0.62);
  });
});
