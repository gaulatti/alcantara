import { Button, Card, Empty, ErrorState, Field, Input, PageHeader, Select, SkeletonCard } from '@gaulatti/bleecker';
import { Copy, Link2, RefreshCw } from 'lucide-react';
import { createLocalAudioTrack, Room } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { authFetch } from '../services/api';
import { useFeatures } from '../hooks/useFeatures';
import { useGlobalProgramId } from '../utils/globalProgram';
import { apiUrl } from '../utils/apiBaseUrl';
import type { Route } from './+types/calls';
import { AppPage } from '../components/AppPage';
import { GuestStrip } from '../components/GuestStrip';
import { WaitingGuest } from '../components/WaitingGuest';
import { HostMicOnAir } from '../components/HostMicOnAir';
import { callFailureReason, roomIcePath, type CallFailure, type IcePath } from '../utils/callTelemetry';
import { deskSlots, emptySlotLabel, latestCue, stripState } from '../utils/callerDesk';
import '../components/CallerDesk.css';

type Command = {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  createdAt: string;
};
type Invitation = {
  id: string;
  programId: string;
  displayName: string;
  slotNumber: number;
  returnVideo: 'program' | 'preview' | 'none';
  returnAudioBus: string;
  sourceGain: number;
  sourceMuted: boolean;
  sourceDelayMs: number;
  expiresAt: string;
  status: 'available' | 'active' | 'revoked' | 'expired';
  commands?: Command[];
};
type Participant = {
  invitationId: string;
  identity: string;
  name: string;
  slotNumber: number;
  connectionState: 'connected' | 'reconnecting' | 'offline';
  returnVideo: Invitation['returnVideo'];
  returnAudioBus: string;
  sourceGain: number;
  sourceMuted: boolean;
  sourceDelayMs: number;
  tracks: Array<{ sid: string; source: string; muted: boolean }>;
  commands: Command[];
  // Joined and not admitted yet; absent from a backend without screening.
  screening?: boolean;
  // Whether the call ever reported from the room; absent from an older backend.
  everJoined?: boolean;
  icePath?: IcePath | null;
  joinFailure?: CallFailure | null;
  // Whether the guest's own page has the return, from its latest report (null until it reports).
  returnReaching?: 'healthy' | 'stalled' | 'missing' | null;
};
// Whether the studio sends the return to guests: a return router publishing mix-minus tracks is in the room.
type RoomReturn = { returnSending: boolean; returnParticipant: string | null };

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Guest Calls - Alcántara' }];
}
async function readError(response: Response) {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { message?: string };
    return parsed.message || text;
  } catch {
    return text || `Request failed (${response.status})`;
  }
}

/**
 * Copies the link inside the tap that asked for it. The text arrives as a promise, so iOS Safari and Android
 * Chrome keep the user gesture while the invitation is created. False when the browser refuses; the link stays on screen.
 */
async function copyLinkFromTap(created: Promise<{ url: string }>): Promise<boolean> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false;
  // A failed link is reported by the create itself; this copy only needs to stay quiet about it.
  const blob = created.then((invitation) => new Blob([invitation.url], { type: 'text/plain' }));
  blob.catch(() => undefined);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
    return true;
  } catch {
    return false;
  }
}

const CONTROL_PLANE_UNREACHABLE = "The guest-call control plane can't be reached. Guests can't join until it is back.";

