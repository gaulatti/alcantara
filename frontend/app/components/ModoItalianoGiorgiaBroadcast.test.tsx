import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ModoItalianoGiorgiaChyron } from './ModoItalianoGiorgiaChyron';
import { ModoItalianoGiorgiaClock } from './ModoItalianoGiorgiaClock';
import { fitGiorgiaText } from './giorgiaBroadcast';

afterEach(cleanup);

const sequence = (text: string, useMarquee = false) => ({ mode: 'manual', items: [{ id: 'a', text, useMarquee }], activeItemId: 'a' });

describe('fitGiorgiaText', () => {
  it('fits short text to the maximum and long text down to the minimum', () => {
    expect(fitGiorgiaText('ROB', 1000, 120, 76, 0.5)).toBe(120);
    expect(fitGiorgiaText('A'.repeat(20), 1000, 120, 76, 0.5)).toBe(100);
    expect(fitGiorgiaText('A'.repeat(200), 1000, 120, 76, 0.5)).toBe(76);
  });
});

describe('ModoItalianoGiorgiaChyron', () => {
  it('sets an uppercase headline on the signal rule without a box or an ellipsis', () => {
    const { container } = render(<ModoItalianoGiorgiaChyron show textSequence={sequence('Hola Sanremo')} ctaSequence={sequence('En directo')} />);
    const headline = container.querySelector<HTMLElement>('.modoitaliano-giorgia-chyron-headline');
    expect(headline?.textContent).toBe('HOLA SANREMO');
    expect(headline?.style.whiteSpace).toBe('nowrap');
    expect(headline?.style.textOverflow).toBe('');
    expect(container.querySelectorAll('[data-giorgia-rule]')).toHaveLength(1);
    expect(container.textContent).toContain('En directo');
    const block = container.querySelector<HTMLElement>('.modoitaliano-giorgia-chyron');
    expect(block?.style.borderRadius).toBe('');
    expect(block?.style.left).toBe('82px');
    expect(block?.style.bottom).toBe('70px');
  });

  it('wraps a headline that cannot fit one line instead of truncating it', () => {
    const { container } = render(<ModoItalianoGiorgiaChyron show textSequence={sequence('palabra '.repeat(12))} />);
    const headline = container.querySelector<HTMLElement>('.modoitaliano-giorgia-chyron-headline');
    expect(headline?.style.fontSize).toBe('76px');
    expect(headline?.style.whiteSpace).toBe('');
    expect(headline?.style.webkitLineClamp).toBe('2');
  });

  it('cuts hard: nothing renders when hidden or empty', () => {
    expect(render(<ModoItalianoGiorgiaChyron show={false} textSequence={sequence('Hola')} />).container.innerHTML).toBe('');
    expect(render(<ModoItalianoGiorgiaChyron show textSequence={sequence('   ')} />).container.innerHTML).toBe('');
  });

  it('builds the marquee from two identical halves', () => {
    const { container } = render(<ModoItalianoGiorgiaChyron show textSequence={sequence('Hola', true)} inline />);
    const halves = container.querySelectorAll<HTMLElement>('.modoitaliano-giorgia-chyron-marquee > span');
    expect(Array.from(halves).map((half) => [half.textContent, half.style.paddingRight])).toEqual([
      ['HOLA', '96px'],
      ['HOLA', '96px']
    ]);
    expect(container.querySelector<HTMLElement>('.modoitaliano-giorgia-chyron')?.style.position).toBe('relative');
  });
});

describe('ModoItalianoGiorgiaClock', () => {
  const song = { playingSong: true, songArtist: 'Giorgia', songTitle: 'La cura per me', songCoverUrl: '/cover.jpg' };

  it('renders the header top-left and the on-air block bottom-left, with the artist leading', () => {
    const { container } = render(<ModoItalianoGiorgiaClock programId='giorgia-test' {...song} />);
    const header = container.querySelector<HTMLElement>('.modoitaliano-giorgia-clock-header');
    expect(header?.style.top).toBe('68px');
    expect(header?.style.left).toBe('82px');
    expect(header?.querySelector('svg[aria-label="ModoItaliano"]')).not.toBeNull();
    expect(header?.textContent).toMatch(/^\d{2}:\d{2} IT$/);

    const onAir = container.querySelector<HTMLElement>('.modoitaliano-giorgia-clock-on-air');
    expect(onAir?.style.left).toBe('82px');
    expect(onAir?.style.bottom).toBe('70px');
    expect(onAir?.querySelector('.modoitaliano-giorgia-clock-hero')?.textContent).toBe('GIORGIA');
    expect(onAir?.textContent).toContain('LA CURA PER ME');
    expect(onAir?.textContent).toContain('Estás escuchando');
    expect(onAir?.querySelector('.modoitaliano-giorgia-clock-progress')).not.toBeNull();
  });

  it('renders each part on its own for the scene row', () => {
    const header = render(<ModoItalianoGiorgiaClock programId='giorgia-test' {...song} part='header' />).container;
    expect(header.querySelector('.modoitaliano-giorgia-clock-header')).not.toBeNull();
    expect(header.querySelector('.modoitaliano-giorgia-clock-on-air')).toBeNull();

    const onAir = render(<ModoItalianoGiorgiaClock programId='giorgia-test' {...song} part='onAir' inline showPlaybackProgress={false} />).container;
    expect(onAir.querySelector('.modoitaliano-giorgia-clock-header')).toBeNull();
    expect(onAir.querySelector<HTMLElement>('.modoitaliano-giorgia-clock-on-air')?.style.position).toBe('relative');
    expect(onAir.querySelector('.modoitaliano-giorgia-clock-progress')).toBeNull();
  });

  it('shows no on-air block without a song, and honours the logo and clock switches', () => {
    const idle = render(<ModoItalianoGiorgiaClock programId='giorgia-test' showLogo={false} />).container;
    expect(idle.querySelector('.modoitaliano-giorgia-clock-on-air')).toBeNull();
    expect(idle.querySelector('svg[aria-label="ModoItaliano"]')).toBeNull();

    const logoOnly = render(<ModoItalianoGiorgiaClock programId='giorgia-test' showWorldClocks={false} />).container;
    expect(logoOnly.querySelector('.modoitaliano-giorgia-clock-header')?.textContent).toBe('');

    expect(render(<ModoItalianoGiorgiaClock programId='giorgia-test' showWorldClocks={false} showLogo={false} {...song} />).container.innerHTML).toBe('');
  });
});
