import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import routes from '../routes';
import Connect, { CLIENT_DOCS, MCP_URL } from './connect';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('/connect', () => {
  it('is a public route outside the protected layout', () => {
    const top = routes as unknown as { path?: string; file: string; children?: unknown[] }[];
    const connect = top.find((entry) => entry.path === 'connect');
    expect(connect?.file).toBe('routes/connect.tsx');
    expect(top.some((entry) => entry.file === 'routes/protected.tsx' && JSON.stringify(entry).includes('"connect"'))).toBe(false);
  });

  it('shows the MCP address and one official guide per client', () => {
    render(
      <MemoryRouter>
        <Connect />
      </MemoryRouter>,
    );
    expect(screen.getByText(MCP_URL)).toBeTruthy();
    for (const client of CLIENT_DOCS) {
      const link = screen.getByRole('link', { name: `${client.name}: official MCP guide` });
      expect(link.getAttribute('href')).toBe(client.href);
    }
  });

  it('copies the MCP address and reports the result', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(
      <MemoryRouter>
        <Connect />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy MCP URL' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied'));
    expect(writeText).toHaveBeenCalledWith(MCP_URL);
  });

  it('says so when the clipboard refuses', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    render(
      <MemoryRouter>
        <Connect />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy MCP URL' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Copy failed'));
  });
});
