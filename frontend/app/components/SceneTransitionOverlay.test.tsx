import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { getSceneTransitionPreset, SCENE_TRANSITIONS } from '../utils/sceneTransitions';
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

describe('SceneTransitionOverlay: every preset', () => {
  it('renders nothing for a cut', () => {
    const { container } = render(<SceneTransitionOverlay transition={getSceneTransitionPreset('cut')} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('plays a webm stinger from its own URL, muted and inline, for the preset duration', () => {
    const preset = { ...getSceneTransitionPreset('webm-stinger'), stingerUrl: 'https://example.test/stinger.webm' };
    const { container } = render(<SceneTransitionOverlay transition={preset} />);
    const overlay = container.querySelector<HTMLElement>('.scene-transition-overlay--webm-stinger')!;
    expect(overlay.style.getPropertyValue('--scene-transition-duration')).toBe(`${preset.durationMs}ms`);
    expect(overlay).toHaveAttribute('aria-hidden', 'true');
    const video = overlay.querySelector('video')!;
    expect(video).toHaveAttribute('src', 'https://example.test/stinger.webm');
    expect(video.muted).toBe(true);
    expect(video.autoplay).toBe(true);
  });

  it.each(SCENE_TRANSITIONS.filter((preset) => preset.id !== 'cut' && preset.id !== 'webm-stinger').map((preset) => [preset.id, preset] as const))(
    'draws the %s overlay for its duration, hidden from assistive technology, with its own layers',
    (id, preset) => {
      const { container } = render(<SceneTransitionOverlay transition={preset} />);
      const overlay = container.firstElementChild as HTMLElement;
      expect(overlay).toHaveClass('scene-transition-overlay');
      expect(overlay).toHaveClass(`scene-transition-overlay--${id}`);
      expect(overlay.style.getPropertyValue('--scene-transition-duration')).toBe(`${preset.durationMs}ms`);
      expect(overlay).toHaveAttribute('aria-hidden', 'true');
      expect(overlay.children.length).toBeGreaterThan(0);
    },
  );

  it.each([
    ['election-wall', 'election', 'cool'],
    ['market-pulse', 'market', 'cool'],
    ['world-desk', 'world', 'cool'],
    ['festival-runway', 'festival', 'warm'],
  ])('%s has its solid layers, its vector drawing and its %s finish', (id, variant, tone) => {
    const { container } = render(<SceneTransitionOverlay transition={getSceneTransitionPreset(id)} />);
    expect(container.querySelectorAll(`.scene-transition-overlay__solid--${variant}-left, .scene-transition-overlay__solid--${variant}-right, .scene-transition-overlay__solid--${variant}-center, .scene-transition-overlay__solid--${variant}-top, .scene-transition-overlay__solid--${variant}-bottom, .scene-transition-overlay__solid--${variant}-core, .scene-transition-overlay__solid--${variant}-axis, .scene-transition-overlay__solid--${variant}-runway`).length).toBe(3);
    expect(container.querySelector(`svg.scene-transition-overlay__vector--${variant}`)).not.toBeNull();
    expect(container.querySelector(`.scene-transition-overlay__sheen--${tone}`)).not.toBeNull();
    expect(container.querySelector('.scene-transition-overlay__grain')).not.toBeNull();
  });
});