export default function CallsRoute() {
  const [programId] = useGlobalProgramId();
  const { hasPermission } = useFeatures();
  const canOperate = hasPermission('alcantara:webrtc:operate');
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [roomReturn, setRoomReturn] = useState<RoomReturn | null>(null);
  // When the desk last heard from the API, and how many polls in a row have failed since: a waiting guest must never
  // sit unseen behind a desk that silently stopped updating.
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [failedPolls, setFailedPolls] = useState(0);
  const [displayName, setDisplayName] = useState('');
  const [expiresInHours, setExpiresInHours] = useState('24');
  const [createdUrl, setCreatedUrl] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [livekitEnabled, setLivekitEnabled] = useState<boolean | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  // The control plane being unreachable is named; any other failure (server text included) is not shown.
  const [loadError, setLoadError] = useState<string | null>(null);
  const talkbackRef = useRef<{
    room: Room;
    track: Awaited<ReturnType<typeof createLocalAudioTrack>>;
  } | null>(null);

  const refresh = useCallback(async () => {
    // A network failure names the missing control plane, not "fetch failed".
    const configResponse = await fetch(apiUrl('/webrtc/config')).catch(() => {
      throw new Error(CONTROL_PLANE_UNREACHABLE);
    });
    if (!configResponse.ok) throw new Error(await readError(configResponse));
    const config = (await configResponse.json()) as { enabled?: boolean };
    const enabled = config.enabled === true;
    setLivekitEnabled(enabled);
    if (!enabled) {
      setInvitations([]);
      setParticipants([]);
      return;
    }
    const [invitationResponse, participantResponse] = await Promise.all([
      authFetch('/webrtc/invitations'),
      authFetch(`/webrtc/rooms/${encodeURIComponent(programId)}/participants`)
    ]);
    if (!invitationResponse.ok) throw new Error(await readError(invitationResponse));
    if (!participantResponse.ok) throw new Error(await readError(participantResponse));
    const allInvitations = (await invitationResponse.json()) as Invitation[];
    const room = (await participantResponse.json()) as {
      participants: Participant[];
      room?: RoomReturn;
    };
    setInvitations(allInvitations.filter((item) => item.programId === programId));
    setParticipants(room.participants);
    setRoomReturn(room.room ?? null);
    setUpdatedAt(new Date());
    setFailedPolls(0);
  }, [programId]);

  const load = useCallback(() => {
    setLoadState('loading');
    return refresh().then(
      () => {
        setLoadError(null);
        setLoadState('ready');
      },
      (error) => {
        console.error('Unable to load guest calls:', error);
        setLoadError(error instanceof Error && error.message === CONTROL_PLANE_UNREACHABLE ? CONTROL_PLANE_UNREACHABLE : null);
        setLoadState('error');
      }
    );
  }, [refresh]);

  useEffect(() => {
    void load();
    const poll = () => void refresh().catch(() => setFailedPolls((count) => count + 1));
    const timer = window.setInterval(poll, 3000);
    // A browser slows timers in a hidden tab to about once a minute, so the desk catches up the moment it is looked at.
    const onVisible = () => {
      if (document.visibilityState === 'visible') poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', poll);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', poll);
      const talkback = talkbackRef.current;
      if (talkback) {
        talkback.track.stop();
        talkback.room.disconnect();
      }
    };
  }, [refresh, load]);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setNotice('');
    try {
      await action();
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Action failed.');
    } finally {
      setBusy(null);
    }
  };

  // One tap creates the link and copies it. The copy starts in the same tap (see copyLinkFromTap); a refused copy
  // leaves the link on screen with a Copy button.
  const createInvitation = () =>
    run('create', async () => {
      const pending = requestInvitation();
      const copy = copyLinkFromTap(pending);
      const created = await pending;
      setCreatedUrl(created.url);
      setDisplayName('');
      const copied = await copy;
      setNotice(
        copied
          ? `Guest slot ${created.slotNumber} is ready. The private link is copied: send it to the guest.`
          : `Guest slot ${created.slotNumber} is ready. Copy the private link below and send it to the guest.`
      );
    });

  const requestInvitation = async () => {
    const response = await authFetch('/webrtc/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        programId,
        displayName,
        expiresInHours: Number(expiresInHours)
      })
    });
    if (!response.ok) throw new Error(await readError(response));
    const created = (await response.json()) as Invitation & {
      invitationPath: string;
    };
    return { slotNumber: created.slotNumber, url: `${window.location.origin}${created.invitationPath}` };
  };

  const screen = (id: string, answer: 'admit' | 'decline') =>
    run(`${answer}-${id}`, async () => {
      const response = await authFetch(`/webrtc/invitations/${id}/${answer}`, { method: 'POST' });
      if (!response.ok) throw new Error(await readError(response));
      if (answer === 'decline') setNotice('The guest was declined: their link no longer works and the slot is free.');
    });

  const mutateInvitation = (id: string, action: 'replace' | 'revoke') =>
    run(`${action}-${id}`, async () => {
      const response = await authFetch(`/webrtc/invitations/${id}${action === 'replace' ? '/replace' : ''}`, {
        method: action === 'replace' ? 'POST' : 'DELETE'
      });
      if (!response.ok) throw new Error(await readError(response));
      if (action === 'replace') {
        const replacement = (await response.json()) as Invitation & {
          invitationPath: string;
        };
        setCreatedUrl(`${window.location.origin}${replacement.invitationPath}`);
        setNotice(`Replacement link for slot ${replacement.slotNumber} is ready. Copy it now.`);
      }
    });

  const updateReturn = (invitation: Invitation, field: 'returnVideo' | 'returnAudioBus' | 'sourceGain' | 'sourceMuted' | 'sourceDelayMs', value: string | number | boolean) =>
    run(`return-${invitation.id}`, async () => {
      const response = await authFetch(`/webrtc/invitations/${invitation.id}/return`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          returnVideo: field === 'returnVideo' ? value : invitation.returnVideo,
          returnAudioBus: field === 'returnAudioBus' ? value : invitation.returnAudioBus,
          sourceGain: field === 'sourceGain' ? value : invitation.sourceGain,
          sourceMuted: field === 'sourceMuted' ? value : invitation.sourceMuted,
          sourceDelayMs: field === 'sourceDelayMs' ? value : invitation.sourceDelayMs
        })
      });
      if (!response.ok) throw new Error(await readError(response));
    });

  const command = (participant: Participant, payload: Record<string, unknown>) =>
    run(`command-${participant.identity}`, async () => {
      const response = await authFetch(`/webrtc/rooms/${encodeURIComponent(programId)}/participants/${encodeURIComponent(participant.identity)}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(await readError(response));
      if (payload.type === 'message') setDrafts((current) => ({ ...current, [participant.identity]: '' }));
    });

  const remove = (participant: Participant) =>
    run(`remove-${participant.identity}`, async () => {
      const response = await authFetch(`/webrtc/rooms/${encodeURIComponent(programId)}/participants/${encodeURIComponent(participant.identity)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(await readError(response));
    });

  // Hold-to-talk (alcantara#301): releasing always closes the microphone, even
  // when the release comes before the connection is up.
  const [talkingTo, setTalkingTo] = useState<string | null>(null);
  const talkWanted = useRef<string | null>(null);
  const closeTalkback = () => {
    const talkback = talkbackRef.current;
    talkbackRef.current = null;
    if (talkback) {
      talkback.track.stop();
      talkback.room.disconnect();
    }
  };
  const stopTalk = () => {
    talkWanted.current = null;
    setTalkingTo(null);
    closeTalkback();
  };
  // The operator's side of whether calls work, counted by the API; a report that fails changes nothing here.
  const reportTalkback = async (result: CallFailure | 'success', icePath: IcePath | null) => {
    try {
      await authFetch('/webrtc/operator-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result, icePath })
      });
    } catch {
      // Nothing to do: the talkback itself has its own error.
    }
  };
  const startTalk = async (participant: Participant) => {
    if (talkWanted.current) return;
    talkWanted.current = participant.identity;
    setTalkingTo(participant.identity);
    setNotice('');
    try {
      const response = await authFetch('/webrtc/operator-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ programId })
      });
      if (!response.ok) throw new Error(await readError(response));
      const credentials = (await response.json()) as {
        serverUrl: string;
        token: string;
      };
      const room = new Room();
      await room.connect(credentials.serverUrl, credentials.token);
      const track = await createLocalAudioTrack();
      talkbackRef.current = { room, track };
      if (talkWanted.current !== participant.identity) {
        closeTalkback();
        return;
      }
      // Only the guest this talkback is for may receive it, through the return router that builds that guest's mix:
      // LiveKit enforces subscription permissions on the server, so no other guest, no renderer and not the on-air
      // contribution can subscribe to it whatever their page asks for.
      room.localParticipant.setTrackSubscriptionPermissions(false, [
        { participantIdentity: participant.identity, allowAll: true },
        { participantIdentity: `return-router-${programId}`, allowAll: true }
      ]);
      await room.localParticipant.publishTrack(track, {
        name: `talkback:${participant.invitationId}`
      });
      void roomIcePath(room).then((icePath) => reportTalkback('success', icePath));
    } catch (error) {
      void reportTalkback(callFailureReason(error), null);
      stopTalk();
      setNotice(error instanceof Error ? error.message : 'Talkback failed.');
    }
  };

  const activeInvitations = invitations.filter((item) => item.status !== 'revoked' && item.status !== 'expired');
  const createBlockedReason = !canOperate
    ? 'You do not have permission to create guest links.'
    : activeInvitations.length >= 6
      ? 'All 6 guest slots are assigned. Revoke a link to free one.'
      : !displayName.trim()
        ? 'Enter a guest name to create a private link.'
        : null;
  const createLink = (
    <Button fullWidth disabled={createBlockedReason !== null} aria-describedby={createBlockedReason ? 'create-blocked-reason' : undefined} loading={busy === 'create'} onClick={() => void createInvitation()}>
      <Link2 size={15} /> Create private link
    </Button>
  );
  const slots = deskSlots(activeInvitations, participants);
  const toAdmit = slots.filter((slot) => slot.invitation && slot.participant?.screening);
  const waiting = slots.filter((slot) => slot.invitation && !slot.participant?.screening && (!slot.participant || slot.participant.connectionState === 'offline'));
  const cuedLive = participants.filter((participant) => stripState(participant.connectionState, latestCue(participant.commands)) === 'cued-live').length;
  if (livekitEnabled === false) {
    return (
      <AppPage width='wide'>
        <div>
          <PageHeader title='Guest calls' description='Remote contribution is installed but its control plane is not deployed here.' />
          <Empty
            title='Guest calls need LiveKit'
            description='The LiveKit stack (alcantara#51) is not configured on this deployment, so no guest can join yet. Invitations, the caller desk and talkback appear once it is.'
          />
        </div>
      </AppPage>
    );
  }
  return (
    <AppPage width='wide'>
      <div>
        <PageHeader
          title='Guest calls'
          description={`Six reusable remote-contributor slots for ${programId}. Guests never enter Preview or Program automatically.`}
          actions={
            <Button variant='secondary' onClick={() => void refresh().catch((error) => {
                console.error('Unable to refresh guest calls:', error);
                setNotice('Guest calls could not be refreshed.');
              })}>
              <RefreshCw size={15} /> Refresh
            </Button>
          }
        />
        <section className='caller-desk-status' aria-label='Caller desk status'>
          <span className='caller-desk-count' data-live={cuedLive > 0}>
            {cuedLive} {cuedLive === 1 ? 'guest' : 'guests'} cued live
          </span>
          <span>Room {programId}</span>
          <span>{activeInvitations.length} of 6 slots in use</span>
          <span>{livekitEnabled ? 'LiveKit connected' : 'Checking LiveKit…'}</span>
          {updatedAt ? <span>Updated {updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span> : null}
          <HostMicOnAir programId={programId} canOperate={canOperate} />
        </section>
        {failedPolls >= 2 ? (
          <div role='alert' className='mb-5 rounded-[var(--radius-ui)] border border-terracotta/30 bg-terracotta/[0.08] px-4 py-3 text-sm'>
            The desk is not updating: the last {failedPolls} refreshes failed. Guests who join now may not appear until it
            recovers. Press Refresh, or reload the page.
          </div>
        ) : null}
        {notice ? (
          <div role='status' aria-live='polite' className='mb-5 rounded-[var(--radius-ui)] border border-sea/20 bg-sea/[0.06] px-4 py-3 text-sm'>
            {notice}
          </div>
        ) : null}
        {createdUrl ? (
          <Card variant='subtle' className='mb-6 p-5'>
            <p className='consumer-section-label'>Private invitation, shown once</p>
            <p className='mt-2 break-all font-mono text-xs'>{createdUrl}</p>
            <Button className='mt-3' size='sm' onClick={() => void navigator.clipboard.writeText(createdUrl).then(() => setNotice('Private invitation copied.'))}>
              <Copy size={14} /> Copy invitation
            </Button>
          </Card>
        ) : null}
        <div className='caller-desk'>
          <aside className='caller-desk-queue' aria-label='Waiting and invitations'>
            <section aria-label='Waiting'>
              <h2 className='text-sm font-semibold'>Waiting · {toAdmit.length + waiting.length}</h2>
              {toAdmit.length + waiting.length ? (
                <ul className='caller-desk-waiting'>
                  {toAdmit.map(({ slot, invitation }) => (
                    <WaitingGuest
                      key={invitation!.id}
                      invitationId={invitation!.id}
                      name={invitation!.displayName}
                      slot={slot}
                      canOperate={canOperate}
                      busy={busy !== null}
                      onAdmit={() => void screen(invitation!.id, 'admit')}
                      onDecline={() => void screen(invitation!.id, 'decline')}
                    />
                  ))}
                  {waiting.map(({ slot, invitation }) => (
                    <li key={slot}>
                      <strong>{invitation!.displayName}</strong>
                      <span className='text-xs text-text-secondary'>
                        Slot {slot} · invited, not joined · expires {new Date(invitation!.expiresAt).toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className='text-xs text-text-secondary'>No one is waiting to join.</p>
              )}
              <p className='caller-desk-gap'>A guest who joins waits here, off air, until you press Admit.</p>
            </section>
            <Card variant='outlined' className='p-5'>
              <h2 className='text-base font-medium'>Create invitation</h2>
              <p className='mt-1 text-sm text-text-secondary'>{activeInvitations.length}/6 slots assigned</p>
              <div className='mt-4 space-y-4'>
                <Field label='Guest name'>
                  <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder='Fictional guest' maxLength={80} />
                </Field>
                <Field label='Expires after'>
                  <Select
                    value={expiresInHours}
                    onChange={setExpiresInHours}
                    options={[
                      { value: '1', label: '1 hour' },
                      { value: '6', label: '6 hours' },
                      { value: '24', label: '24 hours (default)' },
                      { value: '72', label: '3 days' },
                      { value: '168', label: '7 days' }
                    ]}
                  />
                </Field>
                {createLink}
                {createBlockedReason ? (
                  <p id='create-blocked-reason' className='text-xs text-text-secondary'>
                    {createBlockedReason}
                  </p>
                ) : null}
              </div>
            </Card>
          </aside>
          <section className='caller-desk-strips' aria-label='Guest slots'>
            {loadState !== 'loading' ? (
              <p className='text-sm font-medium' data-return-sending={roomReturn ? String(roomReturn.returnSending) : 'unknown'}>
                {roomReturn === null
                  ? 'Return to guests: unknown'
                  : roomReturn.returnSending
                    ? 'Return to guests: sending (program audio)'
                    : 'Return to guests: not sending'}
              </p>
            ) : null}
            {loadState === 'loading' ? (
              <div role='status' aria-label='Loading guest slots'>
                <SkeletonCard rows={3} />
              </div>
            ) : loadState === 'error' ? (
              <ErrorState title='Guest calls could not be loaded' description={loadError ?? 'The guest-call list could not be loaded. Check the connection and try again.'} onRetry={() => void load()} retryLabel='Retry' />
            ) : activeInvitations.length === 0 ? (
              <Empty
                title='No assigned guest slots'
                description='To invite a guest: type their name, choose how long the link lasts, then press Create private link. The link is copied for you to send. The guest opens it on their phone and joins.'
                action={createLink}
              />
            ) : (
              slots.map(({ slot, invitation, participant }) => {
                if (participant?.screening && invitation) {
                  return (
                    <div key={slot} className='guest-strip guest-strip-free' aria-label={`Slot ${slot}: waiting`}>
                      <span className='guest-strip-slot'>{String(slot).padStart(2, '0')}</span>
                      <span className='text-xs text-amber-300'>{invitation.displayName} · waiting to be let in</span>
                    </div>
                  );
                }
                if (!participant || !invitation) {
                  return (
                    <div key={slot} className='guest-strip guest-strip-free' aria-label={`Slot ${slot}: free`}>
                      <span className='guest-strip-slot'>{String(slot).padStart(2, '0')}</span>
                      <span className='text-xs text-text-secondary'>{invitation ? `${invitation.displayName} · ${emptySlotLabel(invitation.status)}` : 'Free'}</span>
                    </div>
                  );
                }
                return (
                  <GuestStrip
                    key={slot}
                    participant={participant}
                    expiresAt={invitation.expiresAt}
                    // "Invited, not joined" only for a guest who never reached the room: a dropped call also leaves the
                    // invitation without a live lease, and must still read "Dropped". An older backend says neither.
                    neverJoined={participant.everJoined === false}
                    canOperate={canOperate}
                    busy={busy !== null}
                    talking={talkingTo === participant.identity}
                    draft={drafts[participant.identity] || ''}
                    onDraftChange={(value) => setDrafts((current) => ({ ...current, [participant.identity]: value }))}
                    onReturn={(field, value) => void updateReturn(invitation, field, value)}
                    onCommand={(payload) => void command(participant, payload)}
                    onTalkStart={() => void startTalk(participant)}
                    onTalkStop={stopTalk}
                    onReplace={() => void mutateInvitation(invitation.id, 'replace')}
                    onRemove={() => void remove(participant)}
                    onRevoke={() => void mutateInvitation(invitation.id, 'revoke')}
                  />
                );
              })
            )}
          </section>
        </div>
      </div>
    </AppPage>
  );
}
