import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isHttpsImage, LogoPicker } from './LogoPicker';

// gaulatti/alcantara#408: the logo picker lists the media library's images, narrowed by name.
const images = [
  { id: 1, name: 'Fictional logo', imageUrl: 'https://media.example.test/one.png' },
  { id: 2, name: 'Second mark', imageUrl: 'https://media.example.test/two.png' },
];

function stubMedia(answer: (url: string) => Response | Promise<Response>) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      return answer(url);
    }),
  );
  return urls;
}

describe('LogoPicker', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('loads nothing while closed', () => {
    const urls = stubMedia(() => new Response(JSON.stringify({ data: images })));
    render(<LogoPicker isOpen={false} onClose={() => undefined} onPick={() => undefined} />);
    expect(urls).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows a loading state, then the images, and hands the chosen one to onPick', async () => {
    let release: (response: Response) => void = () => undefined;
    stubMedia(() => new Promise<Response>((resolve) => (release = resolve)));
    const onPick = vi.fn();
    render(<LogoPicker isOpen onClose={() => undefined} onPick={onPick} />);
    expect(screen.getByLabelText('Loading the media library')).toHaveAttribute('aria-busy', 'true');
    release(new Response(JSON.stringify({ data: images })));
    fireEvent.click(await screen.findByRole('button', { name: 'Use Second mark' }));
    expect(onPick).toHaveBeenCalledWith(images[1]);
    expect(screen.getByRole('list', { name: 'Media library images' }).children).toHaveLength(2);
  });

  it('searches by name and says when nothing matches', async () => {
    const urls = stubMedia((url) =>
      new Response(JSON.stringify({ data: url.includes('search=') ? [] : images }), { status: 200 }),
    );
    render(<LogoPicker isOpen onClose={() => undefined} onPick={() => undefined} />);
    await screen.findByRole('button', { name: 'Use Fictional logo' });
    fireEvent.change(screen.getByLabelText('Search the media library'), { target: { value: '  nothing ' } });
    expect(await screen.findByText('No image matches this search.')).toBeInTheDocument();
    expect(urls.at(-1)).toContain('search=nothing');
    expect(urls[0]).not.toContain('search=');
  });

  it('shows an error with a retry that loads again', async () => {
    let fail = true;
    stubMedia(() => (fail ? new Response('down', { status: 503 }) : new Response(JSON.stringify({ data: images }))));
    render(<LogoPicker isOpen onClose={() => undefined} onPick={() => undefined} />);
    expect(await screen.findByText('The media library could not be loaded.')).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Use Fictional logo' })).toBeEnabled();
  });

  it('treats an answer without a list as a failure, not as an empty library', async () => {
    stubMedia(() => new Response(JSON.stringify({ items: images })));
    render(<LogoPicker isOpen onClose={() => undefined} onPick={() => undefined} />);
    expect(await screen.findByText('The media library could not be loaded.')).toBeInTheDocument();
  });

  it('ignores an answer that arrives after it was closed', async () => {
    let release: (response: Response) => void = () => undefined;
    stubMedia(() => new Promise<Response>((resolve) => (release = resolve)));
    const { rerender } = render(<LogoPicker isOpen onClose={() => undefined} onPick={() => undefined} />);
    rerender(<LogoPicker isOpen={false} onClose={() => undefined} onPick={() => undefined} />);
    release(new Response(JSON.stringify({ data: images })));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('ignores a failure that arrives after it was closed', async () => {
    let reject: (cause: Error) => void = () => undefined;
    stubMedia(() => new Promise<Response>((_resolve, fail) => (reject = fail)));
    const { rerender } = render(<LogoPicker isOpen onClose={() => undefined} onPick={() => undefined} />);
    rerender(<LogoPicker isOpen={false} onClose={() => undefined} onPick={() => undefined} />);
    reject(new Error('late'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('clears the search', async () => {
    const urls = stubMedia(() => new Response(JSON.stringify({ data: images })));
    render(<LogoPicker isOpen onClose={() => undefined} onPick={() => undefined} />);
    const search = screen.getByLabelText('Search the media library');
    fireEvent.change(search, { target: { value: 'mark' } });
    await waitFor(() => expect(urls.at(-1)).toContain('search=mark'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(search).toHaveValue('');
    await waitFor(() => expect(urls.at(-1)).not.toContain('search='));
  });

  it('accepts only https addresses', () => {
    expect(isHttpsImage({ imageUrl: 'https://media.example.test/a.png' })).toBe(true);
    expect(isHttpsImage({ imageUrl: 'http://media.example.test/a.png' })).toBe(false);
  });
});
