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

  it('refuses an http logo and sends nothing', async () => {
    render(<BrandingSection programId='fictional-main' />);
    const logo = await screen.findByDisplayValue('https://media.example.test/logo.png');
    fireEvent.change(logo, { target: { value: 'http://media.example.test/logo.png' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The logo must be an https address.');
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
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
