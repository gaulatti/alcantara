import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccessPanel, isAccessError, type AccessClient, type AccessGrant } from './AccessPanel';
import { fixtureGrants, fixtureHistory, fixtureOldToken, fixtureToken, memoryAccessClient, refusal } from './accessFixtures';

// The Access panel against the screen contract: what each person sees, how a
// refusal reads, and that a token value lives on the page only until dismissed.

vi.mock('@gaulatti/bleecker', async (original) => {
  const kit = await import('../../../test/routeKit');
  return kit.nativeSelect(original as () => Promise<typeof import('@gaulatti/bleecker')>);
});

afterEach(() => cleanup());

const application = { key: 'alcantara', name: 'Alcántara' };

async function open(client: AccessClient) {
  render(<AccessPanel client={client} application={application} />);
  await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading access' })).not.toBeInTheDocument());
}

const spied = (client: AccessClient) => {
  const spy = Object.fromEntries(Object.entries(client).filter(([, fn]) => fn !== undefined).map(([name, fn]) => [name, vi.fn(fn as never)])) as unknown as { [K in keyof AccessClient]: ReturnType<typeof vi.fn> };
  return { client: spy as unknown as AccessClient, spy };
};

it('shows My tokens and History to someone who cannot manage access, and nothing of Token switch or People', async () => {
  await open(memoryAccessClient({ manager: false }));
  const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
  expect(tabs).toEqual(['My tokens', 'History']);
});

it('shows all four sections to a manager', async () => {
  await open(memoryAccessClient());
  expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['My tokens', 'Token switch', 'People', 'History']);
});

