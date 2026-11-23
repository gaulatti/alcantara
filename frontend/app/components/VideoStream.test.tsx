import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VideoStream } from './VideoStream';

// gaulatti/alcantara#184: the scene video stream, through its loosely typed
// scene props, the video element and hls.js.

const hls = vi.hoisted(() => ({
  supported: true,
  failImport: false,
  instances: [] as Array<{
    options: unknown;
    attachMedia: ReturnType<typeof import('vitest').vi.fn>;
    loadSource: ReturnType<typeof import('vitest').vi.fn>;
    destroy: ReturnType<typeof import('vitest').vi.fn>;
    handlers: Record<string, (event: unknown, data?: unknown) => void>;
  }>,
}));

vi.mock('hls.js', () => {
  class FakeHls {
    static Events = { MANIFEST_PARSED: 'manifestParsed', ERROR: 'error' };
    static isSupported() {
      return hls.supported;
    }
    handlers: Record<string, (event: unknown, data?: unknown) => void> = {};
    attachMedia = vi.fn();
    loadSource = vi.fn();
    destroy = vi.fn();
    constructor(readonly options: unknown) {
      hls.instances.push(this);
    }
    on(event: string, handler: (event: unknown, data?: unknown) => void) {
      this.handlers[event] = handler;
    }
  }
  return {
    get default() {
      if (hls.failImport) throw new Error('chunk failed to load');
      return FakeHls;
    },
  };
});

let canPlayHls = '';
beforeEach(() => {
  hls.supported = true;
  hls.failImport = false;
  hls.instances.length = 0;
  canPlayHls = '';
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation(() => canPlayHls as CanPlayTypeResult);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const video = (container: HTMLElement) => container.querySelector('video')!;
const unavailable = () => screen.queryByText('Video stream unavailable');

it('renders nothing without a usable source', () => {
  for (const sourceUrl of [undefined, 42, '   ']) {
    const { container, unmount } = render(<VideoStream sourceUrl={sourceUrl} />);
    expect(container).toBeEmptyDOMElement();
    unmount();
  }
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
});

it('plays a direct source with the default presentation', () => {
  const { container } = render(<VideoStream sourceUrl=' https://media.example.test/loop.mp4 ' />);
  const element = video(container);
  expect(element.getAttribute('src')).toBe('https://media.example.test/loop.mp4');
  expect(element.load).toHaveBeenCalled();
  expect(element.play).toHaveBeenCalledTimes(1);
  expect(element).not.toHaveAttribute('poster');
  expect(element.controls).toBe(false);
  expect(element.loop).toBe(false);
  expect(element).toHaveStyle({ objectFit: 'cover' });
  expect(element.volume).toBe(1);
  expect(element.muted).toBe(false);
});

it('reads scene props given as strings, numbers or booleans', () => {
  const { container, rerender } = render(
    <VideoStream
      sourceUrl='https://media.example.test/loop.mp4'
      posterUrl=' https://media.example.test/poster.jpg '
      showControls='Yes'
      loop={1}
      autoPlay='off'
      objectFit='contain'
      channelGain={1.8}
    />,
  );
  let element = video(container);
  expect(element).toHaveAttribute('poster', 'https://media.example.test/poster.jpg');
  expect(element.controls).toBe(true);
  expect(element.loop).toBe(true);
  expect(element).toHaveStyle({ objectFit: 'contain' });
  expect(element.volume).toBe(1);
  expect(element.play).not.toHaveBeenCalled();

  rerender(
    <VideoStream
      sourceUrl='https://media.example.test/loop.mp4'
      showControls=''
      loop={0}
      autoPlay='sometimes'
      objectFit='stretch'
      channelGain={0}
    />,
  );
  element = video(container);
  expect(element.controls).toBe(false);
  expect(element.loop).toBe(false);
  expect(element).toHaveStyle({ objectFit: 'cover' });
  expect(element.muted).toBe(true);
  // An unreadable autoPlay keeps its default and plays.
  expect(element.play).toHaveBeenCalled();

  rerender(
    <VideoStream sourceUrl='https://media.example.test/loop.mp4' showControls={{}} channelGain='loud' />,
  );
  element = video(container);
  expect(element.controls).toBe(false);
  expect(element.volume).toBe(1);
  expect(element.muted).toBe(false);
});

it('ignores a refused autoplay and a cancelled load, but reports a failed one', async () => {
  const play = vi.mocked(HTMLMediaElement.prototype.play);
  for (const name of ['NotAllowedError', 'AbortError']) {
    play.mockRejectedValueOnce(Object.assign(new Error(name), { name }));
    const { unmount } = render(<VideoStream sourceUrl='https://media.example.test/a.mp4' />);
    await act(async () => {});
    expect(unavailable()).toBeNull();
    unmount();
  }
  play.mockRejectedValueOnce(new Error('decode failed'));
  const failed = render(<VideoStream sourceUrl='https://media.example.test/b.mp4' />);
  expect(await screen.findByText('Video stream unavailable')).toBeInTheDocument();
  failed.unmount();

  play.mockRejectedValueOnce('no reason');
  render(<VideoStream sourceUrl='https://media.example.test/c.mp4' />);
  expect(await screen.findByText('Video stream unavailable')).toBeInTheDocument();
});

it('drops a play failure that lands after the source changed', async () => {
  let fail!: (error: Error) => void;
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(
    () => new Promise((_done, reject) => (fail = reject)),
  );
  const { rerender } = render(<VideoStream sourceUrl='https://media.example.test/a.mp4' />);
  rerender(<VideoStream sourceUrl='https://media.example.test/b.mp4' />);
  await act(async () => fail(new Error('decode failed')));
  expect(unavailable()).toBeNull();
});

it('plays in browsers whose play() returns nothing', () => {
  vi.mocked(HTMLMediaElement.prototype.play).mockReturnValue(undefined as never);
  render(<VideoStream sourceUrl='https://media.example.test/a.mp4' />);
  expect(unavailable()).toBeNull();
});

it('shows a media error until the stream plays again or changes', () => {
  const { container, rerender } = render(<VideoStream sourceUrl='https://media.example.test/a.mp4' />);
  fireEvent.error(video(container));
  expect(unavailable()).toBeInTheDocument();
  fireEvent.playing(video(container));
  expect(unavailable()).toBeNull();
  fireEvent.error(video(container));
  rerender(<VideoStream sourceUrl='https://media.example.test/b.mp4' />);
  expect(unavailable()).toBeNull();
});

it('plays an HLS stream natively where the browser supports it', () => {
  canPlayHls = 'maybe';
  const { container } = render(<VideoStream sourceUrl='https://media.example.test/live.M3U8' />);
  expect(video(container).getAttribute('src')).toBe('https://media.example.test/live.M3U8');
  expect(hls.instances).toHaveLength(0);
});

it('plays an HLS stream through hls.js, starting once the manifest is parsed', async () => {
  const { container, unmount } = render(<VideoStream sourceUrl='https://media.example.test/live.m3u8' />);
  await waitFor(() => expect(hls.instances).toHaveLength(1));
  const instance = hls.instances[0];
  expect(instance.options).toEqual({ enableWorker: true, lowLatencyMode: true });
  expect(instance.attachMedia).toHaveBeenCalledWith(video(container));
  expect(instance.loadSource).toHaveBeenCalledWith('https://media.example.test/live.m3u8');
  expect(video(container).play).not.toHaveBeenCalled();
  act(() => instance.handlers.manifestParsed({}));
  expect(video(container).play).toHaveBeenCalledTimes(1);
  act(() => instance.handlers.error({}, { fatal: false }));
  act(() => instance.handlers.error({}));
  expect(unavailable()).toBeNull();
  act(() => instance.handlers.error({}, { fatal: true }));
  expect(unavailable()).toBeInTheDocument();
  unmount();
  expect(instance.destroy).toHaveBeenCalled();
  act(() => instance.handlers.error({}, { fatal: true }));
});

it('falls back to native playback where hls.js is unsupported', async () => {
  hls.supported = false;
  const { container } = render(<VideoStream sourceUrl='https://media.example.test/live.m3u8' />);
  await waitFor(() =>
    expect(video(container).getAttribute('src')).toBe('https://media.example.test/live.m3u8'),
  );
  expect(hls.instances).toHaveLength(0);
});

it('reports a stream whose HLS player could not load', async () => {
  hls.failImport = true;
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<VideoStream sourceUrl='https://media.example.test/live.m3u8' />);
  expect(await screen.findByText('Video stream unavailable')).toBeInTheDocument();
  expect(errors).toHaveBeenCalledWith('Failed to initialize HLS playback:', expect.any(Error));
});

it('does nothing when it closes before the HLS player loads, or fails after closing', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<VideoStream sourceUrl='https://media.example.test/live.m3u8' />).unmount();
  await act(async () => {});
  expect(hls.instances).toHaveLength(0);

  hls.failImport = true;
  render(<VideoStream sourceUrl='https://media.example.test/other.m3u8' />).unmount();
  await act(async () => {});
  expect(errors).toHaveBeenCalled();
});

