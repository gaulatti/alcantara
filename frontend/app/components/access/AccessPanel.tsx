import { Button, Card, Checkbox, Empty, Field, Input, LoadingSpinner, SectionHeader, Select, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tabs } from '@gaulatti/bleecker';
import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * gaulatti/alcantara#224: a local stand-in for Bleecker's <AccessPanel> with
 * the exact props and types of the screen contract, so that adopting
 * @gaulatti/bleecker's panel is an import change. It talks only to the
 * AccessClient it is given: Alcantara's own /access routes, which forward to
 * Pompeii. Pompeii decides everything; this panel only shows what it answers.
 */

export type AccessToken = { id: string; name: string; display_prefix: string; permissions: string[]; created_at: string; expires_at: string; last_used_at: string; created_via_application: string; last_used_application: string };
export type AccessRole = { id: number; name: string; permissions: string[] };
export type AccessGrant = { id: number; user_id: number; user_email: string; role_id: number; role_name: string; team_id: number; granted_at: string };
export type AccessHistoryEntry = { at: string; action: string; actor_email: string; target: string; via_application: string; via_client: string };
export type AccessError = { status: number; error: 'unauthenticated' | 'forbidden' | 'invalid_request' | 'tokens_off' | 'not_found' | 'access_unavailable' };
export interface AccessClient {
  listMyTokens(): Promise<AccessToken[]>;
  createMyToken(input: { name: string; expires_in_days?: number; no_expiry?: boolean; permissions?: string[]; all_held_in_application?: boolean }): Promise<{ token: AccessToken; value: string }>;
  revokeMyToken(id: string): Promise<void>;
  getTokenSwitch(): Promise<boolean>;
  setTokenSwitch(enabled: boolean): Promise<boolean>;
  listRoles(): Promise<AccessRole[]>;
  listGrants(): Promise<AccessGrant[]>;
  grant(input: { user_id: number; role_id: number }): Promise<AccessGrant>;
  revokeGrant(id: number): Promise<void>;
  listHistory(input?: { limit?: number; before?: string }): Promise<AccessHistoryEntry[]>;
  listMyPermissions?(): Promise<string[]>;
}
export interface AccessPanelProps {
  client: AccessClient;
  application: { key: string; name: string };
}

const HISTORY_PAGE = 50;

export function isAccessError(error: unknown): error is AccessError {
  return typeof error === 'object' && error !== null && typeof (error as AccessError).status === 'number' && typeof (error as AccessError).error === 'string';
}

const isUnavailable = (error: unknown) => isAccessError(error) && error.error === 'access_unavailable';

/** What each refusal means to a person; Pompeii's own wording never reaches the page. */
function describe(error: unknown): string {
  if (!isAccessError(error)) return 'Something went wrong. Try again.';
  switch (error.error) {
    case 'unauthenticated':
      return 'Sign in again to manage access. A personal access token cannot do this.';
    case 'forbidden':
      return 'You are not allowed to do that.';
    case 'invalid_request':
      return 'That request was not accepted. Check what you entered.';
    case 'tokens_off':
      return 'Personal access tokens are switched off here, so new ones cannot be created.';
    case 'not_found':
      return 'That record no longer exists.';
    default:
      return 'Access is not available yet.';
  }
}

