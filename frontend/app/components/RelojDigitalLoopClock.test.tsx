import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RelojDigitalLoopClock from './RelojDigitalLoopClock';
import { activateScene } from '../services/program';

vi.mock('../services/program', () => ({ activateScene: vi.fn() }));

const sequence = (text: string) => ({
  mode: 'manual', activeItemId: 'caption',
  items: [{ id: 'caption', kind: 'preset', text }],
});

describe('digital loop clock output', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:05Z'));
    vi.mocked(activateScene).mockReset();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('renders the selected timezone and keeps absent editorial text off air', () => {
    const { container } = render(<RelojDigitalLoopClock timezone='America/New_York' />);
    expect(container.querySelector('#clock')).toHaveTextContent('07:00:05');
    expect(container.querySelector('#city-name')).toHaveTextContent('NEW YORK');
    expect(container.querySelector('#lower-third')).not.toBeInTheDocument();
  });

  it('renders resolved CTA and title sequence text without unsupported animation state', () => {
    const { container } = render(<RelojDigitalLoopClock textSequence={sequence('News at noon')} ctaSequence={sequence('Read more')} />);
    expect(screen.getByText('Read more')).toBeInTheDocument();
    expect(container.querySelector('#cta')).not.toHaveClass('out');
    act(() => vi.advanceTimersByTime(2000));
    expect(container.querySelector('#show-title')).toHaveTextContent('News at noon');
    expect(container.querySelector('#pipe')).toHaveTextContent('|');
  });

  it('keeps countdown activation explicit and fires its scene transition exactly once', () => {
    const initial = { mode: 'countdown' as const, countdownDuration: 1, countdownCommand: 1, programId: 'program-1', countdownTargetSceneId: 9, countdownTransitionId: 'fade' };
    const { rerender, container } = render(<RelojDigitalLoopClock {...initial} />);
    act(() => vi.advanceTimersByTime(2000));
    expect(activateScene).not.toHaveBeenCalled();
    expect(container.querySelector('#clock')).toHaveTextContent('00:00:01');
    rerender(<RelojDigitalLoopClock {...initial} countdownCommand={2} />);
    act(() => vi.advanceTimersByTime(1100));
    expect(container.querySelector('#clock')).toHaveTextContent('00:00:00');
    expect(activateScene).toHaveBeenCalledExactlyOnceWith('program-1', 9, 'fade');
    act(() => vi.advanceTimersByTime(3000));
    expect(activateScene).toHaveBeenCalledTimes(1);
  });

  it('permits preview countdown rendering without authority to activate Program', () => {
    const props = { mode: 'countdown' as const, countdownDuration: 1, countdownCommand: 0, programId: 'program-1', countdownTargetSceneId: 9, allowProgramActivation: false };
    const { rerender, container } = render(<RelojDigitalLoopClock {...props} />);
    rerender(<RelojDigitalLoopClock {...props} countdownCommand={1} />);
    act(() => vi.advanceTimersByTime(1100));
    expect(container.querySelector('#clock')).toHaveTextContent('00:00:00');
    expect(activateScene).not.toHaveBeenCalled();
  });

  it('lets the operator cancel a running countdown before any scene command is emitted', () => {
    const props = { mode: 'countdown' as const, countdownDuration: 5, countdownCommand: 0, programId: 'program-1', countdownTargetSceneId: 9 };
    const { rerender, container } = render(<RelojDigitalLoopClock {...props} />);
    rerender(<RelojDigitalLoopClock {...props} countdownCommand={1} />);
    act(() => vi.advanceTimersByTime(1000));
    rerender(<RelojDigitalLoopClock {...props} countdownCommand={2} />);
    act(() => vi.advanceTimersByTime(6000));
    expect(container.querySelector('#clock')).toHaveTextContent('00:00:00');
    expect(activateScene).not.toHaveBeenCalled();
  });
});
