import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModoItalianoGiorgiaChyron } from './ModoItalianoGiorgiaChyron';

// gaulatti/alcantara#183: the Giorgia headline over an autoplay sequence.

const NOW = Date.parse('2026-11-17T15:00:00Z');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const headline = (container: HTMLElement) => container.querySelector('h2');

it('advances an autoplay headline sequence on air', () => {
  const textSequence = {
    mode: 'autoplay',
    intervalMs: 1000,
    startedAt: NOW,
    items: [
      { id: 'a', text: 'Primo titolo' },
      { id: 'b', text: 'Secondo titolo' },
    ],
  };
  const view = render(<ModoItalianoGiorgiaChyron textSequence={textSequence} />);
  expect(headline(view.container)).toHaveTextContent('PRIMO TITOLO');
  act(() => vi.advanceTimersByTime(1000));
  expect(headline(view.container)).toHaveTextContent('SECONDO TITOLO');
});

it('shows nothing without a headline sequence', () => {
  expect(render(<ModoItalianoGiorgiaChyron />).container).toBeEmptyDOMElement();
});

it('fills its container inline instead of sitting over the safe area', () => {
  const textSequence = { mode: 'manual', items: [{ id: 'a', text: 'Ciao' }], activeItemId: 'a' };
  const view = render(<ModoItalianoGiorgiaChyron inline textSequence={textSequence} />);
  const block = view.getByLabelText('Modo Italiano Giorgia chyron');
  expect(block.style.position).toBe('relative');
  expect(block.style.width).toBe('100%');
});

it('drops the call-to-action shadow for a chroma-key scene', () => {
  const manual = (text: string) => ({ mode: 'manual', items: [{ id: 'a', text }], activeItemId: 'a' });
  const view = render(<ModoItalianoGiorgiaChyron keySafe textSequence={manual('Ciao')} ctaSequence={manual('In diretta')} />);
  expect(view.getByText('In diretta').style.textShadow).toBe('none');
});
