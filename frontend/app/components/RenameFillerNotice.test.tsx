// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../services/api';
import { RenameFillerNotice } from './RenameFillerNotice';

const SENTENCE = 'Its filler will need preparing again.';
const answer = (legs: object) => ({ data: { programId: 'news', legs } }) as never;
const prepared = { television: { pending: null, active: { version: 'v1' } } };
let get: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  get = vi.spyOn(api, 'get').mockResolvedValue(answer(prepared));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('says so only once the ID changes, for a show with prepared filler', async () => {
  const view = render(<RenameFillerNotice programId="news" nextProgramId="news" />);
  view.rerender(<RenameFillerNotice programId="news" nextProgramId="  " />);
  expect(get).not.toHaveBeenCalled();
  view.rerender(<RenameFillerNotice programId="news" nextProgramId="evening" />);
  expect(await screen.findByText(SENTENCE)).toBeInTheDocument();
  expect(get).toHaveBeenCalledWith('/broadcast/programs/news/fillers');
  view.rerender(<RenameFillerNotice programId="news" nextProgramId="news" />);
  expect(screen.queryByText(SENTENCE)).toBeNull();
});

it.each([
  ['no prepared filler', () => Promise.resolve(answer({ radio: { pending: null, active: null } }))],
  ['a filler state that cannot be read', () => Promise.reject(new Error('down'))],
])('says nothing for %s', async (_case, response) => {
  get.mockImplementation(response as never);
  render(<RenameFillerNotice programId="news" nextProgramId="evening" />);
  await waitFor(() => expect(get).toHaveBeenCalled());
  await Promise.resolve();
  expect(screen.queryByText(SENTENCE)).toBeNull();
});

it('ignores an answer that arrives after the dialog moved on', async () => {
  let resolve!: (value: never) => void;
  get.mockReturnValue(new Promise((done) => (resolve = done)) as never);
  const view = render(<RenameFillerNotice programId="news" nextProgramId="evening" />);
  view.unmount();
  resolve(answer(prepared));
  await Promise.resolve();
  expect(screen.queryByText(SENTENCE)).toBeNull();
});