it('lists my tokens with where each was created and last used, and says what a token reaches', async () => {
  await open(memoryAccessClient());
  expect(screen.getByText(/reach only Alcántara's permissions, and only the ones you hold/)).toBeVisible();
  const row = screen.getByText('Studio laptop').closest('tr')!;
  expect(within(row).getByText('Alcántara')).toBeVisible();
  expect(within(row).getByText('monitor, 2026-11-19 11:30 UTC')).toBeVisible();
  expect(within(row).getByText('alcantara:program:read, alcantara:flight:read')).toBeVisible();
  const old = screen.getByText('Console script').closest('tr')!;
  expect(within(old).getByText('Pompeii')).toBeVisible();
  expect(within(old).getByText('Never used')).toBeVisible();
  expect(within(old).getByText('No expiry')).toBeVisible();
  // The display prefix is Pompeii's; the page has no use for it.
  expect(screen.queryByText(/pmp_pat_abcd/)).not.toBeInTheDocument();
});

it('creates a token with all of my permissions, shows its value once, and forgets it when dismissed', async () => {
  const { client, spy } = spied(memoryAccessClient());
  await open(client);
  fireEvent.change(screen.getByPlaceholderText('For example: my laptop'), { target: { value: 'New tool' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
  expect(await screen.findByText('pmp_pat_FICTIONAL_VALUE_SHOWN_ONCE')).toBeVisible();
  expect(spy.createMyToken).toHaveBeenCalledWith({ name: 'New tool', expires_in_days: 30, all_held_in_application: true });
  expect(screen.getByText(/shown once and you will not see it again/)).toBeVisible();
  expect(screen.getByText('New tool', { selector: 'td div' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'I have copied it' }));
  expect(screen.queryByText('pmp_pat_FICTIONAL_VALUE_SHOWN_ONCE')).not.toBeInTheDocument();
});

it('copies the value to the clipboard', async () => {
  const writeText = vi.fn();
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  await open(memoryAccessClient());
  fireEvent.change(screen.getByPlaceholderText('For example: my laptop'), { target: { value: 'Copy me' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));
  expect(writeText).toHaveBeenCalledWith('pmp_pat_FICTIONAL_VALUE_SHOWN_ONCE');
  vi.unstubAllGlobals();
});

it('creates a token that never expires, reaching only the permissions I pick from my own', async () => {
  const { client, spy } = spied(memoryAccessClient());
  await open(client);
  fireEvent.change(screen.getByPlaceholderText('For example: my laptop'), { target: { value: 'Picky' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Expires' }), { target: { value: 'none' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /All of mine in Alcántara/ }));
  expect(screen.getByRole('button', { name: 'Create token' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: 'alcantara:flight:read' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'alcantara:program:read' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'alcantara:program:read' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
  await screen.findByText('pmp_pat_FICTIONAL_VALUE_SHOWN_ONCE');
  expect(spy.createMyToken).toHaveBeenCalledWith({ name: 'Picky', no_expiry: true, permissions: ['alcantara:flight:read'] });
});

it('takes typed permission keys when the service offers no picker', async () => {
  const base = memoryAccessClient();
  const { client, spy } = spied({ ...base, listMyPermissions: undefined });
  await open(client);
  fireEvent.change(screen.getByPlaceholderText('For example: my laptop'), { target: { value: 'Typed' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /All of mine in Alcántara/ }));
  fireEvent.change(screen.getByPlaceholderText('alcantara:...'), { target: { value: 'alcantara:program:read, alcantara:flight:read' } });
  fireEvent.submit(screen.getByRole('button', { name: 'Create token' }).closest('form')!);
  await screen.findByText('pmp_pat_FICTIONAL_VALUE_SHOWN_ONCE');
  expect(spy.createMyToken).toHaveBeenCalledWith({ name: 'Typed', expires_in_days: 30, permissions: ['alcantara:program:read', 'alcantara:flight:read'] });
});

it('falls back to typed keys when the picker cannot be read', async () => {
  await open({ ...memoryAccessClient(), listMyPermissions: () => Promise.reject(refusal('forbidden', 403)) });
  fireEvent.click(screen.getByRole('checkbox', { name: /All of mine in Alcántara/ }));
  expect(screen.getByPlaceholderText('alcantara:...')).toBeVisible();
});

it('does not submit an empty name', async () => {
  const { client, spy } = spied(memoryAccessClient());
  await open(client);
  fireEvent.submit(screen.getByRole('button', { name: 'Create token' }).closest('form')!);
  expect(screen.getByRole('button', { name: 'Create token' })).toBeDisabled();
  expect(spy.createMyToken).not.toHaveBeenCalled();
});

it('revokes a token and drops it from the list', async () => {
  const { client, spy } = spied(memoryAccessClient());
  await open(client);
  fireEvent.click(screen.getByRole('button', { name: 'Revoke Console script' }));
  await waitFor(() => expect(screen.queryByText('Console script')).not.toBeInTheDocument());
  expect(spy.revokeMyToken).toHaveBeenCalledWith(fixtureOldToken.id);
  expect(screen.getByText('Studio laptop')).toBeVisible();
});

it('says why a token cannot be created when the switch is off, and keeps the form', async () => {
  const base = memoryAccessClient();
  await open({ ...base, createMyToken: () => Promise.reject(refusal('tokens_off', 409)) });
  fireEvent.change(screen.getByPlaceholderText('For example: my laptop'), { target: { value: 'Blocked' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
  expect(await screen.findByText(/switched off here, so new ones cannot be created/)).toBeVisible();
  expect(screen.getByPlaceholderText('For example: my laptop')).toHaveValue('Blocked');
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it.each([
  ['unauthenticated', 401, /Sign in again to manage access/],
  ['forbidden', 403, /not allowed/],
  ['invalid_request', 400, /not accepted/],
  ['not_found', 404, /no longer exists/]
] as const)('reads a %s refusal in words, without Pompeii text', async (code, status, words) => {
  await open({ ...memoryAccessClient(), revokeMyToken: () => Promise.reject(refusal(code, status)) });
  fireEvent.click(screen.getByRole('button', { name: 'Revoke Console script' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(words);
});

it('reads an unrecognised failure as a plain retry', async () => {
  await open({ ...memoryAccessClient(), revokeMyToken: () => Promise.reject(new Error('boom')) });
  fireEvent.click(screen.getByRole('button', { name: 'Revoke Console script' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Try again.');
});

it('shows "not available yet" for the whole panel when any call answers 503', async () => {
  await open(memoryAccessClient({ unavailable: true }));
  expect(screen.getByText('Access is not available yet')).toBeVisible();
  expect(screen.queryByRole('tab')).not.toBeInTheDocument();
});

it('shows "not available yet" when only one of the first calls answers 503', async () => {
  await open({ ...memoryAccessClient(), listHistory: () => Promise.reject(refusal('access_unavailable', 503)) });
  expect(screen.getByText('Access is not available yet')).toBeVisible();
});

it('shows "not available yet" when a manager panel loses grants or the switch to 503', async () => {
  await open({ ...memoryAccessClient(), listGrants: () => Promise.reject(refusal('access_unavailable', 503)) });
  expect(screen.getByText('Access is not available yet')).toBeVisible();
});

it('turns the panel to "not available yet" when a change meets a 503', async () => {
  await open({ ...memoryAccessClient(), revokeMyToken: () => Promise.reject(refusal('access_unavailable', 503)) });
  fireEvent.click(screen.getByRole('button', { name: 'Revoke Console script' }));
  expect(await screen.findByText('Access is not available yet')).toBeVisible();
});

it('says so when tokens or history cannot be listed, without hiding the rest', async () => {
  await open({ ...memoryAccessClient(), listMyTokens: () => Promise.reject(refusal('forbidden', 403)), listHistory: () => Promise.reject(refusal('forbidden', 403)) });
  expect(screen.getAllByRole('alert')[0]).toHaveTextContent('You are not allowed to do that.');
  fireEvent.click(screen.getByRole('tab', { name: 'History' }));
  expect(screen.getByRole('alert')).toHaveTextContent('You are not allowed to do that.');
});

it('switches token acceptance on and off', async () => {
  const { client, spy } = spied(memoryAccessClient());
  await open(client);
  fireEvent.click(screen.getByRole('tab', { name: 'Token switch' }));
  const toggle = screen.getByRole('switch', { name: 'Accept personal access tokens in Alcántara' });
  expect(toggle).toBeChecked();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).not.toBeChecked());
  expect(spy.setTokenSwitch).toHaveBeenCalledWith(false);
});

it('keeps the switch where it was when Pompeii refuses the change', async () => {
  await open({ ...memoryAccessClient(), setTokenSwitch: () => Promise.reject(refusal('forbidden', 403)) });
  fireEvent.click(screen.getByRole('tab', { name: 'Token switch' }));
  fireEvent.click(screen.getByRole('switch'));
  expect(await screen.findByRole('alert')).toHaveTextContent('not allowed');
  expect(screen.getByRole('switch')).toBeChecked();
});

it('says the switch could not be read when it cannot', async () => {
  await open({ ...memoryAccessClient(), getTokenSwitch: () => Promise.reject(refusal('forbidden', 403)) });
  fireEvent.click(screen.getByRole('tab', { name: 'Token switch' }));
  expect(screen.getByRole('alert')).toHaveTextContent('The switch could not be read.');
});

it('lists people with their roles, and treats an unreadable list as empty', async () => {
  await open(memoryAccessClient());
  fireEvent.click(screen.getByRole('tab', { name: 'People' }));
  expect(screen.getByText('ana@example.test')).toBeVisible();
  expect(within(screen.getByRole('table', { name: 'People' })).getByText('Viewer')).toBeVisible();
  cleanup();
  await open({ ...memoryAccessClient(), listGrants: () => Promise.reject(refusal('forbidden', 403)) });
  fireEvent.click(screen.getByRole('tab', { name: 'People' }));
  expect(screen.getByText('No one holds a role yet')).toBeVisible();
});

it('grants a role to a typed user id, saying that people cannot be searched yet', async () => {
  const { client, spy } = spied(memoryAccessClient());
  await open(client);
  fireEvent.click(screen.getByRole('tab', { name: 'People' }));
  expect(screen.getByText(/cannot search for people yet/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Grant role' })).toBeDisabled();
  fireEvent.change(screen.getByPlaceholderText('For example: 42'), { target: { value: '42' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Role' }), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Grant role' }));
  await screen.findByText('#42');
  expect(spy.grant).toHaveBeenCalledWith({ user_id: 42, role_id: 2 });
});

it('grants a role to someone picked from the people already listed', async () => {
  const { client, spy } = spied(memoryAccessClient());
  await open(client);
  fireEvent.click(screen.getByRole('tab', { name: 'People' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Or pick someone who already holds a role' }), { target: { value: '7' } });
  expect(screen.getByPlaceholderText('For example: 42')).toHaveValue('7');
  fireEvent.change(screen.getByRole('combobox', { name: 'Role' }), { target: { value: '2' } });
  fireEvent.submit(screen.getByRole('button', { name: 'Grant role' }).closest('form')!);
  await waitFor(() => expect(spy.grant).toHaveBeenCalledWith({ user_id: 7, role_id: 2 }));
});

it('offers a picked person only once, and a person without an email as a user', async () => {
  const grants: AccessGrant[] = [...fixtureGrants, { ...fixtureGrants[0], id: 11, role_id: 3, role_name: 'Viewer' }, { ...fixtureGrants[0], id: 12, user_id: 8, user_email: '' }];
  await open({ ...memoryAccessClient(), listGrants: () => Promise.resolve(grants) });
  fireEvent.click(screen.getByRole('tab', { name: 'People' }));
  const picker = screen.getByRole('combobox', { name: 'Or pick someone who already holds a role' });
  expect(within(picker).getAllByRole('option').map((option) => option.textContent)).toEqual(['Or pick someone who already holds a role', 'ana@example.test (#4)', 'bruno@example.test (#7)', 'User (#8)']);
  expect(screen.getByText('Unknown')).toBeVisible();
});

it('refuses a user id that is not a positive whole number', async () => {
  await open(memoryAccessClient());
  fireEvent.click(screen.getByRole('tab', { name: 'People' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Role' }), { target: { value: '2' } });
  for (const bad of ['abc', '0', '-3', '1.5']) {
    fireEvent.change(screen.getByPlaceholderText('For example: 42'), { target: { value: bad } });
    expect(screen.getByRole('button', { name: 'Grant role' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('button', { name: 'Grant role' }).closest('form')!);
  }
});

it('revokes a grant', async () => {
  const { client, spy } = spied(memoryAccessClient());
  await open(client);
  fireEvent.click(screen.getByRole('tab', { name: 'People' }));
  fireEvent.click(screen.getByRole('button', { name: 'Revoke Operator from ana@example.test' }));
  await waitFor(() => expect(screen.queryByText('ana@example.test')).not.toBeInTheDocument());
  expect(spy.revokeGrant).toHaveBeenCalledWith(9);
});

it('names a grant without an email by its user id when revoking', async () => {
  await open({ ...memoryAccessClient(), listGrants: () => Promise.resolve([{ ...fixtureGrants[0], user_email: '' }]) });
  fireEvent.click(screen.getByRole('tab', { name: 'People' }));
  expect(screen.getByRole('button', { name: 'Revoke Operator from user 4' })).toBeVisible();
});

it('shows the history with where each change came from', async () => {
  await open(memoryAccessClient());
  fireEvent.click(screen.getByRole('tab', { name: 'History' }));
  expect(screen.getByText('Alcántara, this page')).toBeVisible();
  expect(screen.getByText('Alcántara, MCP client')).toBeVisible();
  expect(screen.getByText('bruno@example.test: Viewer')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Load older' })).not.toBeInTheDocument();
});

it('says when there is no history', async () => {
  await open({ ...memoryAccessClient(), listHistory: () => Promise.resolve([]) });
  fireEvent.click(screen.getByRole('tab', { name: 'History' }));
  expect(screen.getByText('No access changes yet')).toBeVisible();
});

it('loads older history from the last entry shown when a full page came back', async () => {
  const page = Array.from({ length: 50 }, (_, index) => ({ ...fixtureHistory[0], at: `2026-11-19T12:${String(59 - index).padStart(2, '0')}:00Z`, target: `target-${index}` }));
  const older = [{ ...fixtureHistory[1], target: 'older-entry' }];
  const listHistory = vi.fn().mockResolvedValueOnce(page).mockResolvedValueOnce(older);
  await open({ ...memoryAccessClient(), listHistory });
  fireEvent.click(screen.getByRole('tab', { name: 'History' }));
  fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
  expect(await screen.findByText('older-entry')).toBeVisible();
  expect(listHistory).toHaveBeenLastCalledWith({ limit: 50, before: '2026-11-19T12:10:00Z' });
  expect(screen.queryByRole('button', { name: 'Load older' })).not.toBeInTheDocument();
});

it('shows a time it cannot read as it came', async () => {
  await open({ ...memoryAccessClient(), listHistory: () => Promise.resolve([{ ...fixtureHistory[0], at: 'not a date' }]) });
  fireEvent.click(screen.getByRole('tab', { name: 'History' }));
  expect(screen.getByText('not a date')).toBeVisible();
});

it('recognises an access error only by its shape', () => {
  expect(isAccessError(refusal('forbidden', 403))).toBe(true);
  expect(isAccessError(new Error('x'))).toBe(false);
  expect(isAccessError(null)).toBe(false);
  expect(fixtureToken.id).not.toBe(fixtureOldToken.id);
});

it('says there are no tokens yet', async () => {
  await open({ ...memoryAccessClient(), listMyTokens: () => Promise.resolve([]) });
  expect(screen.getByText('No tokens yet')).toBeVisible();
});
