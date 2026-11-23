import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChyronHolder } from './ChyronHolder';

// gaulatti/alcantara#183: the generic on-air chyron.

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('shows nothing until it is shown with text', () => {
  const view = render(<ChyronHolder text='Breaking' />);
  expect(view.container).toBeEmptyDOMElement();
  view.rerender(<ChyronHolder show />);
  expect(view.container).toBeEmptyDOMElement();
  view.rerender(<ChyronHolder show text='Breaking' />);
  expect(screen.getByText('Breaking').closest('.chyron-holder')).toHaveClass('chyron-visible');
});

it('fades the old text out before showing new text', () => {
  const view = render(<ChyronHolder show text='First line' />);
  view.rerender(<ChyronHolder show text='Second line' />);
  const text = screen.getByText('First line');
  expect(text).toHaveClass('is-changing');
  act(() => vi.advanceTimersByTime(300));
  expect(screen.getByText('Second line')).not.toHaveClass('is-changing');
});

it('hides when it is taken off air', () => {
  const view = render(<ChyronHolder show text='Breaking' />);
  view.rerender(<ChyronHolder show={false} text='Breaking' />);
  expect(view.container).toBeEmptyDOMElement();
});