// A host that moves the element's volume on its own (WebKitGTK under PipeWire reflects the level
// the system restored for the app's last stream: 0 after a muted, staged scene) must not leave the
// program silent after a take: the channel gain is applied again.
it('keeps the channel gain when the host moves the volume, on every new element', () => {
  const { container, rerender } = render(<VideoStream sourceUrl='https://media.example.test/card.mp4' channelGain={1} />);
  let element = video(container);
  element.volume = 0;
  fireEvent(element, new Event('volumechange'));
  expect(element.volume).toBe(1);
  expect(element.muted).toBe(false);

  // A take to another source makes a new element, with the same gain: it is applied there too.
  rerender(<VideoStream sourceUrl='https://media.example.test/next.mp4' channelGain={1} />);
  const next = video(container);
  expect(next).not.toBe(element);
  next.volume = 0;
  fireEvent(next, new Event('playing'));
  expect(next.volume).toBe(1);

  // A muted channel stays muted however the host flips it.
  rerender(<VideoStream sourceUrl='https://media.example.test/next.mp4' channelGain={0} />);
  element = video(container);
  element.muted = false;
  fireEvent(element, new Event('volumechange'));
  expect(element.muted).toBe(true);
  expect(element.volume).toBe(0);
});

it('leaves a host-rounded volume alone and stops following the element once unmounted', () => {
  const { container, unmount } = render(<VideoStream sourceUrl='https://media.example.test/card.mp4' channelGain={0.5} />);
  const element = video(container);
  element.volume = 0.495;
  fireEvent(element, new Event('volumechange'));
  expect(element.volume).toBe(0.495);

  unmount();
  element.volume = 0;
  fireEvent(element, new Event('volumechange'));
  expect(element.volume).toBe(0);
});
