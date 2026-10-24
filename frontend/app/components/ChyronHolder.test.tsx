import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChyronHolder } from './ChyronHolder';

describe('ChyronHolder on-air state', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('keeps absent, empty and explicitly hidden chyrons off air', () => {
    const { rerender, container } = render(<ChyronHolder />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ChyronHolder show text='' />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ChyronHolder show text='Breaking news' />);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByText('Breaking news')).toBeInTheDocument();
    rerender(<ChyronHolder show={false} text='Breaking news' />);
    expect(container).toBeEmptyDOMElement();
  });

  it('retains the old caption during the animation then displays the latest complete text', () => {
    const { rerender } = render(<ChyronHolder show text='First caption' />);
    rerender(<ChyronHolder show text='Second caption' />);
    expect(screen.getByText('First caption')).toHaveClass('is-changing');
    act(() => vi.advanceTimersByTime(299));
    expect(screen.queryByText('Second caption')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText('Second caption')).not.toHaveClass('is-changing');
  });

  it('cancels stale caption timers when an operator changes the text again', () => {
    const { rerender, unmount } = render(<ChyronHolder show text='First' />);
    rerender(<ChyronHolder show text='Obsolete' />);
    act(() => vi.advanceTimersByTime(200));
    rerender(<ChyronHolder show text='Latest' />);
    act(() => vi.advanceTimersByTime(100));
    expect(screen.queryByText('Obsolete')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByText('Latest')).toBeInTheDocument();
    rerender(<ChyronHolder show text='Pending' />);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
