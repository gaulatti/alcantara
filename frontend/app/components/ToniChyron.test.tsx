import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FifthBellChyron, ToniChyron } from './ToniChyron';

// gaulatti/alcantara#183: the FifthBell (Toni) chyron.

const NOW = Date.parse('2026-11-17T15:00:00Z');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const slug = (container: HTMLElement) => container.querySelector('.toni-chyron-slug-text')!;
const activeHandle = (container: HTMLElement) => container.querySelector('.toni-chyron-social--active');

it('keeps the legacy name for the same chyron', () => {
  expect(ToniChyron).toBe(FifthBellChyron);
});

it('shows the text with an alternating EN VIVO / LIVE label and rotating handles', () => {
  const view = render(<FifthBellChyron show text='Sanremo, última hora' />);
  expect(screen.getByText('Sanremo, última hora')).toHaveClass('toni-chyron-text');
  expect(slug(view.container)).toHaveTextContent('EN VIVO');
  expect(activeHandle(view.container)).toHaveTextContent('@modoitaliano.oficial');
  act(() => vi.advanceTimersByTime(4000));
  expect(slug(view.container)).toHaveClass('toni-chyron-slug-text--fading');
  expect(activeHandle(view.container)).toHaveTextContent('@fifth.bell');
  act(() => vi.advanceTimersByTime(350));
  expect(slug(view.container)).toHaveTextContent('LIVE');
  expect(slug(view.container)).not.toHaveClass('toni-chyron-slug-text--fading');
  act(() => vi.advanceTimersByTime(8000));
  expect(activeHandle(view.container)).toHaveTextContent('@modoitaliano.oficial');
});

it('keeps a forced label and scrolls marquee text', () => {
  const view = render(<FifthBellChyron show text='Long headline' label='ESCLUSIVA' useMarquee />);
  act(() => vi.advanceTimersByTime(8000));
  expect(slug(view.container)).toHaveTextContent('ESCLUSIVA');
  expect(screen.getByText('Long headline')).toHaveClass('marquee');
});

it('shows only valid configured handles, and none when the list is empty', () => {
  const view = render(<FifthBellChyron show text='Headline' socialHandles={[' @one ', 7, '', '@two']} />);
  expect([...view.container.querySelectorAll('.toni-chyron-social')].map((node) => node.textContent)).toEqual(['@one', '@two']);
  view.rerender(<FifthBellChyron show text='Headline' socialHandles={['@only']} />);
  act(() => vi.advanceTimersByTime(8000));
  expect(activeHandle(view.container)).toHaveTextContent('@only');
  view.rerender(<FifthBellChyron show text='Headline' socialHandles={[]} />);
  expect(view.container.querySelector('.toni-chyron-social-stack')).toBeNull();
});

it('plays an autoplay sequence, fading between items', () => {
  const sequence = {
    mode: 'autoplay',
    intervalMs: 2000,
    startedAt: NOW,
    items: [
      { id: 'a', kind: 'preset', text: 'First item' },
      { id: 'b', kind: 'preset', text: 'Second item' },
    ],
  };
  render(<FifthBellChyron show sequence={sequence} />);
  expect(screen.getByText('First item')).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.getByText('First item')).toHaveClass('is-changing');
  act(() => vi.advanceTimersByTime(300));
  expect(screen.getByText('Second item')).not.toHaveClass('is-changing');
});

it('falls back to the text when sequence mode has no sequence', () => {
  render(<FifthBellChyron show text='Plain text' contentMode='sequence' />);
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByText('Plain text')).toBeInTheDocument();
});

it('shows nothing off air or without text', () => {
  expect(render(<FifthBellChyron text='Headline' />).container).toBeEmptyDOMElement();
  cleanup();
  expect(render(<FifthBellChyron show />).container).toBeEmptyDOMElement();
});
