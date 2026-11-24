import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaLabel } from '../models/broadcast';
import {
  ModoItalianoGiorgiaArtistBumper,
  describeArtistBumperProblem,
  normalizeArtistBumperLabelId,
  pickArtistBumperLabelImages,
  resolveArtistBumperImages
} from './ModoItalianoGiorgiaArtistBumper';
import { ModoItalianoGiorgiaArtistBumperEditorFields } from './editors/ModoItalianoGiorgiaArtistBumperEditorFields';

// The real player needs a browser; record what the bumper hands to Giorgia instead.
const played = vi.hoisted(() => [] as Array<{ inputProps: Record<string, unknown> }>);
vi.mock('./ModoItalianoGiorgiaArtistBumperPlayer', () => ({
  default: (props: { inputProps: Record<string, unknown> }) => {
    played.push(props);
    return <div data-testid='bumper-player' />;
  }
}));

afterEach(() => {
  cleanup();
  played.length = 0;
  vi.unstubAllGlobals();
});

const IMAGES = ['https://img.test/1.jpg', 'https://img.test/2.jpg', 'https://img.test/3.jpg', 'https://img.test/4.jpg'];
const TYPE = 'modoitaliano-giorgia-artist-bumper';

function stubLabelFetch(images: Array<{ imageUrl: string; position: number }>, ok = true) {
  const fetchMock = vi.fn(async (_url: string) => ({ ok, status: ok ? 200 : 500, json: async () => ({ id: 'rob', name: 'ROB', images }) }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const label = (id: string, urls: string[], extra: MediaLabel['assets'] = []): MediaLabel => ({
  id,
  name: id.toUpperCase(),
  description: null,
  assetCount: urls.length + extra.length,
  assets: [
    ...urls.map((sourceUrl, position) => ({ position, asset: { id: `${id}-${position}`, mediaType: 'IMAGE' as const, name: `Image ${position}`, sourceUrl } })),
    ...extra
  ]
});

describe('resolveArtistBumperImages', () => {
  it('accepts exactly four distinct non-empty urls', () => {
    expect(resolveArtistBumperImages(IMAGES.map((url) => ` ${url} `))).toEqual(IMAGES);
  });

  it.each([
    ['not an array', 'https://img.test/1.jpg'],
    ['three images', IMAGES.slice(0, 3)],
    ['five images', [...IMAGES, 'https://img.test/5.jpg']],
    ['a blank image', [...IMAGES.slice(0, 3), '  ']],
    ['a non-string image', [...IMAGES.slice(0, 3), 4]],
    ['a repeated image', [IMAGES[0], IMAGES[0], IMAGES[2], IMAGES[3]]]
  ])('rejects %s', (_label, images) => {
    expect(resolveArtistBumperImages(images)).toBeNull();
  });
});

describe('label images', () => {
  it('normalizes the label id', () => {
    expect(normalizeArtistBumperLabelId(' rob ')).toBe('rob');
    expect(normalizeArtistBumperLabelId('  ')).toBeNull();
    expect(normalizeArtistBumperLabelId(null)).toBeNull();
  });

  it('takes the first four different images in order', () => {
    expect(pickArtistBumperLabelImages([IMAGES[0], IMAGES[0], '', IMAGES[1], IMAGES[2], IMAGES[3], 'https://img.test/5.jpg'])).toEqual(IMAGES);
  });

  it('repeats the images of a label that has fewer than four, as four distinct urls', () => {
    const three = pickArtistBumperLabelImages([IMAGES[0], IMAGES[0], IMAGES[1], IMAGES[2]]);
    expect(three).toEqual([IMAGES[0], IMAGES[1], IMAGES[2], `${IMAGES[0]}#repeat-2`]);
    expect(pickArtistBumperLabelImages(IMAGES.slice(0, 2))).toEqual([IMAGES[0], IMAGES[1], `${IMAGES[0]}#repeat-2`, `${IMAGES[1]}#repeat-2`]);
    const one = pickArtistBumperLabelImages([IMAGES[0]]);
    expect(one).toEqual([IMAGES[0], `${IMAGES[0]}#repeat-2`, `${IMAGES[0]}#repeat-3`, `${IMAGES[0]}#repeat-4`]);
    for (const picked of [three, one]) {
      expect(new Set(picked).size).toBe(4);
      expect(resolveArtistBumperImages([...(picked ?? [])])).not.toBeNull();
    }
  });

  it('has nothing to give when the label has no images', () => {
    expect(pickArtistBumperLabelImages([])).toBeNull();
    expect(pickArtistBumperLabelImages(['', '  ', null])).toBeNull();
  });
});

describe('describeArtistBumperProblem', () => {
  it('names the first thing missing, and nothing when complete', () => {
    expect(describeArtistBumperProblem({ artist: ' ', songTitle: 'x', images: IMAGES })).toBe('Add the artist.');
    expect(describeArtistBumperProblem({ artist: 'ROB', songTitle: '', images: IMAGES })).toBe('Add the song title.');
    expect(describeArtistBumperProblem({ artist: 'ROB', songTitle: 'x', images: [] })).toBe('Add four different images.');
    expect(describeArtistBumperProblem({ artist: 'ROB', songTitle: 'x', images: IMAGES })).toBeNull();
  });

  it('judges a label by its own images, ignoring the hand-set ones', () => {
    const props = { artist: 'ROB', songTitle: 'x', images: IMAGES, labelId: 'rob' };
    expect(describeArtistBumperProblem(props, [])).toBe('The label has no images.');
    expect(describeArtistBumperProblem(props, IMAGES.slice(0, 3))).toBeNull();
    expect(describeArtistBumperProblem({ ...props, images: [] }, IMAGES)).toBeNull();
  });
});

describe('ModoItalianoGiorgiaArtistBumper', () => {
  it('hands Giorgia the trimmed content, silent, with its own eyebrow and site address', async () => {
    render(<ModoItalianoGiorgiaArtistBumper artist=' ROB ' songTitle=' Cento ragazze ' images={IMAGES} creditLines={['', '']} />);
    await screen.findByTestId('bumper-player');
    expect(played.at(-1)).toEqual({ inputProps: { artist: 'ROB', songTitle: 'Cento ragazze', images: IMAGES, audioUrl: null } });
  });

  it('passes the content type and credits through when they are set', async () => {
    render(<ModoItalianoGiorgiaArtistBumper artist='ROB' songTitle='Cento ragazze' images={IMAGES} contentType='Album' creditLines={['Warner Music Italy · 2025']} />);
    await screen.findByTestId('bumper-player');
    expect(played.at(-1)?.inputProps).toEqual({
      artist: 'ROB',
      songTitle: 'Cento ragazze',
      images: IMAGES,
      audioUrl: null,
      contentType: 'Album',
      creditLines: ['Warner Music Italy · 2025', '']
    });
  });

  it('ignores audio, eyebrow and site address saved on older scenes', async () => {
    const legacy = { audioUrl: 'https://audio.test/a.mp3', eyebrow: 'Otro', siteUrl: 'example.com' };
    render(<ModoItalianoGiorgiaArtistBumper artist='ROB' songTitle='Cento ragazze' images={IMAGES} {...(legacy as object)} />);
    await screen.findByTestId('bumper-player');
    expect(played.at(-1)?.inputProps).toEqual({ artist: 'ROB', songTitle: 'Cento ragazze', images: IMAGES, audioUrl: null });
  });

  it('takes its images from the label, in saved order, instead of the hand-set ones', async () => {
    const fetchMock = stubLabelFetch([
      { imageUrl: 'https://label.test/c.jpg', position: 2 },
      { imageUrl: 'https://label.test/a.jpg', position: 0 },
      { imageUrl: 'https://label.test/b.jpg', position: 1 },
      { imageUrl: 'https://label.test/e.jpg', position: 4 },
      { imageUrl: 'https://label.test/d.jpg', position: 3 }
    ]);
    const { container } = render(<ModoItalianoGiorgiaArtistBumper artist='ROB' songTitle='Cento ragazze' labelId=' artist:rob ' images={IMAGES} />);
    expect(container.innerHTML).toBe('');
    await screen.findByTestId('bumper-player');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/media-labels/artist%3Arob/images');
    expect(played.at(-1)?.inputProps.images).toEqual([
      'https://label.test/a.jpg',
      'https://label.test/b.jpg',
      'https://label.test/c.jpg',
      'https://label.test/d.jpg'
    ]);
  });

  it('plays a label with three images by repeating the first', async () => {
    stubLabelFetch(IMAGES.slice(0, 3).map((imageUrl, position) => ({ imageUrl, position })));
    render(<ModoItalianoGiorgiaArtistBumper artist='ROB' songTitle='x' labelId='rob' images={['', '', '', '']} />);
    await screen.findByTestId('bumper-player');
    expect(played.at(-1)?.inputProps.images).toEqual([IMAGES[0], IMAGES[1], IMAGES[2], `${IMAGES[0]}#repeat-2`]);
  });

  it('plays nothing when the label has no images or cannot be loaded', async () => {
    const empty = stubLabelFetch([]);
    const first = render(<ModoItalianoGiorgiaArtistBumper artist='ROB' songTitle='x' labelId='rob' images={IMAGES} />);
    await vi.waitFor(() => expect(empty).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.container.innerHTML).toBe('');
    first.unmount();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = stubLabelFetch([], false);
    const second = render(<ModoItalianoGiorgiaArtistBumper artist='ROB' songTitle='x' labelId='rob' images={IMAGES} />);
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
    expect(failing).toHaveBeenCalled();
    expect(second.container.innerHTML).toBe('');
    expect(played).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it('renders nothing while hidden or incomplete', () => {
    const cases = [
      <ModoItalianoGiorgiaArtistBumper key='hidden' show={false} artist='ROB' songTitle='x' images={IMAGES} />,
      <ModoItalianoGiorgiaArtistBumper key='images' artist='ROB' songTitle='x' images={IMAGES.slice(0, 3)} />,
      <ModoItalianoGiorgiaArtistBumper key='artist' artist='' songTitle='x' images={IMAGES} />,
      <ModoItalianoGiorgiaArtistBumper key='title' artist='ROB' images={IMAGES} />
    ];
    for (const element of cases) {
      const { container, unmount } = render(element);
      expect(container.innerHTML).toBe('');
      unmount();
    }
    expect(played).toHaveLength(0);
  });

  it('restarts the player only when the content changes', async () => {
    const { rerender } = render(<ModoItalianoGiorgiaArtistBumper artist='ROB' songTitle='Cento ragazze' images={IMAGES} />);
    const first = await screen.findByTestId('bumper-player');
    rerender(<ModoItalianoGiorgiaArtistBumper artist='ROB' songTitle='Cento ragazze' images={[...IMAGES]} />);
    expect(screen.getByTestId('bumper-player')).toBe(first);
    rerender(<ModoItalianoGiorgiaArtistBumper artist='Mina' songTitle='Cento ragazze' images={IMAGES} />);
    expect(screen.getByTestId('bumper-player')).not.toBe(first);
  });
});

describe('ModoItalianoGiorgiaArtistBumperEditorFields', () => {
  const editor = (props: Record<string, unknown>, mediaLabels: MediaLabel[] = [], updateProp = vi.fn(), isLoadingMediaLabels = false) => {
    render(<ModoItalianoGiorgiaArtistBumperEditorFields componentType={TYPE} props={props} updateProp={updateProp} mediaLabels={mediaLabels} isLoadingMediaLabels={isLoadingMediaLabels} />);
    return updateProp;
  };

  it('edits one hand-set image without losing the others, and says what is missing', () => {
    const updateProp = editor({ artist: 'ROB', songTitle: 'Cento ragazze', images: [IMAGES[0], '', IMAGES[2]], creditLines: ['Uno'] });
    expect(screen.getByRole('status').textContent).toContain('Add four different images.');
    const second = screen.getByLabelText('Image 2 URL') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(second, IMAGES[1]);
    second.dispatchEvent(new Event('input', { bubbles: true }));
    expect(updateProp).toHaveBeenLastCalledWith(TYPE, 'images', [IMAGES[0], IMAGES[1], IMAGES[2], '']);
  });

  it('offers no audio, eyebrow or site address fields', () => {
    editor({ artist: 'ROB', songTitle: 'Cento ragazze', images: IMAGES });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByLabelText('Audio URL')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Eyebrow|Site address|Audio/);
  });

  it('with a label, hides the hand-set images and previews the four it will use', () => {
    const video = { position: 1, asset: { id: 'v', mediaType: 'VIDEO' as const, name: 'Clip', sourceUrl: 'https://label.test/clip.mp4' } };
    editor({ artist: 'ROB', songTitle: 'Cento ragazze', labelId: 'rob', images: [] }, [label('rob', [...IMAGES, 'https://img.test/5.jpg'], [video])]);
    expect(screen.queryByLabelText('Image 1 URL')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getAllByAltText(/^Label image \d$/).map((image) => image.getAttribute('src'))).toEqual(IMAGES);
    expect(document.body.textContent).toContain('first four different images of this label');
  });

  it('says when a short label repeats, warns when it is empty, and stays quiet while labels load', () => {
    editor({ artist: 'ROB', songTitle: 'Cento ragazze', labelId: 'rob', images: [] }, [label('rob', IMAGES.slice(0, 3))]);
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.body.textContent).toContain('This label has 3 images, so they repeat to fill the four cuts.');
    expect(screen.getAllByAltText(/^Label image \d$/)).toHaveLength(4);
    cleanup();
    editor({ artist: 'ROB', songTitle: 'Cento ragazze', labelId: 'rob', images: IMAGES }, [label('rob', [])]);
    expect(screen.getByRole('status').textContent).toContain('The label has no images.');
    cleanup();
    editor({ artist: 'ROB', songTitle: 'Cento ragazze', labelId: 'rob', images: [] }, [], vi.fn(), true);
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.body.textContent).toContain('Loading labels...');
  });

  // gaulatti/alcantara#186
  it('says a one-image label repeats it, and shows the saved show setting', () => {
    const updateProp = editor({ show: false, artist: 'ROB', songTitle: 'Cento ragazze', labelId: 'rob', images: [] }, [label('rob', [IMAGES[0]])]);
    expect(document.body.textContent).toContain('This label has 1 image, so it repeats to fill the four cuts.');
    const show = screen.getByRole('checkbox', { name: 'Show bumper' });
    expect(show).not.toBeChecked();
    fireEvent.click(show);
    expect(updateProp).toHaveBeenCalledWith(TYPE, 'show', true);
  });
});

// gaulatti/alcantara#527 (bumper, untriaged gaps): a label whose images arrive after the bumper has gone, and a
// label response with no image list.
describe('ModoItalianoGiorgiaArtistBumper label loading', () => {
  it('ignores a label response that arrives after the bumper has been removed', async () => {
    let release!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve)))
    );
    const view = render(<ModoItalianoGiorgiaArtistBumper artist='ROB' songTitle='x' labelId='rob' images={IMAGES} />);
    view.unmount();
    release({ ok: true, status: 200, json: async () => ({ id: 'rob', name: 'ROB', images: [] }) } as Response);
    await Promise.resolve();
    await Promise.resolve();
    expect(played).toHaveLength(0);
  });

  it('says a label response without an image list has no images, and plays nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 'rob', name: 'ROB' }) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ModoItalianoGiorgiaArtistBumper artist='ROB' songTitle='x' labelId='rob' images={IMAGES} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(played).toHaveLength(0);
    expect(screen.queryByTestId('bumper-player')).toBeNull();
  });
});
