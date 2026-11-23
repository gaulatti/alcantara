import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import AccessRoute, { meta } from './access';

// The Access page: the panel with Alcántara's own client and application.

const panel = vi.hoisted(() => vi.fn());
vi.mock('../components/access/AccessPanel', () => ({
  AccessPanel: (props: { application: { key: string; name: string }; client: object }) => {
    panel(props);
    return <p>Panel for {props.application.name}</p>;
  }
}));
vi.mock('../services/access', () => ({ createAccessClient: () => ({ marker: 'alcantara-client' }) }));

afterEach(() => cleanup());

it('shows the panel for Alcántara under its Pompeii slug', async () => {
  render(<AccessRoute />);
  expect(screen.getByRole('heading', { name: 'Access' })).toBeVisible();
  await waitFor(() => expect(screen.getByText('Panel for Alcántara')).toBeVisible());
  expect(panel).toHaveBeenCalledWith({ client: { marker: 'alcantara-client' }, application: { key: 'alcantara', name: 'Alcántara' } });
});

it('titles the page', () => {
  expect(meta({} as never)).toEqual([{ title: 'Access - Alcántara' }, { name: 'description', content: 'Manage who can use Alcántara and with which tokens' }]);
});
