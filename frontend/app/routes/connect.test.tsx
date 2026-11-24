import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Connect, { meta } from './connect';

const URL_ = 'http://localhost:3000/mcp';

const rows = [
  { name: 'whoami', title: 'Who am I', description: 'Confirms the connection.', tier: 'R', permission: 'alcantara:access' },
  { name: 'queue_add', title: 'Add to the queue', description: 'Queues a song.', tier: 'W', permission: 'radio.queue' },
  { name: 'take_over', title: 'Take over', description: 'Goes on air.', tier: 'A', permission: 'radio.air' },
  { name: 'delete_song', title: 'Delete a song', description: 'Removes a song.', tier: 'D', permission: 'song.delete' },
];

function answer(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({ ok, status, json: async () => body });
}

beforeEach(() => {
  vi.stubGlobal('fetch', answer({ capabilities: rows }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Connect', () => {
  it('shows the MCP URL with a working Copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<Connect />);
    const box = screen.getByTestId('mcp-url');
    expect(within(box).getByText(URL_)).toBeTruthy();
    fireEvent.click(within(box).getByRole('button', { name: 'Copy the MCP server URL' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL_));
    expect(await within(box).findByText('Copied')).toBeTruthy();
    await screen.findByTestId('tier-R');
  });

  it('says so when the browser blocks the copy', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) } });
    render(<Connect />);
    fireEvent.click(within(screen.getByTestId('mcp-url')).getByRole('button', { name: 'Copy the MCP server URL' }));
    expect(await screen.findByText(/Copy was blocked/)).toBeTruthy();
    await screen.findByTestId('tier-R');
  });

  it('lists the five clients in order, each citing its official documentation', async () => {
    render(<Connect />);
    const ids = ['chatgpt', 'claude', 'claude-code', 'codex', 'cursor'];
    const guides = ids.map((id) => screen.getByTestId(`guide-${id}`));
    for (let i = 1; i < guides.length; i += 1) {
      expect(guides[i - 1].compareDocumentPosition(guides[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    for (const guide of guides) {
      const link = within(guide).getByRole('link');
      expect(link.getAttribute('href')).toMatch(/^https:\/\//);
    }
    expect(within(screen.getByTestId('guide-claude-code')).getByText(`claude mcp add --transport http alcantara ${URL_}`)).toBeTruthy();
    expect(within(screen.getByTestId('guide-codex')).getByText(/\[mcp_servers\.alcantara\]/)).toBeTruthy();
    expect(within(screen.getByTestId('guide-cursor')).getByText(/"mcpServers"/)).toBeTruthy();
    expect(within(screen.getByTestId('guide-chatgpt')).getByText(/Add custom MCP server/)).toBeTruthy();
    await screen.findByTestId('tier-R');
  });

  it('groups the server’s own capabilities by tier', async () => {
    render(<Connect />);
    for (const [tier, title] of [['R', 'Who am I'], ['W', 'Add to the queue'], ['A', 'Take over'], ['D', 'Delete a song']]) {
      expect(within(await screen.findByTestId(`tier-${tier}`)).getByText(title)).toBeTruthy();
    }
    expect(fetch).toHaveBeenCalledWith(`${URL_}/capabilities`, { headers: { Accept: 'application/json' } });
  });

  it('explains sign-in and what to do when it is refused', async () => {
    render(<Connect />);
    expect(screen.getByText(/Gaulatti sign-in/)).toBeTruthy();
    expect(screen.getByText(/wants to use Alcántara as you/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'gaulatti/bastille#34' }).getAttribute('href')).toBe('https://github.com/gaulatti/bastille/issues/34');
    await screen.findByTestId('tier-R');
  });

  it.each([
    ['a refusal', () => answer({}, false, 503), /answered 503/],
    ['a network failure', () => vi.fn().mockRejectedValue(new Error('down')), /could not be reached/],
    ['a malformed answer', () => answer({ capabilities: [{ name: 1 }] }), /cannot read/],
    ['a missing list', () => answer({}), /cannot read/],
    ['an unreadable body', () => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error('x'); } }), /cannot read/],
  ])('reports %s instead of inventing a list', async (_name, make, text) => {
    vi.stubGlobal('fetch', make());
    render(<Connect />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(text);
    expect(screen.queryByTestId('tier-R')).toBeNull();
  });

  it('says so when the server lists nothing', async () => {
    vi.stubGlobal('fetch', answer({ capabilities: [] }));
    render(<Connect />);
    expect(await screen.findByText('The server lists no capabilities.')).toBeTruthy();
  });

  it('shows a loading state first', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    render(<Connect />);
    expect(screen.getByText(/Loading the capability list/)).toBeTruthy();
  });
});

describe('Connect route meta', () => {
  it('titles the page for the browser and describes the five clients', () => {
    expect(meta({} as never)).toEqual([
      { title: 'Connect an AI client - Alcántara' },
      { name: 'description', content: 'Add the Alcántara MCP server to ChatGPT, Claude, Claude Code, Codex or Cursor' },
    ]);
  });
});