/** A fixed, readable UTC time; the raw text when it is not a date. */
function formatTime(value: string): string {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : `${parsed.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

type Tab = 'tokens' | 'switch' | 'people' | 'history';

export function AccessPanel({ client, application }: AccessPanelProps) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [tab, setTab] = useState<Tab>('tokens');
  const [manager, setManager] = useState(false);
  const [tokens, setTokens] = useState<AccessToken[]>([]);
  const [tokensError, setTokensError] = useState('');
  const [roles, setRoles] = useState<AccessRole[]>([]);
  const [grants, setGrants] = useState<AccessGrant[]>([]);
  const [tokensOn, setTokensOn] = useState<boolean | null>(null);
  const [history, setHistory] = useState<AccessHistoryEntry[]>([]);
  const [historyMore, setHistoryMore] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [myPermissions, setMyPermissions] = useState<string[]>([]);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const [tokensResult, rolesResult, historyResult, permissionsResult] = await Promise.allSettled([client.listMyTokens(), client.listRoles(), client.listHistory({ limit: HISTORY_PAGE }), client.listMyPermissions ? client.listMyPermissions() : Promise.resolve([] as string[])]);
    const results = [tokensResult, rolesResult, historyResult];
    if (results.some((result) => result.status === 'rejected' && isUnavailable(result.reason))) {
      setPhase('unavailable');
      return;
    }
    if (tokensResult.status === 'fulfilled') {
      setTokens(tokensResult.value);
      setTokensError('');
    } else setTokensError(describe(tokensResult.reason));
    if (historyResult.status === 'fulfilled') {
      setHistory(historyResult.value);
      setHistoryMore(historyResult.value.length >= HISTORY_PAGE);
      setHistoryError('');
    } else setHistoryError(describe(historyResult.reason));
    // Without a permission picker the person types keys.
    setMyPermissions(permissionsResult.status === 'fulfilled' ? permissionsResult.value : []);
    // Listing roles is refused (403) to anyone who cannot manage access here.
    const canManage = rolesResult.status === 'fulfilled';
    setManager(canManage);
    if (rolesResult.status === 'fulfilled') {
      setRoles(rolesResult.value);
      const [grantsResult, switchResult] = await Promise.allSettled([client.listGrants(), client.getTokenSwitch()]);
      if ([grantsResult, switchResult].some((result) => result.status === 'rejected' && isUnavailable(result.reason))) {
        setPhase('unavailable');
        return;
      }
      setGrants(grantsResult.status === 'fulfilled' ? grantsResult.value : []);
      setTokensOn(switchResult.status === 'fulfilled' ? switchResult.value : null);
    }
    setPhase('ready');
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  // Runs one change; a 503 anywhere turns the whole panel to "not available yet".
  const attempt = useCallback(async (work: () => Promise<void>): Promise<boolean> => {
    setNotice('');
    try {
      await work();
      return true;
    } catch (error) {
      if (isUnavailable(error)) setPhase('unavailable');
      else setNotice(describe(error));
      return false;
    }
  }, []);

  const loadOlderHistory = () =>
    attempt(async () => {
      const older = await client.listHistory({ limit: HISTORY_PAGE, before: history[history.length - 1]?.at });
      setHistory((current) => [...current, ...older]);
      setHistoryMore(older.length >= HISTORY_PAGE);
    });

  const tabs = useMemo(
    () => [
      { id: 'tokens', label: 'My tokens' },
      ...(manager
        ? [
            { id: 'switch', label: 'Token switch' },
            { id: 'people', label: 'People' }
          ]
        : []),
      { id: 'history', label: 'History' }
    ],
    [manager]
  );

  if (phase === 'loading')
    return (
      <div className='flex justify-center py-10' role='status' aria-label='Loading access'>
        <LoadingSpinner />
      </div>
    );
  if (phase === 'unavailable') return <Empty title='Access is not available yet' description={`${application.name} cannot reach Pompeii's access service right now. Nothing here has changed. Try again later.`} />;

  return (
    <div className='space-y-4'>
      <Tabs tabs={tabs} activeTab={tab} onChange={(id) => setTab(id as Tab)} aria-label='Access sections' />
      {notice ? (
        <Card variant='outlined' role='alert'>
          <div className='flex items-center justify-between gap-3 text-sm'>
            <span>{notice}</span>
            <Button size='xs' variant='ghost' onClick={() => setNotice('')}>
              Dismiss
            </Button>
          </div>
        </Card>
      ) : null}
      {tab === 'tokens' ? <MyTokens client={client} application={application} tokens={tokens} setTokens={setTokens} error={tokensError} myPermissions={myPermissions} attempt={attempt} /> : null}
      {tab === 'switch' && manager ? <TokenSwitch client={client} application={application} enabled={tokensOn} setEnabled={setTokensOn} attempt={attempt} /> : null}
      {tab === 'people' && manager ? <People client={client} application={application} roles={roles} grants={grants} setGrants={setGrants} attempt={attempt} /> : null}
      {tab === 'history' ? <History entries={history} error={historyError} more={historyMore} onMore={loadOlderHistory} application={application} /> : null}
    </div>
  );
}

type Attempt = (work: () => Promise<void>) => Promise<boolean>;
type App = AccessPanelProps['application'];

/** The service that created a token, or that last saw it: a slug, or "" for Pompeii itself. */
const appLabel = (slug: string, application: App) => (slug === '' ? 'Pompeii' : slug === application.key ? application.name : slug);

const EXPIRY_OPTIONS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'none', label: 'No expiry' }
];

