import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModoItalianoChyron } from './ModoItalianoChyron';

// gaulatti/alcantara#183: the Modo Italiano chyron: fades on and off air,
// cross-fades text and call-to-action changes, and scrolls marquee text.

const NOW = Date.parse('2026-11-17T15:00:00Z');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const manual = (text: string, useMarquee = false) => ({
  mode: 'manual',
  items: [{ id: 'a', kind: 'preset', text, useMarquee }],
  activeItemId: 'a',
});
const autoplay = (...texts: string[]) => ({
  mode: 'autoplay',
  intervalMs: 1000,
  startedAt: NOW,
  items: texts.map((text, i) => ({ id: `i${i}`, kind: 'preset', text })),
});
const wrapper = (container: HTMLElement) => container.firstElementChild as HTMLElement;
const step = (ms: number) => act(() => vi.advanceTimersByTime(ms));

it('shows the headline in capitals with the call to action above it', () => {
  const view = render(<ModoItalianoChyron textSequence={manual('Ciao Sanremo')} ctaSequence={manual('In diretta')} />);
  expect(screen.getByText('CIAO SANREMO')).toBeInTheDocument();
  expect(screen.getByText('In diretta')).toBeInTheDocument();
  expect(wrapper(view.container).style.position).toBe('absolute');
  expect(wrapper(view.container).style.opacity).toBe('1');
});

it('fades in when it is put on air', () => {
  const view = render(<ModoItalianoChyron show={false} textSequence={manual('Ciao')} />);
  expect(view.container).toBeEmptyDOMElement();
  view.rerender(<ModoItalianoChyron textSequence={manual('Ciao')} />);
  expect(wrapper(view.container).style.opacity).toBe('0');
  step(250);
  expect(wrapper(view.container).style.opacity).toBe('1');
});

it('fills its container inline', () => {
  const view = render(<ModoItalianoChyron inline textSequence={manual('Ciao')} />);
  step(20);
  expect(wrapper(view.container).style.width).toBe('100%');
  expect(wrapper(view.container).style.position).toBe('');
});

it('cross-fades a new headline and call to action, keeping only the latest change', () => {
  const view = render(<ModoItalianoChyron textSequence={manual('First')} ctaSequence={manual('Soon')} />);
  step(20);
  view.rerender(<ModoItalianoChyron textSequence={manual('Second')} ctaSequence={manual('Now')} />);
  expect(screen.getByText('FIRST').style.opacity).toBe('0');
  expect(screen.getByText('Soon').style.opacity).toBe('0');
  step(100);
  view.rerender(<ModoItalianoChyron textSequence={manual('Third')} ctaSequence={manual('Later')} />);
  step(220);
  expect(screen.getByText('THIRD').style.opacity).toBe('1');
  expect(screen.getByText('Later').style.opacity).toBe('1');
  expect(screen.queryByText('SECOND')).toBeNull();
});

it('scrolls a marquee headline as two copies', () => {
  const view = render(<ModoItalianoChyron textSequence={manual('Hit parade', true)} ctaSequence={manual('Top 10')} />);
  step(20);
  expect(screen.getAllByText('HIT PARADE')).toHaveLength(2);
  expect(screen.getByText('Top 10')).toBeInTheDocument();
  view.rerender(<ModoItalianoChyron textSequence={manual('Hit parade', true)} />);
  step(220);
  expect(screen.queryByText('Top 10')).toBeNull();
});

it('fades off air and unmounts, and can come back before it is gone', () => {
  const view = render(<ModoItalianoChyron textSequence={manual('Ciao')} />);
  step(20);
  view.rerender(<ModoItalianoChyron show={false} textSequence={manual('Ciao')} />);
  expect(wrapper(view.container).style.opacity).toBe('0');
  step(100);
  // Back on air before the fade-out finished: it stays mounted.
  view.rerender(<ModoItalianoChyron textSequence={manual('Ciao')} />);
  // And off again before the fade-in frame ran.
  view.rerender(<ModoItalianoChyron show={false} textSequence={manual('Ciao')} />);
  step(220);
  expect(view.container).toBeEmptyDOMElement();
});

it('advances autoplay headline and call-to-action sequences', () => {
  render(<ModoItalianoChyron textSequence={autoplay('One', 'Two')} ctaSequence={autoplay('Soon', 'Now')} />);
  step(1000);
  step(220);
  expect(screen.getByText('TWO')).toBeInTheDocument();
  expect(screen.getByText('Now')).toBeInTheDocument();
});

it('shows nothing without a headline', () => {
  expect(render(<ModoItalianoChyron ctaSequence={manual('Soon')} />).container).toBeEmptyDOMElement();
});

it('cancels its pending fades when it leaves the page', () => {
  const view = render(<ModoItalianoChyron textSequence={manual('First')} ctaSequence={manual('Soon')} />);
  view.rerender(<ModoItalianoChyron textSequence={manual('Second')} ctaSequence={manual('Now')} />);
  view.rerender(<ModoItalianoChyron show={false} textSequence={manual('Second')} ctaSequence={manual('Now')} />);
  const clear = vi.spyOn(window, 'clearTimeout');
  view.unmount();
  expect(clear).toHaveBeenCalledTimes(3);
  const pending = vi.getTimerCount();
  step(1000);
  expect(vi.getTimerCount()).toBeLessThanOrEqual(pending);
});

it('cancels a pending fade-in frame when it leaves the page', () => {
  const view = render(<ModoItalianoChyron textSequence={manual('First')} />);
  const cancel = vi.spyOn(window, 'cancelAnimationFrame');
  view.unmount();
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('fades in inline too', () => {
  const view = render(<ModoItalianoChyron inline show={false} textSequence={manual('Ciao')} />);
  view.rerender(<ModoItalianoChyron inline textSequence={manual('Ciao')} />);
  expect(wrapper(view.container).style.opacity).toBe('0');
  expect(wrapper(view.container).style.transform).toBe('translateY(8px)');
  step(250);
  expect(wrapper(view.container).style.opacity).toBe('1');
});

it('fades a marquee headline out before scrolling the next one', () => {
  const view = render(<ModoItalianoChyron textSequence={manual('First', true)} />);
  view.rerender(<ModoItalianoChyron textSequence={manual('Second', true)} />);
  const scroller = screen.getAllByText('FIRST')[0].parentElement!.parentElement!;
  expect(scroller.style.opacity).toBe('0');
  expect(scroller.style.transform).toBe('translateY(10px)');
  step(220);
  expect(screen.getAllByText('SECOND')).toHaveLength(2);
});
