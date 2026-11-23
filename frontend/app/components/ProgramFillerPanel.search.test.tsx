import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProgramFillerPanel } from './ProgramFillerPanel';
import { FILLER_FIXTURE } from './fillerFixture';
import { api } from '../services/api';

// gaulatti/alcantara#286: finding a song in the radio filler list.

vi.mock('@gaulatti/bleecker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gaulatti/bleecker')>();
  return {
    ...actual,
    Select: ({ options, onChange, value, ...props }: any) => (
      <select {...props} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
});

const AUDIO = [
  { id: 'song:1', name: 'Perché', mediaType: 'AUDIO', enabled: true },
  { id: 'song:2', name: 'Nel blu dipinto di blu', mediaType: 'AUDIO', enabled: true },
  { id: 'song:3', name: 'PERCHÈ no', mediaType: 'AUDIO', enabled: true },
  { id: 'song:4', name: 'Señorita', mediaType: 'AUDIO', enabled: true },
  { id: 'song:5', name: 'Hidden', mediaType: 'AUDIO', enabled: false },
];

beforeEach(() => {
  vi.spyOn(api, 'get').mockImplementation((url: string, config?: any) => {
    if (url === '/media-assets') {
      return Promise.resolve({ data: { data: config.params.mediaType === 'AUDIO' ? AUDIO : [] } });
    }
    return Promise.resolve({ data: structuredClone(FILLER_FIXTURE) });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function open() {
  render(<ProgramFillerPanel programId="both-1" canManage />);
  await screen.findByLabelText('Search radio filler songs');
  await screen.findByLabelText('Perché');
  return screen.getByLabelText('Radio filler sources');
}
const search = () => screen.getByLabelText('Search radio filler songs') as HTMLInputElement;

it('lists every enabled song with a count, and filters by what is typed, ignoring accents and case', async () => {
  const list = await open();
  expect(within(list).getAllByRole('checkbox')).toHaveLength(4);
  expect(screen.getByText('0 selected · 4 songs')).toBeInTheDocument();
  fireEvent.change(search(), { target: { value: 'perche' } });
  expect(within(list).getAllByRole('checkbox')).toHaveLength(2);
  expect(within(list).getByLabelText('Perché')).toBeInTheDocument();
  expect(within(list).getByLabelText('PERCHÈ no')).toBeInTheDocument();
  expect(screen.getByText('0 selected · 2 of 4 match')).toBeInTheDocument();
  fireEvent.change(search(), { target: { value: ' SENOR' } });
  expect(within(list).getAllByRole('checkbox')).toHaveLength(1);
  fireEvent.change(search(), { target: { value: 'blu dip' } });
  expect(within(list).getByLabelText('Nel blu dipinto di blu')).toBeInTheDocument();
});

it('says when nothing matches, and restores the whole list in its original order when cleared', async () => {
  const list = await open();
  const before = within(list).getAllByRole('checkbox').map((box) => box.getAttribute('aria-label'));
  fireEvent.change(search(), { target: { value: 'zzz' } });
  expect(within(list).queryAllByRole('checkbox')).toHaveLength(0);
  expect(screen.getByText('No songs match “zzz”.')).toBeInTheDocument();
  expect(screen.getByText('0 selected · 0 of 4 match')).toBeInTheDocument();
  fireEvent.change(search(), { target: { value: '' } });
  expect(within(list).getAllByRole('checkbox').map((box) => box.getAttribute('aria-label'))).toEqual(before);
  fireEvent.change(search(), { target: { value: '   ' } });
  expect(within(list).getAllByRole('checkbox')).toHaveLength(4);
});

it('keeps selected songs selected while filtered out and counts them in total, changing only the item clicked', async () => {
  const list = await open();
  fireEvent.click(within(list).getByLabelText('Señorita'));
  fireEvent.click(within(list).getByLabelText('Perché'));
  expect(screen.getByText('2 selected · 4 songs')).toBeInTheDocument();
  fireEvent.change(search(), { target: { value: 'blu' } });
  expect(within(list).queryByLabelText('Señorita')).toBeNull();
  expect(screen.getByText('2 selected · 1 of 4 match')).toBeInTheDocument();
  fireEvent.click(within(list).getByLabelText('Nel blu dipinto di blu'));
  expect(screen.getByText('3 selected · 1 of 4 match')).toBeInTheDocument();
  fireEvent.click(within(list).getByLabelText('Nel blu dipinto di blu'));
  fireEvent.change(search(), { target: { value: '' } });
  expect((within(list).getByLabelText('Señorita') as HTMLInputElement).checked).toBe(true);
  expect((within(list).getByLabelText('Perché') as HTMLInputElement).checked).toBe(true);
  expect((within(list).getByLabelText('Nel blu dipinto di blu') as HTMLInputElement).checked).toBe(false);
});

it('prepares the filler with the songs selected before and during the search', async () => {
  const put = vi.spyOn(api, 'put').mockResolvedValue({ data: structuredClone(FILLER_FIXTURE) });
  const list = await open();
  fireEvent.click(within(list).getByLabelText('Señorita'));
  fireEvent.change(search(), { target: { value: 'blu' } });
  fireEvent.click(within(list).getByLabelText('Nel blu dipinto di blu'));
  fireEvent.click(screen.getByRole('button', { name: /Prepare radio filler/ }));
  await waitFor(() => expect(put).toHaveBeenCalled());
  expect(put.mock.calls[0][1]).toMatchObject({ assetIds: ['song:4', 'song:2'] });
});

it('can be reached by keyboard and cleared with Escape, leaving a closed search alone', async () => {
  await open();
  search().focus();
  expect(document.activeElement).toBe(search());
  fireEvent.change(search(), { target: { value: 'blu' } });
  fireEvent.keyDown(search(), { key: 'a' });
  expect(search().value).toBe('blu');
  fireEvent.keyDown(search(), { key: 'Escape' });
  expect(search().value).toBe('');
  expect(screen.getByText('0 selected · 4 songs')).toBeInTheDocument();
  fireEvent.keyDown(search(), { key: 'Escape' });
  expect(search().value).toBe('');
});
