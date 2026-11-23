import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { completeSceneCountdown } = vi.hoisted(() => ({ completeSceneCountdown: vi.fn() }));
vi.mock('../services/program', () => ({ completeSceneCountdown }));

import RelojDigitalLoopClock from './RelojDigitalLoopClock';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  completeSceneCountdown.mockReset();
});

const text = (value: string) => ({ mode: 'manual', items: [{ id: 'a', kind: 'preset', text: value }], activeItemId: 'a' });

describe('RelojDigitalLoopClock', () => {
  it('shows the countdown at its full duration with the MI mark outside the clock block', () => {
    const { container } = render(<RelojDigitalLoopClock mode='countdown' countdownDuration={310} programId='reloj-test' allowProgramActivation={false} />);
    expect(container.querySelector('#clock')?.textContent).toBe('00:05:10');
    expect(container.querySelector('#ms')?.textContent).toBe('00');
    // Idle, the label is empty; it reads COUNTDOWN only while running.
    expect(container.querySelector('#city-name')?.textContent).toBe('');
    const mark = container.querySelector('#reloj-mark svg[aria-label="ModoItaliano"]');
    expect(mark).not.toBeNull();
    expect(container.querySelector('#clock-block')?.contains(mark)).toBe(false);
    expect(container.querySelector('#logo-above')).toBeNull();
  });

  it('asks the API to switch scenes when the countdown reaches zero, once, without needing a sign-in', async () => {
    vi.useFakeTimers();
    completeSceneCountdown.mockRejectedValue(new Error('refused'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const clock = (command: number, allow = true) => (
      <RelojDigitalLoopClock
        mode='countdown'
        countdownDuration={2}
        countdownTargetSceneId={75}
        countdownTransitionId='hit-parade'
        countdownCommand={command}
        programId='reloj-test'
        allowProgramActivation={allow}
      />
    );
    const { container, rerender } = render(clock(0));
    rerender(clock(1));
    expect(container.querySelector('#city-name')?.textContent).toBe('COUNTDOWN');
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(completeSceneCountdown).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(completeSceneCountdown).toHaveBeenCalledTimes(1);
    expect(completeSceneCountdown).toHaveBeenCalledWith('reloj-test');
    // A refusal is reported, not thrown away.
    expect(logged).toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(completeSceneCountdown).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it('does not switch scenes from a monitor', async () => {
    vi.useFakeTimers();
    const clock = (command: number) => (
      <RelojDigitalLoopClock mode='countdown' countdownDuration={1} countdownTargetSceneId={75} countdownCommand={command} programId='reloj-test' allowProgramActivation={false} />
    );
    const { rerender } = render(clock(0));
    rerender(clock(1));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(completeSceneCountdown).not.toHaveBeenCalled();
  });

  it('renders the lower third only when there is text, without the old separator', () => {
    const empty = render(<RelojDigitalLoopClock mode='countdown' />);
    expect(empty.container.querySelector('#lower-third')).toBeNull();
    empty.unmount();

    const { container } = render(<RelojDigitalLoopClock mode='countdown' textSequence={text('Modoitaliano podcast')} ctaSequence={text('En minutos')} />);
    expect(container.querySelector('#cta')?.textContent).toBe('En minutos');
    expect(container.querySelector('#show-title')).not.toBeNull();
    expect(container.querySelector('#pipe')).toBeNull();
  });
});
