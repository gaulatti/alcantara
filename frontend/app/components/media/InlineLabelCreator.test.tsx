import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { InlineLabelCreator } from './InlineLabelCreator';
import { showAlert } from '@gaulatti/bleecker';

// gaulatti/alcantara#186: creating a Library label inline.

vi.mock('@gaulatti/bleecker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaulatti/bleecker')>()),
  showAlert: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.mocked(showAlert).mockReset();
});

it('creates a trimmed label and clears the field', async () => {
  let finish!: () => void;
  const onCreate = vi.fn(() => new Promise<void>((done) => (finish = done)));
  render(<InlineLabelCreator onCreate={onCreate} />);
  const name = screen.getByRole('textbox', { name: 'New label name' });
  const create = screen.getByRole('button', { name: 'Create and select' });
  expect(create).toBeDisabled();
  fireEvent.change(name, { target: { value: '  Ballads  ' } });
  fireEvent.click(create);
  expect(onCreate).toHaveBeenCalledWith('Ballads');
  expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();
  await act(async () => finish());
  expect(name).toHaveValue('');
});

it('ignores a blank name and alerts when creation fails', async () => {
  const onCreate = vi
    .fn()
    .mockRejectedValueOnce(new Error('Label already exists'))
    .mockRejectedValueOnce('offline');
  render(<InlineLabelCreator onCreate={onCreate} />);
  const name = screen.getByRole('textbox', { name: 'New label name' });
  fireEvent.change(name, { target: { value: '   ' } });
  fireEvent.submit(name.closest('form')!);
  expect(onCreate).not.toHaveBeenCalled();

  fireEvent.change(name, { target: { value: 'Ballads' } });
  await act(async () => {
    fireEvent.submit(name.closest('form')!);
  });
  expect(showAlert).toHaveBeenLastCalledWith('Label already exists', 'error');
  expect(name).toHaveValue('Ballads');
  await act(async () => {
    fireEvent.submit(name.closest('form')!);
  });
  expect(showAlert).toHaveBeenLastCalledWith('Failed to create label.', 'error');
});
