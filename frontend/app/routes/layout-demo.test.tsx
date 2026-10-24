import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import BroadcastLayoutExample from './layout-demo';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('exercises the supported broadcast layout fixture through explicit caption selection, replacement and hide controls', () => {
  render(<BroadcastLayoutExample />);
  expect(screen.queryByText('LAS INTROS DEL FESTIVAL DE SANREMO')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show Title Message' }));
  act(() => vi.advanceTimersByTime(300));
  expect(screen.getByText('LAS INTROS DEL FESTIVAL DE SANREMO')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show Now Playing' }));
  act(() => vi.advanceTimersByTime(300));
  expect(screen.getByText('Ahora suena: Beautiful Song - Amazing Artist')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show Breaking News' }));
  act(() => vi.advanceTimersByTime(300));
  expect(screen.getByText('ULTIMA HORA: Noticia importante en desarrollo')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Hide Chyron' }));
  expect(screen.queryByText('ULTIMA HORA: Noticia importante en desarrollo')).not.toBeInTheDocument();
});