function MyTokens({ client, application, tokens, setTokens, error, myPermissions, attempt }: { client: AccessClient; application: App; tokens: AccessToken[]; setTokens: (next: AccessToken[]) => void; error: string; myPermissions: string[]; attempt: Attempt }) {
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState('30');
  const [allHeld, setAllHeld] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  // The value is held only here, only until the person dismisses it.
  const [created, setCreated] = useState<{ name: string; value: string } | null>(null);

  const permissions = allHeld ? [] : myPermissions.length > 0 ? picked : typed.split(/[\s,]+/).filter(Boolean);
  const canCreate = name.trim() !== '' && (allHeld || permissions.length > 0) && !busy;

  const create = async () => {
    setBusy(true);
    await attempt(async () => {
      const answer = await client.createMyToken({
        name: name.trim(),
        ...(expiry === 'none' ? { no_expiry: true } : { expires_in_days: Number(expiry) }),
        ...(allHeld ? { all_held_in_application: true } : { permissions })
      });
      setCreated({ name: answer.token.name, value: answer.value });
      setName('');
      setPicked([]);
      setTyped('');
      setTokens([...tokens, answer.token]);
    });
    setBusy(false);
  };

  const revoke = (token: AccessToken) =>
    attempt(async () => {
      await client.revokeMyToken(token.id);
      setTokens(tokens.filter((candidate) => candidate.id !== token.id));
    });

  return (
    <div className='space-y-4'>
      <SectionHeader title='My tokens' description={`Tokens made here reach only ${application.name}'s permissions, and only the ones you hold. Tools such as MCP clients use one to act as you.`} />
      {created ? (
        <Card variant='outlined' role='status' aria-label='New token'>
          <p className='text-sm font-semibold'>Copy the token "{created.name}" now. It is shown once and you will not see it again.</p>
          <code className='mt-2 block break-all rounded bg-white/[0.06] p-2 text-xs'>{created.value}</code>
          <div className='mt-3 flex gap-2'>
            <Button size='sm' variant='secondary' onClick={() => void navigator.clipboard?.writeText(created.value)}>
              Copy
            </Button>
            <Button size='sm' variant='ghost' onClick={() => setCreated(null)}>
              I have copied it
            </Button>
          </div>
        </Card>
      ) : null}
      <Card variant='outlined'>
        <form
          className='space-y-3'
          onSubmit={(event) => {
            event.preventDefault();
            if (canCreate) void create();
          }}
        >
          <Field label='Token name' required>
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder='For example: my laptop' />
          </Field>
          <Field label='Expires'>
            <Select aria-label='Expires' value={expiry} onChange={setExpiry} options={EXPIRY_OPTIONS} />
          </Field>
          <Checkbox label={`All of mine in ${application.name}`} checked={allHeld} onChange={(event) => setAllHeld(event.target.checked)} description='The token reaches every permission you hold here today.' />
          {allHeld ? null : myPermissions.length > 0 ? (
            <div className='space-y-1' role='group' aria-label='Permissions'>
              {myPermissions.map((key) => (
                <Checkbox key={key} label={key} checked={picked.includes(key)} onChange={(event) => setPicked((current) => (event.target.checked ? [...current, key] : current.filter((candidate) => candidate !== key)))} />
              ))}
            </div>
          ) : (
            <Field label='Permission keys' description='Separate keys with commas.'>
              <Input value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={`${application.key}:...`} />
            </Field>
          )}
          <Button type='submit' disabled={!canCreate}>
            Create token
          </Button>
        </form>
      </Card>
      {error ? (
        <p role='alert' className='text-sm text-text-secondary'>
          {error}
        </p>
      ) : tokens.length === 0 ? (
        <Empty title='No tokens yet' description='Tokens you create here appear in this list.' />
      ) : (
        <Table aria-label='My tokens'>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Reach</TableHead>
              <TableHead>Created in</TableHead>
              <TableHead>Last used in</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>
                <span className='sr-only'>Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.map((token) => (
              <TableRow key={token.id}>
                <TableCell>
                  <div className='font-medium'>{token.name}</div>
                  <div className='text-xs text-text-secondary'>Created {formatTime(token.created_at)}</div>
                </TableCell>
                <TableCell>{token.permissions.length > 0 ? token.permissions.join(', ') : 'None'}</TableCell>
                <TableCell>{appLabel(token.created_via_application, application)}</TableCell>
                <TableCell>{token.last_used_at ? `${appLabel(token.last_used_application, application)}, ${formatTime(token.last_used_at)}` : 'Never used'}</TableCell>
                <TableCell>{token.expires_at ? formatTime(token.expires_at) : 'No expiry'}</TableCell>
                <TableCell>
                  <Button size='xs' variant='destructive' aria-label={`Revoke ${token.name}`} onClick={() => void revoke(token)}>
                    Revoke
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function TokenSwitch({ client, application, enabled, setEnabled, attempt }: { client: AccessClient; application: App; enabled: boolean | null; setEnabled: (next: boolean) => void; attempt: Attempt }) {
  const change = (next: boolean) =>
    attempt(async () => {
      setEnabled(await client.setTokenSwitch(next));
    });
  return (
    <div className='space-y-4'>
      <SectionHeader title='Token switch' description={`Whether ${application.name} accepts personal access tokens at all. Turning it off refuses every token on its next call and stops new ones being created.`} />
      {enabled === null ? (
        <p role='alert' className='text-sm text-text-secondary'>
          The switch could not be read.
        </p>
      ) : (
        <Switch label={`Accept personal access tokens in ${application.name}`} checked={enabled} onCheckedChange={(next) => void change(next)} />
      )}
    </div>
  );
}

function People({ client, application, roles, grants, setGrants, attempt }: { client: AccessClient; application: App; roles: AccessRole[]; grants: AccessGrant[]; setGrants: (next: AccessGrant[]) => void; attempt: Attempt }) {
  const [userId, setUserId] = useState('');
  const [roleId, setRoleId] = useState('');
  const known = useMemo(() => {
    const seen = new Map<number, string>();
    for (const grant of grants) if (!seen.has(grant.user_id)) seen.set(grant.user_id, grant.user_email);
    return [...seen].map(([id, email]) => ({ value: String(id), label: `${email || 'User'} (#${id})` }));
  }, [grants]);
  const parsedUser = Number(userId);
  const canGrant = Number.isSafeInteger(parsedUser) && parsedUser > 0 && roleId !== '';

  const grant = () =>
    attempt(async () => {
      const added = await client.grant({ user_id: parsedUser, role_id: Number(roleId) });
      setGrants([...grants, added]);
      setUserId('');
    });
  const revoke = (entry: AccessGrant) =>
    attempt(async () => {
      await client.revokeGrant(entry.id);
      setGrants(grants.filter((candidate) => candidate.id !== entry.id));
    });

  return (
    <div className='space-y-4'>
      <SectionHeader title='People' description={`Who holds ${application.name}'s roles. You can only grant or revoke a role whose every permission you hold yourself.`} />
      <Card variant='outlined'>
        <form
          className='space-y-3'
          onSubmit={(event) => {
            event.preventDefault();
            if (canGrant) void grant();
          }}
        >
          <p className='text-sm text-text-secondary'>Pompeii cannot search for people yet. Type a Pompeii user id (the person must have signed in once), or pick someone who already holds a role here.</p>
          <Field label='User id'>
            <Input inputMode='numeric' value={userId} onChange={(event) => setUserId(event.target.value.trim())} placeholder='For example: 42' />
          </Field>
          {known.length > 0 ? <Select aria-label='Or pick someone who already holds a role' placeholder='Or pick someone who already holds a role' value={known.some((option) => option.value === userId) ? userId : ''} onChange={setUserId} options={known} /> : null}
          <Select aria-label='Role' placeholder='Role' value={roleId} onChange={setRoleId} options={roles.map((role) => ({ value: String(role.id), label: role.name }))} />
          <Button type='submit' disabled={!canGrant}>
            Grant role
          </Button>
        </form>
      </Card>
      {grants.length === 0 ? (
        <Empty title='No one holds a role yet' />
      ) : (
        <Table aria-label='People'>
          <TableHeader>
            <TableRow>
              <TableHead>Person</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Granted</TableHead>
              <TableHead>
                <span className='sr-only'>Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grants.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell>
                  {entry.user_email || 'Unknown'} <span className='text-xs text-text-secondary'>#{entry.user_id}</span>
                </TableCell>
                <TableCell>{entry.role_name}</TableCell>
                <TableCell>{formatTime(entry.granted_at)}</TableCell>
                <TableCell>
                  <Button size='xs' variant='destructive' aria-label={`Revoke ${entry.role_name} from ${entry.user_email || `user ${entry.user_id}`}`} onClick={() => void revoke(entry)}>
                    Revoke
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function History({ entries, error, more, onMore, application }: { entries: AccessHistoryEntry[]; error: string; more: boolean; onMore: () => Promise<boolean>; application: App }) {
  return (
    <div className='space-y-4'>
      <SectionHeader title='History' description={`Access changes made through ${application.name}: when, what, who, and whether from this page or from an MCP client.`} />
      {error ? (
        <p role='alert' className='text-sm text-text-secondary'>
          {error}
        </p>
      ) : entries.length === 0 ? (
        <Empty title='No access changes yet' />
      ) : (
        <>
          <Table aria-label='History'>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>What</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>From</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry, index) => (
                <TableRow key={`${entry.at}-${index}`}>
                  <TableCell>{formatTime(entry.at)}</TableCell>
                  <TableCell>{entry.action}</TableCell>
                  <TableCell>{entry.actor_email}</TableCell>
                  <TableCell>{entry.target}</TableCell>
                  <TableCell>{`${appLabel(entry.via_application, application)}, ${entry.via_client === 'mcp' ? 'MCP client' : 'this page'}`}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {more ? (
            <Button variant='secondary' size='sm' onClick={() => void onMore()}>
              Load older
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
