import { Button, Card, Empty, Field, Input, PageHeader, Select, StatusBadge } from '@gaulatti/bleecker';
import { Copy, Headphones, Link2, Mic, MicOff, RefreshCw, Send, Trash2, Video, VideoOff } from 'lucide-react';
import { createLocalAudioTrack, Room } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { authFetch } from '../services/api';
import { useFeatures } from '../hooks/useFeatures';
import { PERMISSIONS } from '../auth/permissions';
import { useGlobalProgramId } from '../utils/globalProgram';
import type { Route } from './+types/calls';

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
};

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

export default function CallsRoute() {
  const [programId] = useGlobalProgramId();
  const { hasPermission } = useFeatures();
  const canOperate = hasPermission(PERMISSIONS.webrtc.operate);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [expiresInHours, setExpiresInHours] = useState('24');
  const [createdUrl, setCreatedUrl] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const talkbackRef = useRef<{
    room: Room;
    track: Awaited<ReturnType<typeof createLocalAudioTrack>>;
  } | null>(null);

  const refresh = useCallback(async () => {
    const [invitationResponse, participantResponse] = await Promise.all([
      authFetch('/webrtc/invitations'),
      authFetch(`/webrtc/rooms/${encodeURIComponent(programId)}/participants`)
    ]);
    if (!invitationResponse.ok) throw new Error(await readError(invitationResponse));
    if (!participantResponse.ok) throw new Error(await readError(participantResponse));
    const allInvitations = (await invitationResponse.json()) as Invitation[];
    const room = (await participantResponse.json()) as {
      participants: Participant[];
    };
    setInvitations(allInvitations.filter((item) => item.programId === programId));
    setParticipants(room.participants);
  }, [programId]);

  useEffect(() => {
    void refresh().catch((error) => setNotice(error instanceof Error ? error.message : 'Unable to load calls.'));
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 3000);
    return () => {
      window.clearInterval(timer);
      const talkback = talkbackRef.current;
      if (talkback) {
        talkback.track.stop();
        talkback.room.disconnect();
      }
    };
  }, [refresh]);

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

  const createInvitation = () =>
    run('create', async () => {
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
      setCreatedUrl(`${window.location.origin}${created.invitationPath}`);
      setDisplayName('');
      setNotice(`Guest slot ${created.slotNumber} is ready. Copy the private URL now.`);
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

  const startTalkback = (participant: Participant) =>
    run(`talkback-${participant.identity}`, async () => {
      if (talkbackRef.current) {
        talkbackRef.current.track.stop();
        talkbackRef.current.room.disconnect();
        talkbackRef.current = null;
        setNotice('Talkback stopped.');
        return;
      }
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
      await room.localParticipant.publishTrack(track, {
        name: `talkback:${participant.invitationId}`
      });
      talkbackRef.current = { room, track };
      setNotice(`Private talkback is live to ${participant.name}. Select it again to stop.`);
    });

  const activeInvitations = invitations.filter((item) => item.status !== 'revoked' && item.status !== 'expired');
  return (
    <main className='consumer-page'>
      <div className='consumer-page__content'>
        <PageHeader
          title='Guest calls'
          description={`Six reusable remote-contributor slots for ${programId}. Guests never enter Preview or Program automatically.`}
          actions={
            <Button variant='secondary' onClick={() => void refresh()}>
              <RefreshCw size={15} /> Refresh
            </Button>
          }
        />
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
        <div className='grid items-start gap-6 xl:grid-cols-[0.72fr_1.28fr]'>
          <Card variant='outlined' className='p-6'>
            <h2 className='text-xl font-medium'>Create invitation</h2>
            <p className='mt-1 text-sm text-text-secondary'>{activeInvitations.length}/6 slots assigned</p>
            <div className='mt-5 space-y-4'>
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
              <Button fullWidth disabled={!canOperate || !displayName.trim() || activeInvitations.length >= 6} loading={busy === 'create'} onClick={() => void createInvitation()}>
                <Link2 size={15} /> Create private link
              </Button>
            </div>
          </Card>
          <div className='space-y-4'>
            {participants.length === 0 ? (
              <Empty title='No assigned guest slots' description='Create an invitation to reserve the first reusable slot.' />
            ) : (
              participants.map((participant) => {
                const invitation = invitations.find((item) => item.id === participant.invitationId);
                if (!invitation) return null;
                const microphone = participant.tracks.find((track) => track.source.includes('microphone'));
                const camera = participant.tracks.find((track) => track.source.includes('camera'));
                const draft = drafts[participant.identity] || '';
                const latest = participant.commands[0];
                return (
                  <Card key={participant.invitationId} variant='surface' className='p-5'>
                    <div className='flex flex-wrap items-center gap-3'>
                      <span className='flex h-9 w-9 items-center justify-center rounded-full bg-sea/10 font-semibold text-sea'>{participant.slotNumber}</span>
                      <div className='min-w-0 flex-1'>
                        <h3 className='truncate font-medium'>{participant.name}</h3>
                        <p className='text-xs text-text-secondary'>
                          Slot {participant.slotNumber} · expires {new Date(invitation.expiresAt).toLocaleString()}
                        </p>
                      </div>
                      <StatusBadge
                        label={participant.connectionState}
                        variant={participant.connectionState === 'connected' ? 'live' : participant.connectionState === 'reconnecting' ? 'offline' : 'default'}
                      />
                    </div>
                    <div className='mt-4 grid gap-3 sm:grid-cols-2'>
                      <Field label='Return video'>
                        <Select
                          value={participant.returnVideo}
                          disabled={!canOperate}
                          onChange={(value) => void updateReturn(invitation, 'returnVideo', value)}
                          options={[
                            { value: 'program', label: 'Program' },
                            { value: 'preview', label: 'Preview' },
                            { value: 'none', label: 'None' }
                          ]}
                        />
                      </Field>
                      <Field label='Return audio'>
                        <Select
                          value={participant.returnAudioBus}
                          disabled={!canOperate}
                          onChange={(value) => void updateReturn(invitation, 'returnAudioBus', value)}
                          options={[
                            { value: 'master', label: 'Program / Master' },
                            { value: 'monitor', label: 'Operator monitor' },
                            ...Array.from({ length: 8 }, (_, index) => ({
                              value: `aux-${index + 1}`,
                              label: `Aux / IFB ${index + 1}`
                            }))
                          ]}
                        />
                      </Field>
                    </div>
                    <div className='mt-3 grid gap-3 sm:grid-cols-3'>
                      <Field label='Guest level in returns'>
                        <Select
                          value={String(participant.sourceGain)}
                          disabled={!canOperate}
                          onChange={(value) => void updateReturn(invitation, 'sourceGain', Number(value))}
                          options={[0, 0.25, 0.5, 0.75, 1].map((value) => ({
                            value: String(value),
                            label: `${Math.round(value * 100)}%`
                          }))}
                        />
                      </Field>
                      <Field label='Guest sync delay'>
                        <Select
                          value={String(participant.sourceDelayMs)}
                          disabled={!canOperate}
                          onChange={(value) => void updateReturn(invitation, 'sourceDelayMs', Number(value))}
                          options={[0, 50, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000].map((value) => ({
                            value: String(value),
                            label: `${value} ms`
                          }))}
                        />
                      </Field>
                      <Field label='Guest routing'>
                        <Button
                          fullWidth
                          variant={participant.sourceMuted ? 'destructive' : 'secondary'}
                          disabled={!canOperate}
                          onClick={() => void updateReturn(invitation, 'sourceMuted', !participant.sourceMuted)}
                        >
                          {participant.sourceMuted ? <MicOff size={14} /> : <Mic size={14} />}
                          {participant.sourceMuted ? 'Muted in returns' : 'Routed to returns'}
                        </Button>
                      </Field>
                    </div>
                    <div className='mt-4 flex flex-wrap gap-2'>
                      <Button
                        size='sm'
                        variant='secondary'
                        disabled={!canOperate || !camera || busy !== null}
                        onClick={() =>
                          void command(participant, {
                            type: 'media',
                            device: 'camera',
                            enabled: Boolean(camera?.muted)
                          })
                        }
                      >
                        {camera?.muted ? <VideoOff size={14} /> : <Video size={14} />} {camera?.muted ? 'Request camera' : 'Mute camera'}
                      </Button>
                      <Button
                        size='sm'
                        variant='secondary'
                        disabled={!canOperate || !microphone || busy !== null}
                        onClick={() =>
                          void command(participant, {
                            type: 'media',
                            device: 'microphone',
                            enabled: Boolean(microphone?.muted)
                          })
                        }
                      >
                        {microphone?.muted ? <MicOff size={14} /> : <Mic size={14} />} {microphone?.muted ? 'Request mic' : 'Mute mic'}
                      </Button>
                      {(['standby', 'live', 'wrap'] as const).map((cue) => (
                        <Button
                          key={cue}
                          size='sm'
                          variant={cue === 'live' ? 'destructive' : 'secondary'}
                          disabled={!canOperate || participant.connectionState !== 'connected' || busy !== null}
                          onClick={() => void command(participant, { type: 'cue', cue })}
                        >
                          {cue}
                        </Button>
                      ))}
                      <Button
                        size='sm'
                        variant='secondary'
                        disabled={!canOperate || participant.connectionState !== 'connected' || busy !== null}
                        onClick={() => void startTalkback(participant)}
                      >
                        <Headphones size={14} /> Talkback
                      </Button>
                    </div>
                    <div className='mt-3 flex gap-2'>
                      <Input
                        aria-label={`Message ${participant.name}`}
                        value={draft}
                        maxLength={500}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [participant.identity]: event.target.value
                          }))
                        }
                        placeholder='Private studio message'
                      />
                      <Button
                        size='sm'
                        disabled={!canOperate || !draft.trim() || busy !== null}
                        onClick={() =>
                          void command(participant, {
                            type: 'message',
                            text: draft
                          })
                        }
                      >
                        <Send size={14} />
                      </Button>
                    </div>
                    {latest ? (
                      <p className='mt-3 text-xs text-text-secondary'>
                        Latest {latest.type}: <strong>{latest.status}</strong>
                      </p>
                    ) : null}
                    <div className='mt-4 flex flex-wrap gap-2 border-t border-sand/20 pt-4'>
                      <Button size='sm' variant='secondary' disabled={!canOperate || busy !== null} onClick={() => void mutateInvitation(invitation.id, 'replace')}>
                        <RefreshCw size={14} /> Replace link
                      </Button>
                      <Button
                        size='sm'
                        variant='secondary'
                        disabled={!canOperate || participant.connectionState === 'offline' || busy !== null}
                        onClick={() => void remove(participant)}
                      >
                        Remove session
                      </Button>
                      <Button size='sm' variant='destructive' disabled={!canOperate || busy !== null} onClick={() => void mutateInvitation(invitation.id, 'revoke')}>
                        <Trash2 size={14} /> Revoke
                      </Button>
                    </div>
                  </Card>
                );
              })
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
