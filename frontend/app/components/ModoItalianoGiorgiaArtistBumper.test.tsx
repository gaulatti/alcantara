import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ModoItalianoGiorgiaArtistBumper,
  describeArtistBumperProblem,
  resolveArtistBumperImages
} from './ModoItalianoGiorgiaArtistBumper';
import { ModoItalianoGiorgiaArtistBumperEditorFields } from './editors/ModoItalianoGiorgiaArtistBumperEditorFields';

// The real player needs a browser; record what the bumper hands to Giorgia instead.
const played = vi.hoisted(() => [] as Array<{ inputProps: Record<string, unknown>; masterGain: number }>);
vi.mock('./ModoItalianoGiorgiaArtistBumperPlayer', () => ({
  default: (props: { inputProps: Record<string, unknown>; masterGain: number }) => {
    played.push(props);
    return <div data-testid='bumper-player' />;
  }
}));

afterEach(() => {
  cleanup();
  played.length = 0;
});

const IMAGES = ['https://img.test/1.jpg', 'https://img.test/2.jpg', 'https://img.test/3.jpg', 'https://img.test/4.jpg'];

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

describe('describeArtistBumperProblem', () => {
  it('names the first thing missing, and nothing when complete', () => {
    expect(describeArtistBumperProblem({ artist: ' ', songTitle: 'x', images: IMAGES })).toBe('Add the artist.');
    expect(describeArtistBumperProblem({ artist: 'ROB', songTitle: '', images: IMAGES })).toBe('Add the song title.');
    expect(describeArtistBumperProblem({ artist: 'ROB', songTitle: 'x', images: [] })).toBe('Add four different images.');
    expect(describeArtistBumperProblem({ artist: 'ROB', songTitle: 'x', images: IMAGES })).toBeNull();
  });
});

describe('ModoItalianoGiorgiaArtistBumper', () => {
  it('hands Giorgia the trimmed content and leaves blank optional fields to its defaults', async () => {
    render(<ModoItalianoGiorgiaArtistBumper artist=' ROB ' songTitle=' Cento ragazze ' images={IMAGES} audioUrl=' ' eyebrow='' creditLines={['', '']} masterGain={0.5} />);
    await screen.findByTestId('bumper-player');
    expect(played.at(-1)).toEqual({
      inputProps: { artist: 'ROB', songTitle: 'Cento ragazze', images: IMAGES, audioUrl: null },
      masterGain: 0.5
    });
  });

  it('passes the optional fields through when they are set', async () => {
    render(
      <ModoItalianoGiorgiaArtistBumper
        artist='ROB'
        songTitle='Cento ragazze'
        images={IMAGES}
        audioUrl='https://audio.test/a.mp3'
        eyebrow='ModoItaliano presenta'
        contentType='Singolo'
        creditLines={['Warner Music Italy · 2025']}
        siteUrl='modoitaliano.fm'
      />
    );
    await screen.findByTestId('bumper-player');
    expect(played.at(-1)?.inputProps).toEqual({
      artist: 'ROB',
      songTitle: 'Cento ragazze',
      images: IMAGES,
      audioUrl: 'https://audio.test/a.mp3',
      eyebrow: 'ModoItaliano presenta',
      contentType: 'Singolo',
      creditLines: ['Warner Music Italy · 2025', ''],
      siteUrl: 'modoitaliano.fm'
    });
    expect(played.at(-1)?.masterGain).toBe(1);
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

  it('restarts the player when the content changes', async () => {
    const { rerender } = render(<ModoItalianoGiorgiaArtistBumper artist='ROB' songTitle='Cento ragazze' images={IMAGES} />);
    const first = await screen.findByTestId('bumper-player');
    rerender(<ModoItalianoGiorgiaArtistBumper artist='ROB' songTitle='Cento ragazze' images={IMAGES} masterGain={0.2} />);
    expect(screen.getByTestId('bumper-player')).toBe(first);
    rerender(<ModoItalianoGiorgiaArtistBumper artist='Mina' songTitle='Cento ragazze' images={IMAGES} />);
    expect(screen.getByTestId('bumper-player')).not.toBe(first);
  });
});

describe('ModoItalianoGiorgiaArtistBumperEditorFields', () => {
  it('edits one image or credit line without losing the others, and says what is missing', () => {
    const updateProp = vi.fn();
    render(
      <ModoItalianoGiorgiaArtistBumperEditorFields
        componentType='modoitaliano-giorgia-artist-bumper'
        props={{ artist: 'ROB', songTitle: 'Cento ragazze', images: [IMAGES[0], '', IMAGES[2]], creditLines: ['Uno'] }}
        updateProp={updateProp}
      />
    );
    expect(screen.getByRole('status').textContent).toContain('Add four different images.');

    const second = screen.getByLabelText('Image 2 URL') as HTMLInputElement;
    expect(second.value).toBe('');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(second, IMAGES[1]);
    second.dispatchEvent(new Event('input', { bubbles: true }));
    expect(updateProp).toHaveBeenLastCalledWith('modoitaliano-giorgia-artist-bumper', 'images', [IMAGES[0], IMAGES[1], IMAGES[2], '']);
  });

  it('shows no warning once the bumper can play', () => {
    render(
      <ModoItalianoGiorgiaArtistBumperEditorFields
        componentType='modoitaliano-giorgia-artist-bumper'
        props={{ artist: 'ROB', songTitle: 'Cento ragazze', images: IMAGES }}
        updateProp={vi.fn()}
      />
    );
    expect(screen.queryByRole('status')).toBeNull();
  });
});
