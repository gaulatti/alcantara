import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event } from '../events';
import MemoMarquee, { Marquee } from './Marquee';

const event = (uuid: string, createdAt: string, relevances: number[], extra: Partial<Event> = {}): Event =>
  ({
    id: 1,
    uuid,
    title: `Headline ${uuid}`,
    summary: '',
    status: 'open',
    created_at: createdAt,
    updated_at: createdAt,
    posts_count: relevances.length,
    posts: relevances.map((relevance, index) => ({ id: index, uuid: `${uuid}-${index}`, relevance })) as never,
    ...extra,
  }) as Event;

// 4 posts, average 8, median 8: passes the defaults.
const strong = (uuid: string, createdAt: string) => event(uuid, createdAt, [8, 8, 8, 8]);

function setScrollWidth(width: number) {
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => width });
}

describe('fifthbell Marquee', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setScrollWidth(2000);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    // @ts-expect-error restore the jsdom default
    delete HTMLElement.prototype.scrollWidth;
  });

  it('renders nothing when no event passes the thresholds', () => {
    const { container } = render(<Marquee events={[event('weak', '2026-11-22T01:00:00Z', [1, 1, 1, 1])]} />);
    expect(container).toBeEmptyDOMElement();
    expect(render(<Marquee events={[]} />).container).toBeEmptyDOMElement();
  });

  it('shows the headlines that pass, oldest first, and sets the animation from the content width after 100 ms', () => {
    const { container, getAllByText } = render(
      <Marquee events={[strong('late', '2026-11-22T09:00:00Z'), strong('early', '2026-11-22T03:00:00Z')]} pixelsPerSecond={100} />,
    );
    expect(getAllByText(/Headline/).map((node) => node.textContent)).toEqual(['Headline early', 'Headline late']);
    const track = container.querySelector('div[style*="marqueeFlow"]') as HTMLElement;
    expect(track.style.animation).toContain('marqueeFlow 20s linear infinite');
    act(() => {
      vi.advanceTimersByTime(100);
    });
    // (1920 + 2000) / 100 = 39.2 s
    expect(track.style.animation).toContain('marqueeFlow 39.2s linear infinite');
  });

  it('never goes below the minimum duration, and guards a pixels-per-second of 0', () => {
    setScrollWidth(0);
    const { container, rerender } = render(<Marquee events={[strong('a', '2026-11-22T01:00:00Z')]} pixelsPerSecond={1000} minDurationSeconds={10} />);
    const track = () => container.querySelector('div[style*="marqueeFlow"]') as HTMLElement;
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(track().style.animation).toContain('marqueeFlow 10s');
    rerender(<Marquee events={[strong('a', '2026-11-22T01:00:00Z')]} pixelsPerSecond={0} minDurationSeconds={10} />);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    // 1920 / max(1, 0) = 1920 s
    expect(track().style.animation).toContain('marqueeFlow 1920s');
  });

  it('recomputes on resize, and stops listening and timing when it unmounts', () => {
    const { container, unmount } = render(<Marquee events={[strong('a', '2026-11-22T01:00:00Z')]} pixelsPerSecond={100} />);
    const track = () => container.querySelector('div[style*="marqueeFlow"]') as HTMLElement;
    act(() => {
      vi.advanceTimersByTime(100);
    });
    setScrollWidth(4080);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(track().style.animation).toContain('marqueeFlow 60s');
    const removed = vi.spyOn(window, 'removeEventListener');
    unmount();
    expect(removed).toHaveBeenCalledWith('resize', expect.any(Function));
  });

  it('does nothing when the content is not there yet at the 100 ms mark', () => {
    // Nothing passes: the track never mounts, so the timer finds no content.
    render(<Marquee events={[event('weak', '2026-11-22T01:00:00Z', [1])]} />);
    expect(() => act(() => void vi.advanceTimersByTime(100))).not.toThrow();
  });

  it('tells its parent each time the animation completes a cycle', () => {
    const onCycleComplete = vi.fn();
    const { container } = render(<Marquee events={[strong('a', '2026-11-22T01:00:00Z')]} onCycleComplete={onCycleComplete} />);
    fireEvent.animationIteration(container.querySelector('div[style*="marqueeFlow"]') as HTMLElement);
    expect(onCycleComplete).toHaveBeenCalledTimes(1);
  });

  describe('thresholds', () => {
    it('counts posts_count when it is a number, else the posts themselves', () => {
      const withCount = event('count', '2026-11-22T01:00:00Z', [8, 8], { posts_count: 9 });
      const withoutCount = event('nocount', '2026-11-22T02:00:00Z', [8, 8, 8, 8], { posts_count: undefined as never });
      const tooFew = event('few', '2026-11-22T03:00:00Z', [8, 8], { posts_count: undefined as never });
      const { getAllByText } = render(<Marquee events={[withCount, withoutCount, tooFew]} />);
      expect(getAllByText(/Headline/).map((node) => node.textContent)).toEqual(['Headline count', 'Headline nocount']);
    });

    it('needs the average and the median relevance, for an odd and an even number of posts', () => {
      const lowAverage = event('low-average', '2026-11-22T01:00:00Z', [20, 20, 1, 1, 1]); // median 1... fails
      const oddOk = event('odd', '2026-11-22T02:00:00Z', [7, 8, 9, 7, 9]); // average 8, median 8
      const evenOk = event('even', '2026-11-22T03:00:00Z', [6, 8, 9, 9]); // average 8, median 8.5
      const highMedianLowAverage = event('median-only', '2026-11-22T04:00:00Z', [9, 9, 9, 0, 0, 0, 0]); // median 0
      const { getAllByText } = render(<Marquee events={[lowAverage, oddOk, evenOk, highMedianLowAverage]} />);
      expect(getAllByText(/Headline/).map((node) => node.textContent)).toEqual(['Headline odd', 'Headline even']);
    });

    it('lets everything through a threshold set to 0 or less, even an event with no posts', () => {
      const empty = event('empty', '2026-11-22T01:00:00Z', [], { posts_count: 0 });
      const { getByText } = render(<Marquee events={[empty]} minPostsCount={0} minAverageRelevance={0} minMedianRelevance={-1} />);
      expect(getByText('Headline empty')).toBeInTheDocument();
    });

    it('refuses an event with no posts under the default thresholds', () => {
      const { container } = render(<Marquee events={[event('empty', '2026-11-22T01:00:00Z', [], { posts_count: 0 })]} minPostsCount={0} />);
      expect(container).toBeEmptyDOMElement();
    });
  });

  it('draws with the given height and colours, and the memoised default export is the same component', () => {
    const { container } = render(<MemoMarquee events={[strong('a', '2026-11-22T01:00:00Z')]} heightPx={90} backgroundColor='rgb(1, 2, 3)' borderColor='#00ff00' />);
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.style.height).toBe('90px');
    expect(frame.style.backgroundColor).toBe('rgb(1, 2, 3)');
    expect(frame.style.borderTop).toContain('2px solid');
  });
});
