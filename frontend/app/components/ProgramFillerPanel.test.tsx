import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AxiosError, AxiosHeaders } from 'axios';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProgramFillerPanel } from './ProgramFillerPanel';
import { FILLER_FIXTURE } from './fillerFixture';
import { api } from '../services/api';

// gaulatti/alcantara#127: the operator view of the #126 filler API, built
// reader-first against the pinned fixture.

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

const ASSETS = {
  IMAGE: [
    { id: 'media:7', name: 'Station slate', mediaType: 'IMAGE', enabled: true },
    { id: 'media:9', name: 'Old slate', mediaType: 'IMAGE', enabled: false },
  ],
  VIDEO: [{ id: 'media:3', name: 'Night loop', mediaType: 'VIDEO', enabled: true }],
  AUDIO: [
    { id: 'song:1', name: 'Track one', mediaType: 'AUDIO', enabled: true },
    { id: 'song:2', name: 'Track two', mediaType: 'AUDIO', enabled: true },
  ],
} as const;

function httpError(status: number, data: unknown = {}) {
  return new AxiosError('Request failed', String(status), undefined, undefined, {
    status,
    statusText: String(status),
    data,
    headers: {},
    config: { headers: new AxiosHeaders() },
  });
}

let state = structuredClone(FILLER_FIXTURE);
beforeEach(() => {
  state = structuredClone(FILLER_FIXTURE);
  vi.spyOn(api, 'get').mockImplementation((url: string, config?: any) => {
    if (url === '/media-assets') {
      return Promise.resolve({ data: { data: ASSETS[config.params.mediaType as keyof typeof ASSETS] } });
    }
    return Promise.resolve({ data: state });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('renders nothing against a backend without the filler API', async () => {
  vi.mocked(api.get).mockRejectedValue(httpError(404));
  const view = render(<ProgramFillerPanel programId="both-1" canManage />);
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/broadcast/programs/both-1/fillers'));
  // The panel still shows its loading state until the refusal is handled, which a busy runner can reach later.
  await waitFor(() => expect(view.container).toBeEmptyDOMElement());
});

it('shows the active and pending version of each leg without controls for a viewer', async () => {
  render(<ProgramFillerPanel programId="both-1" canManage={false} />);
  const television = await screen.findByLabelText('Television filler');
  expect(television).toHaveTextContent('filler-tv-0c8e1b3a-1f2e-4c5d-8a9b-6e7f8a9b0c1d');
  expect(television).toHaveTextContent('filler-tv-2b1f0c1e-7a1d-4d2f-9f3e-3c7b5a1e9d42');
  expect(television).toHaveTextContent('9f1c4e2a7b3d');
  const radio = screen.getByLabelText('Radio filler');
  expect(radio).toHaveTextContent('shuffle, seed rotation-7');
  expect(radio).toHaveTextContent('song:1, song:2');
  expect(radio).toHaveTextContent('None');
  expect(screen.queryByRole('button', { name: /Prepare/ })).not.toBeInTheDocument();
  expect(api.get).toHaveBeenCalledTimes(1);
});

it('shows only the legs the program has', async () => {
  state = { programId: 'tv-1', legs: { television: { pending: null, active: null } } };
  render(<ProgramFillerPanel programId="tv-1" canManage={false} />);
  expect(await screen.findByLabelText('Television filler')).toHaveTextContent('None');
  expect(screen.queryByLabelText('Radio filler')).not.toBeInTheDocument();
});

it('prepares a television filler from an enabled image or video and shows the result', async () => {
  const put = vi.spyOn(api, 'put').mockImplementation(() => {
    const next = structuredClone(state);
    next.legs.television!.pending!.version = 'filler-tv-new';
    return Promise.resolve({ data: next });
  });
  render(<ProgramFillerPanel programId="both-1" canManage />);
  const source = await screen.findByLabelText('Television filler source');
  await waitFor(() => expect(screen.getByRole('option', { name: 'Night loop' })).toBeInTheDocument());
  expect(screen.queryByRole('option', { name: 'Old slate' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Television filler')).toHaveTextContent('Night loop');
  fireEvent.change(source, { target: { value: 'media:7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Prepare television filler' }));
  await waitFor(() => expect(screen.getByLabelText('Television filler')).toHaveTextContent('filler-tv-new'));
  expect(put).toHaveBeenCalledWith('/broadcast/programs/both-1/fillers/television', { assetId: 'media:7' });
});

it('prepares a shuffled radio filler and keeps the selection when preparation fails', async () => {
  const put = vi
    .spyOn(api, 'put')
    .mockRejectedValueOnce(httpError(502, { message: 'Palazzo could not prepare the radio filler', error: 'Bad Gateway' }))
    .mockResolvedValueOnce({ data: state });
  render(<ProgramFillerPanel programId="both-1" canManage />);
  fireEvent.click(await screen.findByLabelText('Track two'));
  fireEvent.click(screen.getByLabelText('Track one'));
  fireEvent.change(screen.getByLabelText('Radio filler order'), { target: { value: 'shuffle' } });
  const prepare = screen.getByRole('button', { name: 'Prepare radio filler' });
  expect(prepare).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Shuffle seed'), { target: { value: 'night-1' } });
  fireEvent.click(prepare);
  expect(await screen.findByRole('alert')).toHaveTextContent('Palazzo could not prepare the radio filler');
  expect(screen.getByLabelText('Track two')).toBeChecked();
  expect(screen.getByLabelText('Shuffle seed')).toHaveValue('night-1');
  fireEvent.click(prepare);
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(put).toHaveBeenLastCalledWith('/broadcast/programs/both-1/fillers/radio', {
    assetIds: ['song:2', 'song:1'],
    mode: 'shuffle',
    shuffleSeed: 'night-1',
  });
  fireEvent.click(screen.getByLabelText('Track one'));
  fireEvent.change(screen.getByLabelText('Radio filler order'), { target: { value: 'ordered' } });
  expect(screen.queryByLabelText('Shuffle seed')).not.toBeInTheDocument();
});

it('reports a failed state read or media read without inventing a ready state', async () => {
  vi.mocked(api.get).mockRejectedValueOnce(httpError(503, { message: 'television live profile unavailable' }));
  render(<ProgramFillerPanel programId="both-1" canManage />);
  expect(await screen.findByRole('alert')).toHaveTextContent('television live profile unavailable');
  expect(screen.queryByLabelText('Television filler')).not.toBeInTheDocument();
  cleanup();
  vi.mocked(api.get).mockImplementation((url: string) =>
    url === '/media-assets' ? Promise.reject(httpError(403)) : Promise.resolve({ data: state }),
  );
  render(<ProgramFillerPanel programId="both-1" canManage />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Access denied');
});

// gaulatti/alcantara#184: the remaining states an operator can see.

it('shows why a version failed and that it is not prepared yet', async () => {
  state.legs.television!.pending = {
    ...state.legs.television!.pending!,
    status: 'failed',
    reason: 'asset unavailable',
    preparedAt: null,
  };
  render(<ProgramFillerPanel programId="both-1" canManage={false} />);
  const television = await screen.findByLabelText('Television filler');
  expect(television).toHaveTextContent('failed (asset unavailable)');
  expect(television).toHaveTextContent('Not prepared');
});

it('offers only images and videos to a television-only program', async () => {
  state = { programId: 'tv-1', legs: { television: { pending: null, active: null } } };
  render(<ProgramFillerPanel programId="tv-1" canManage />);
  await screen.findByLabelText('Television filler source');
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
  const types = vi
    .mocked(api.get)
    .mock.calls.filter(([url]) => url === '/media-assets')
    .map(([, config]) => (config as any).params.mediaType);
  expect(types).toEqual(['IMAGE', 'VIDEO']);
});

it('prepares an ordered radio filler for a radio-only program', async () => {
  state = { programId: 'radio-1', legs: { radio: { pending: null, active: null } } };
  const put = vi.spyOn(api, 'put').mockResolvedValue({ data: state });
  render(<ProgramFillerPanel programId="radio-1" canManage />);
  fireEvent.click(await screen.findByLabelText('Track one'));
  expect(screen.queryByLabelText('Television filler source')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Prepare radio filler' }));
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith('/broadcast/programs/radio-1/fillers/radio', {
      assetIds: ['song:1'],
      mode: 'ordered',
    }),
  );
  const types = vi
    .mocked(api.get)
    .mock.calls.filter(([url]) => url === '/media-assets')
    .map(([, config]) => (config as any).params.mediaType);
  expect(types).toEqual(['AUDIO']);
});

it('shows the shared failure message for an error that is not an HTTP response', async () => {
  vi.mocked(api.get).mockRejectedValueOnce(new Error('connection reset'));
  render(<ProgramFillerPanel programId="both-1" canManage />);
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(screen.getByRole('alert').textContent).not.toContain('connection reset');
});

it('says a leg needs preparing again after a rename left it with nothing prepared', async () => {
  state = {
    programId: 'both-1',
    legs: { radio: { pending: null, active: null, needsPreparing: true } },
  } as typeof state;
  render(<ProgramFillerPanel programId="both-1" canManage={false} />);
  expect(await screen.findByText('Filler needs preparing again')).toBeInTheDocument();
});
