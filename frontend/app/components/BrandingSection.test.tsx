import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrandingSection, logoError } from './BrandingSection';

const stored = {
  displayName: 'Fictional station',
  callsign: 'FS-1',
  subtitle: null,
  logoUrl: 'https://media.example.test/logo.png',
  hashtag: null,
  siteUrl: null,
  defaultChyron: null,
};

describe('BrandingSection', () => {
  let calls: { method: string; body?: string }[];

  beforeEach(() => {
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? 'GET', body: init?.body as string | undefined });
        if (init?.method === 'PUT') return new Response(JSON.stringify({ ...stored, callsign: 'FS-2' }), { status: 200 });
        return new Response(JSON.stringify(stored), { status: 200 });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the stored marks for the program', async () => {
    render(<BrandingSection programId='fictional-main' />);
    expect(await screen.findByDisplayValue('Fictional station')).toBeInTheDocument();
    expect(screen.getByDisplayValue('FS-1')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Branding' })).toBeInTheDocument();
    expect(calls[0]).toMatchObject({ method: 'GET' });
  });

  it('shows the stored logo as a preview and its address, and offers no typed address', async () => {
    render(<BrandingSection programId='fictional-main' />);
    expect(await screen.findByRole('img', { name: 'Current logo' })).toHaveAttribute('src', 'https://media.example.test/logo.png');
    expect(screen.getByText('https://media.example.test/logo.png')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('https://media.example.test/logo.png')).toBeNull();
    expect(screen.getByRole('group', { name: 'Logo' })).toBeInTheDocument();
  });

  it('saves the marks once and shows the stored result', async () => {
    render(<BrandingSection programId='fictional-main' />);
    const callsign = await screen.findByDisplayValue('FS-1');
    fireEvent.change(callsign, { target: { value: 'FS-2' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));
    });
    await waitFor(() => expect(screen.getByDisplayValue('FS-2')).toBeInTheDocument());
    const puts = calls.filter((call) => call.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0].body ?? '{}')).toMatchObject({ callsign: 'FS-2', displayName: 'Fictional station' });
  });

  it('accepts an empty logo and an https logo', () => {
    expect(logoError('')).toBeNull();
    expect(logoError('https://media.example.test/a.png')).toBeNull();
    expect(logoError('ftp://media.example.test/a.png')).toBe('The logo must be an https address.');
  });
});

describe('BrandingSection failures and cleared marks', () => {
  let puts: string[];

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('says so when the stored branding cannot be loaded, and still offers the empty form', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 500 })));
    render(<BrandingSection programId='fictional-main' />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The branding could not be loaded.');
    expect(screen.getByRole('button', { name: 'Save branding' })).toBeEnabled();
  });

  it('reads a program with no stored branding as empty marks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('null', { status: 200 })));
    render(<BrandingSection programId='fictional-main' />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save branding' })).toBeEnabled());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Callsign')).toHaveValue('');
  });

  it('says so when the save is refused, and leaves the marks as typed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') return new Response('refused', { status: 500 });
        return new Response(JSON.stringify({ displayName: 'Fictional station' }), { status: 200 });
      }),
    );
    render(<BrandingSection programId='fictional-main' />);
    fireEvent.change(await screen.findByLabelText('Callsign'), { target: { value: 'FS-9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The branding could not be saved.');
    expect(screen.getByLabelText('Callsign')).toHaveValue('FS-9');
    expect(screen.getByRole('button', { name: 'Save branding' })).toBeEnabled();
  });

  it('sends a cleared mark as null, including a cleared logo, and saves a program with no logo', async () => {
    puts = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          puts.push(init.body as string);
          return new Response(JSON.stringify({}), { status: 200 });
        }
        return new Response(JSON.stringify({ displayName: 'Fictional station', callsign: 'FS-1', logoUrl: null }), { status: 200 });
      }),
    );
    render(<BrandingSection programId='fictional-main' />);
    fireEvent.change(await screen.findByLabelText('Callsign'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(JSON.parse(puts[0])).toMatchObject({ callsign: null, logoUrl: null });
  });

  it('clears a stored logo to null with Remove logo', async () => {
    puts = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          puts.push(init.body as string);
          return new Response(JSON.stringify({}), { status: 200 });
        }
        return new Response(JSON.stringify({ logoUrl: 'https://media.example.test/logo.png' }), { status: 200 });
      }),
    );
    render(<BrandingSection programId='fictional-main' />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove logo' }));
    expect(screen.getByText('No logo.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove logo' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(JSON.parse(puts[0])).toMatchObject({ logoUrl: null });
  });

  it('still refuses a stored address that is not https, and sends nothing', async () => {
    puts = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') puts.push(init.body as string);
        return new Response(JSON.stringify({ logoUrl: 'http://media.example.test/old.png' }), { status: 200 });
      }),
    );
    render(<BrandingSection programId='fictional-main' />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save branding' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The logo must be an https address.');
    expect(puts).toHaveLength(0);
  });
});

describe('BrandingSection logo from the media library', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('picks an https image, stores its public address, and clears an earlier logo error', async () => {
    const puts: string[] = [];
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        urls.push(url);
        if (url.includes('/media?')) {
          return new Response(
            JSON.stringify({
              data: [
                { id: 7, name: 'Fictional logo', imageUrl: 'https://media.example.test/fictional.png' },
                { id: 8, name: 'Old upload', imageUrl: 'http://media.example.test/old.png' },
              ],
            }),
            { status: 200 },
          );
        }
        if (init?.method === 'PUT') {
          puts.push(init.body as string);
          return new Response(init.body as string, { status: 200 });
        }
        return new Response(JSON.stringify({ logoUrl: 'http://media.example.test/stale.png' }), { status: 200 });
      }),
    );
    render(<BrandingSection programId='fictional-main' />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save branding' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The logo must be an https address.');

    fireEvent.click(screen.getByRole('button', { name: 'Choose from the media library' }));
    expect(await screen.findByRole('button', { name: 'Old upload (not an https address)' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Use Fictional logo' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('img', { name: 'Current logo' })).toHaveAttribute('src', 'https://media.example.test/fictional.png');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));
    });
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(JSON.parse(puts[0])).toMatchObject({ logoUrl: 'https://media.example.test/fictional.png' });
    expect(urls.some((url) => url.includes('/media?') && url.includes('limit=60'))).toBe(true);
  });

  it('closes the picker without changing the logo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/media?')
          ? new Response(JSON.stringify({ data: [] }), { status: 200 })
          : new Response(JSON.stringify({ logoUrl: 'https://media.example.test/logo.png' }), { status: 200 }),
      ),
    );
    render(<BrandingSection programId='fictional-main' />);
    fireEvent.click(await screen.findByRole('button', { name: 'Choose from the media library' }));
    expect(await screen.findByText('The media library has no images yet.')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('The media library has no images yet.')).toBeNull());
    expect(screen.getByRole('img', { name: 'Current logo' })).toHaveAttribute('src', 'https://media.example.test/logo.png');
  });
});
