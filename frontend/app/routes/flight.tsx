import {
  AlertContainer,
  Button,
  Card,
  Empty,
  Input,
  LoadingSpinner,
  Modal,
  SectionHeader,
  Select,
  showAlert
} from '@gaulatti/bleecker';
import {
  ArrowDown,
  ArrowUp,
  GripVertical,
  Pause,
  Play,
  Plus,
  RefreshCcw,
  Repeat,
  SkipForward,
  Trash2
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiUrl } from '../utils/apiBaseUrl';
import { useGlobalProgramId } from '../utils/globalProgram';
import { useSSE } from '../hooks/useSSE';
import type { FlightCue, FlightCueKind, FlightMixerChange, FlightRuntime, FlightSequence, InstantItem, Scene, SongCatalogItem } from '../models/broadcast';
import {
  createFlightCue,
  getFlightCueDisplayLabel
} from '../utils/programFlightSequence';
import {
  activateFlightSequence,
  createFlightSequence,
  deactivateFlightSequence,
  deleteFlightSequence,
  fetchFlightSequences,
  goFlight,
  resetFlight,
  startFlight,
  stopFlight,
  updateFlightSequence
} from '../services/flight';
import type { Route } from './+types/flight';

const CUE_KIND_OPTIONS: { value: FlightCueKind; label: string }[] = [
  { value: 'scene', label: 'Switch scene' },
  { value: 'playSong', label: 'Play song' },
  { value: 'stopSong', label: 'Stop song' },
  { value: 'instant', label: 'Instant' },
  { value: 'mixer', label: 'Mixer' },
  { value: 'wait', label: 'Wait' },
  { value: 'waitForSongEnd', label: 'Wait for song end' },
  { value: 'sceneUpdate', label: 'Update scene' }
];

const MIXER_CHANNEL_OPTIONS: { value: Exclude<FlightMixerChange['channelId'], undefined>; label: string }[] = [
  { value: 'main', label: 'Main' },
  { value: 'song', label: 'Song' },
  { value: 'instants', label: 'Instants' },
  { value: 'sceneInstant', label: 'Scene Instant' },
  { value: 'stream', label: 'Stream' }
];

const TRANSITION_OPTIONS = [
  { value: 'cut', label: 'Cut' },
  { value: 'crescendo-prism', label: 'Crescendo Prism' },
  { value: 'velvet-eclipse', label: 'Velvet Eclipse' },
  { value: 'webm-stinger', label: 'WebM Stinger' }
];

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Flight Mode - TV Broadcast' }, { name: 'description', content: 'Broadcast flight mode cue list' }];
}

export default function FlightMode() {
  const [activeProgramId] = useGlobalProgramId();

  const [sequences, setSequences] = useState<FlightSequence[]>([]);
  const [activeSequenceId, setActiveSequenceId] = useState<number | null>(null);
  const [runtime, setRuntime] = useState<FlightRuntime | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const [scenes, setScenes] = useState<Scene[]>([]);
  const [songs, setSongs] = useState<SongCatalogItem[]>([]);
  const [instants, setInstants] = useState<InstantItem[]>([]);

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newSequenceName, setNewSequenceName] = useState('');

  const activeSequence = useMemo(
    () => sequences.find((seq) => seq.id === activeSequenceId) ?? null,
    [sequences, activeSequenceId]
  );

  const loadSequences = useCallback(async () => {
    try {
      const data = await fetchFlightSequences(activeProgramId);
      setSequences(data);
    } catch (err) {
      console.error('Failed to load flight sequences:', err);
      showAlert('Failed to load flight sequences.', 'error');
    }
  }, [activeProgramId]);

  const loadScenes = useCallback(async () => {
    try {
      const res = await fetch(apiUrl(`/program/${encodeURIComponent(activeProgramId)}/state`));
      if (!res.ok) return;
      const state = await res.json();
      const entries = Array.isArray(state?.scenes) ? state.scenes : [];
      setScenes(
        entries.map((entry: any) => entry.scene).filter((scene: unknown): scene is Scene => Boolean(scene))
      );
    } catch (err) {
      console.error('Failed to load scenes:', err);
    }
  }, [activeProgramId]);

  const loadSongs = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/songs?page=1&limit=1000'));
      if (!res.ok) return;
      const payload = await res.json();
      setSongs(Array.isArray(payload?.data) ? payload.data : []);
    } catch (err) {
      console.error('Failed to load songs:', err);
    }
  }, []);

  const loadInstants = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/instants'));
      if (!res.ok) return;
      const payload = await res.json();
      setInstants(Array.isArray(payload) ? payload : []);
    } catch (err) {
      console.error('Failed to load instants:', err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      setIsLoading(true);
      try {
        const [seqData, stateRes] = await Promise.all([
          fetchFlightSequences(activeProgramId),
          fetch(apiUrl(`/program/${encodeURIComponent(activeProgramId)}/state`)).then((res) =>
            res.ok ? res.json() : null
          )
        ]);

        if (cancelled) return;

        setSequences(seqData);
        setActiveSequenceId(stateRes?.activeFlightSequenceId ?? null);

        if (stateRes?.activeFlightSequenceId) {
          const active = seqData.find((seq: FlightSequence) => seq.id === stateRes.activeFlightSequenceId);
          if (active?.isRunning) {
            setRuntime({
              sequenceId: active.id,
              activeIndex: active.items.findIndex((cue) => cue.id === active.activeItemId),
              isRunning: active.isRunning,
              waitingForSongEnd: false,
              activeItemId: active.activeItemId,
              totalItems: active.items.length,
              loop: active.loop
            });
          }
        }

        const entries = Array.isArray(stateRes?.scenes) ? stateRes.scenes : [];
        setScenes(
          entries.map((entry: any) => entry.scene).filter((scene: unknown): scene is Scene => Boolean(scene))
        );
      } catch (err) {
        console.error('Failed to bootstrap flight mode:', err);
        showAlert('Failed to load flight mode data.', 'error');
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void bootstrap();
    void loadSongs();
    void loadInstants();

    return () => {
      cancelled = true;
    };
  }, [activeProgramId]);

  const handleSSE = useCallback(
    (data: any) => {
      if (!data || typeof data !== 'object') return;

      if (data.type === 'flight_update' && data.programId === activeProgramId) {
        setRuntime(data.runtime ?? null);
        if (typeof data.activeSequenceId === 'number' || data.activeSequenceId === null) {
          setActiveSequenceId(data.activeSequenceId);
        }
        return;
      }

      if (data.type === 'program_scenes_changed' && data.programId === activeProgramId) {
        const entries = Array.isArray(data.state?.scenes) ? data.state.scenes : [];
        setScenes(
          entries.map((entry: any) => entry.scene).filter((scene: unknown): scene is Scene => Boolean(scene))
        );
      }

      if (data.type === 'scene_update' && data.scene) {
        setScenes((prev) =>
          prev.map((scene) => (scene.id === data.scene.id ? data.scene : scene))
        );
      }
    },
    [activeProgramId]
  );

  useSSE({
    url: apiUrl(`/program/${encodeURIComponent(activeProgramId)}/events`),
    onMessage: handleSSE,
    enabled: true
  });

  const persistSequenceItems = useCallback(
    async (sequenceId: number, items: FlightCue[]) => {
      try {
        const updated = await updateFlightSequence(activeProgramId, sequenceId, { items });
        setSequences((prev) => prev.map((seq) => (seq.id === sequenceId ? updated : seq)));
      } catch (err) {
        console.error('Failed to save flight sequence:', err);
        showAlert(extractErrorMessage(err), 'error');
      }
    },
    [activeProgramId]
  );

  const handleCreateSequence = async () => {
    const name = newSequenceName.trim();
    if (!name) return;

    try {
      const created = await createFlightSequence(activeProgramId, { name, items: [] });
      setSequences((prev) => [...prev, created]);
      setNewSequenceName('');
      setIsCreateModalOpen(false);
      showAlert(`Sequence "${created.name}" created.`, 'success');
    } catch (err) {
      showAlert(extractErrorMessage(err), 'error');
    }
  };

  const handleDeleteSequence = async (sequenceId: number) => {
    if (!confirm('Delete this flight sequence?')) return;

    try {
      await deleteFlightSequence(activeProgramId, sequenceId);
      setSequences((prev) => prev.filter((seq) => seq.id !== sequenceId));
      if (activeSequenceId === sequenceId) {
        setActiveSequenceId(null);
        setRuntime(null);
      }
      showAlert('Sequence deleted.', 'success');
    } catch (err) {
      showAlert(extractErrorMessage(err), 'error');
    }
  };

  const handleActivateSequence = async (sequenceId: number) => {
    try {
      await activateFlightSequence(activeProgramId, sequenceId);
      setActiveSequenceId(sequenceId);
      setRuntime(null);
      showAlert('Sequence activated.', 'success');
    } catch (err) {
      showAlert(extractErrorMessage(err), 'error');
    }
  };

  const handleDeactivateSequence = async () => {
    try {
      await deactivateFlightSequence(activeProgramId);
      setActiveSequenceId(null);
      setRuntime(null);
      showAlert('Sequence deactivated.', 'success');
    } catch (err) {
      showAlert(extractErrorMessage(err), 'error');
    }
  };

  const handleToggleLoop = async () => {
    if (!activeSequence) return;

    try {
      const updated = await updateFlightSequence(activeProgramId, activeSequence.id, {
        loop: !activeSequence.loop
      });
      setSequences((prev) => prev.map((seq) => (seq.id === updated.id ? updated : seq)));
    } catch (err) {
      showAlert(extractErrorMessage(err), 'error');
    }
  };

  const handleAddCue = async (kind: FlightCueKind) => {
    if (!activeSequence) return;

    const cue = createFlightCue(kind);
    const items = [...activeSequence.items, cue];
    await persistSequenceItems(activeSequence.id, items);
  };

  const handleUpdateCue = async (cueId: string, patch: Partial<FlightCue>) => {
    if (!activeSequence) return;

    const items = activeSequence.items.map((cue) =>
      cue.id === cueId ? ({ ...cue, ...patch } as FlightCue) : cue
    );
    await persistSequenceItems(activeSequence.id, items);
  };

  const handleDeleteCue = async (cueId: string) => {
    if (!activeSequence) return;

    const items = activeSequence.items.filter((cue) => cue.id !== cueId);
    await persistSequenceItems(activeSequence.id, items);
  };

  const handleMoveCue = async (cueId: string, direction: 'up' | 'down') => {
    if (!activeSequence) return;

    const index = activeSequence.items.findIndex((cue) => cue.id === cueId);
    if (index < 0) return;

    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= activeSequence.items.length) return;

    const items = [...activeSequence.items];
    [items[index], items[newIndex]] = [items[newIndex], items[index]];
    await persistSequenceItems(activeSequence.id, items);
  };

  const sceneOptions = useMemo(
    () => scenes.map((scene) => ({ value: String(scene.id), label: scene.name })),
    [scenes]
  );

  const songOptions = useMemo(
    () =>
      songs.map((song) => ({
        value: String(song.id),
        label: `${song.artist || 'Unknown'} - ${song.title || 'Untitled'}`
      })),
    [songs]
  );

  const instantOptions = useMemo(
    () =>
      instants.map((instant) => ({
        value: String(instant.id),
        label: instant.name
      })),
    [instants]
  );

  const activeCueIndex = runtime?.activeIndex ?? -1;

  return (
    <div className='min-h-screen bg-zinc-950 text-zinc-100'>
      <AlertContainer />
      <div className='mx-auto max-w-7xl p-6'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
          <SectionHeader
            title='Flight Mode'
            description={`Program: ${activeProgramId}`}
          />
          <Button
            type='button'
            onClick={() => setIsCreateModalOpen(true)}
            className='flex items-center gap-2 rounded bg-sea px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-sea/90'
          >
            <Plus size={16} />
            New sequence
          </Button>
        </div>

        {isLoading ? (
          <div className='flex h-64 items-center justify-center'>
            <LoadingSpinner size='lg' />
          </div>
        ) : sequences.length === 0 ? (
          <Empty
            title='No flight sequences'
            description='Create a sequence to start building your broadcast rundown.'
            action={
              <Button
                type='button'
                onClick={() => setIsCreateModalOpen(true)}
                className='rounded bg-sea px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-sea/90'
              >
                Create sequence
              </Button>
            }
          />
        ) : (
          <div className='grid grid-cols-1 gap-6 lg:grid-cols-3'>
            <div className='lg:col-span-2 space-y-4'>
              <Card className='p-4'>
                <div className='flex flex-wrap items-center gap-3'>
                  <Select
                    value={activeSequenceId === null ? '' : String(activeSequenceId)}
                    onChange={(value) => {
                      const id = value ? Number(value) : null;
                      if (id !== activeSequenceId) {
                        setActiveSequenceId(id);
                        if (id !== null) {
                          void handleActivateSequence(id);
                        } else {
                          void handleDeactivateSequence();
                        }
                      }
                    }}
                    options={[
                      { value: '', label: 'Select a sequence...' },
                      ...sequences.map((seq) => ({ value: String(seq.id), label: seq.name }))
                    ]}
                    className='min-w-[240px]'
                  />

                  {activeSequence && (
                    <>
                      <Button
                        type='button'
                        onClick={handleToggleLoop}
                        className={`flex items-center gap-2 rounded px-3 py-2 text-xs font-semibold ${
                          activeSequence.loop
                            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                            : 'border border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
                        }`}
                      >
                        <Repeat size={14} />
                        {activeSequence.loop ? 'Loop on' : 'Loop off'}
                      </Button>

                      <Button
                        type='button'
                        onClick={() => activeSequence && handleDeleteSequence(activeSequence.id)}
                        className='flex items-center gap-2 rounded border border-red-900/50 bg-zinc-900 px-3 py-2 text-xs font-semibold text-red-400 hover:bg-red-950/30'
                      >
                        <Trash2 size={14} />
                        Delete
                      </Button>
                    </>
                  )}
                </div>

                {activeSequence && (
                  <div className='mt-4 flex flex-wrap gap-2'>
                    {CUE_KIND_OPTIONS.map((option) => (
                      <Button
                        key={option.value}
                        type='button'
                        onClick={() => handleAddCue(option.value)}
                        className='flex items-center gap-1.5 rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800'
                      >
                        <Plus size={12} />
                        {option.label}
                      </Button>
                    ))}
                  </div>
                )}
              </Card>

              {activeSequence ? (
                <Card className='divide-y divide-zinc-800'>
                  {activeSequence.items.length === 0 ? (
                    <div className='p-8 text-center text-sm text-zinc-500'>
                      No cues yet. Add one above.
                    </div>
                  ) : (
                    activeSequence.items.map((cue, index) => (
                      <CueRow
                        key={cue.id}
                        cue={cue}
                        index={index}
                        total={activeSequence.items.length}
                        isActive={index === activeCueIndex && Boolean(runtime?.isRunning)}
                        isPending={index > activeCueIndex && Boolean(runtime?.isRunning)}
                        isCompleted={index < activeCueIndex && Boolean(runtime?.isRunning)}
                        scenes={scenes}
                        songs={songs}
                        instants={instants}
                        sceneOptions={sceneOptions}
                        songOptions={songOptions}
                        instantOptions={instantOptions}
                        onUpdate={(patch) => handleUpdateCue(cue.id, patch)}
                        onDelete={() => handleDeleteCue(cue.id)}
                        onMove={(direction) => handleMoveCue(cue.id, direction)}
                      />
                    ))
                  )}
                </Card>
              ) : (
                <Card className='p-8 text-center text-sm text-zinc-500'>
                  Select or create a sequence to edit cues.
                </Card>
              )}
            </div>

            <div className='space-y-4'>
              <RuntimePanel
                activeSequence={activeSequence}
                runtime={runtime}
                instants={instants}
                onStart={() => void startFlight(activeProgramId).then(() => showAlert('Flight started.', 'success')).catch((err) => showAlert(extractErrorMessage(err), 'error'))}
                onStop={() => void stopFlight(activeProgramId).then(() => showAlert('Flight stopped.', 'success')).catch((err) => showAlert(extractErrorMessage(err), 'error'))}
                onGo={() => void goFlight(activeProgramId).then(() => showAlert('Advanced.', 'success')).catch((err) => showAlert(extractErrorMessage(err), 'error'))}
                onReset={() => void resetFlight(activeProgramId).then(() => showAlert('Flight reset.', 'success')).catch((err) => showAlert(extractErrorMessage(err), 'error'))}
              />
            </div>
          </div>
        )}
      </div>

      <Modal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        title='Create flight sequence'
      >
        <div className='space-y-4'>
          <label className='block text-sm font-medium text-zinc-300'>
            Sequence name
            <Input
              value={newSequenceName}
              onChange={(e) => setNewSequenceName(e.target.value)}
              placeholder='e.g. Main show rundown'
              className='mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-sea'
            />
          </label>
          <div className='flex justify-end gap-2'>
            <Button
              type='button'
              onClick={() => setIsCreateModalOpen(false)}
              className='rounded border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800'
            >
              Cancel
            </Button>
            <Button
              type='button'
              onClick={() => void handleCreateSequence()}
              className='rounded bg-sea px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-sea/90'
            >
              Create
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

interface CueRowProps {
  cue: FlightCue;
  index: number;
  total: number;
  isActive: boolean;
  isPending: boolean;
  isCompleted: boolean;
  scenes: Scene[];
  songs: SongCatalogItem[];
  instants: InstantItem[];
  sceneOptions: { value: string; label: string }[];
  songOptions: { value: string; label: string }[];
  instantOptions: { value: string; label: string }[];
  onUpdate: (patch: Partial<FlightCue>) => void;
  onDelete: () => void;
  onMove: (direction: 'up' | 'down') => void;
}

function CueRow({
  cue,
  index,
  total,
  isActive,
  isPending,
  isCompleted,
  scenes,
  songs,
  instants,
  sceneOptions,
  songOptions,
  instantOptions,
  onUpdate,
  onDelete,
  onMove
}: CueRowProps) {
  const statusClass = isActive
    ? 'border-l-4 border-l-sea bg-sea/5'
    : isCompleted
    ? 'border-l-4 border-l-zinc-600 opacity-60'
    : isPending
    ? 'border-l-4 border-l-zinc-800'
    : 'border-l-4 border-l-transparent';

  return (
    <div className={`p-4 ${statusClass}`}>
      <div className='flex items-start gap-3'>
        <div className='mt-1 text-zinc-600'>
          <GripVertical size={16} />
        </div>

        <div className='flex-1 space-y-3'>
          <div className='flex flex-wrap items-center gap-3'>
            <span className='flex h-6 w-6 items-center justify-center rounded-full bg-zinc-800 text-xs font-mono text-zinc-400'>
              {index + 1}
            </span>

            <Select
              value={cue.kind}
              onChange={(value) => onUpdate({ kind: value as FlightCueKind })}
              options={CUE_KIND_OPTIONS}
              className='min-w-[160px]'
            />

            <Input
              value={cue.label ?? ''}
              onChange={(e) => onUpdate({ label: e.target.value || undefined })}
              placeholder='Label (optional)'
              className='min-w-[180px] flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-sea'
            />

            {isActive && (
              <span className='flex items-center gap-1 rounded bg-sea/20 px-2 py-1 text-xs font-bold uppercase tracking-wider text-sea'>
                <Play size={10} />
                Active
              </span>
            )}
          </div>

          <CueFields
            cue={cue}
            scenes={scenes}
            songs={songs}
            instants={instants}
            sceneOptions={sceneOptions}
            songOptions={songOptions}
            instantOptions={instantOptions}
            onUpdate={onUpdate}
          />
        </div>

        <div className='flex flex-col gap-1'>
          <IconButton onClick={() => onMove('up')} disabled={index === 0} title='Move up'>
            <ArrowUp size={14} />
          </IconButton>
          <IconButton onClick={() => onMove('down')} disabled={index === total - 1} title='Move down'>
            <ArrowDown size={14} />
          </IconButton>
          <IconButton onClick={onDelete} variant='danger' title='Delete cue'>
            <Trash2 size={14} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

interface CueFieldsProps {
  cue: FlightCue;
  scenes: Scene[];
  songs: SongCatalogItem[];
  instants: InstantItem[];
  sceneOptions: { value: string; label: string }[];
  songOptions: { value: string; label: string }[];
  instantOptions: { value: string; label: string }[];
  onUpdate: (patch: Partial<FlightCue>) => void;
}

function CueFields({ cue, scenes, sceneOptions, songOptions, instantOptions, onUpdate }: CueFieldsProps) {
  switch (cue.kind) {
    case 'scene':
      return (
        <div className='flex flex-wrap gap-3'>
          <Select
            value={cue.sceneId !== undefined ? String(cue.sceneId) : ''}
            onChange={(value) => onUpdate({ sceneId: value ? Number(value) : undefined })}
            options={[{ value: '', label: 'Select scene...' }, ...sceneOptions]}
            className='min-w-[200px]'
          />
          <Select
            value={cue.transitionId || 'cut'}
            onChange={(value) => onUpdate({ transitionId: value })}
            options={TRANSITION_OPTIONS}
            className='min-w-[160px]'
          />
        </div>
      );

    case 'playSong':
      return (
        <Select
          value={cue.songId !== undefined ? String(cue.songId) : ''}
          onChange={(value) => onUpdate({ songId: value ? Number(value) : undefined })}
          options={[{ value: '', label: 'Select song...' }, ...songOptions]}
          className='min-w-[280px]'
        />
      );

    case 'wait':
      return (
        <label className='flex items-center gap-2 text-sm text-zinc-300'>
          Duration (ms)
          <Input
            type='number'
            min={0}
            step={100}
            value={cue.durationMs ?? 0}
            onChange={(e) => onUpdate({ durationMs: Number(e.target.value) })}
            className='w-32 rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-sea'
          />
        </label>
      );

    case 'sceneUpdate':
      return (
        <SceneUpdateFields cue={cue} scenes={scenes} sceneOptions={sceneOptions} onUpdate={onUpdate} />
      );

    case 'instant':
      return (
        <Select
          value={cue.instantId !== undefined ? String(cue.instantId) : ''}
          onChange={(value) => onUpdate({ instantId: value ? Number(value) : undefined })}
          options={[{ value: '', label: 'Select instant...' }, ...instantOptions]}
          className='min-w-[280px]'
        />
      );

    case 'mixer':
      return (
        <MixerCueFields cue={cue} onUpdate={onUpdate} />
      );

    case 'stopSong':
    case 'waitForSongEnd':
    default:
      return null;
  }
}

interface SceneUpdateFieldsProps {
  cue: FlightCue;
  scenes: Scene[];
  sceneOptions: { value: string; label: string }[];
  onUpdate: (patch: Partial<FlightCue>) => void;
}

function SceneUpdateFields({ cue, scenes, sceneOptions, onUpdate }: SceneUpdateFieldsProps) {
  const [newComponentType, setNewComponentType] = useState('');

  const selectedScene = useMemo(
    () => scenes.find((scene) => scene.id === cue.sceneId) ?? null,
    [scenes, cue.sceneId]
  );

  const currentMetadata = useMemo(() => {
    if (!selectedScene?.metadata) return {};
    try {
      const parsed = JSON.parse(selectedScene.metadata);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }, [selectedScene]);

  const patch = useMemo(
    () => (cue.metadataPatch && isRecord(cue.metadataPatch) ? cue.metadataPatch : {}),
    [cue.metadataPatch]
  );

  const effectiveMetadata = useMemo(
    () => (Object.keys(patch).length > 0 ? patch : currentMetadata),
    [currentMetadata, patch]
  );

  const updateEffectiveMetadata = (next: Record<string, unknown>) => {
    onUpdate({ metadataPatch: Object.keys(next).length > 0 ? next : undefined });
  };

  const updateComponentProp = (
    componentType: string,
    propKey: string,
    value: unknown
  ) => {
    const next: Record<string, unknown> = { ...effectiveMetadata };
    const component = isRecord(next[componentType])
      ? { ...next[componentType] }
      : {};
    component[propKey] = value;
    next[componentType] = component;
    updateEffectiveMetadata(next);
  };

  const removeComponentProp = (componentType: string, propKey: string) => {
    const next: Record<string, unknown> = { ...effectiveMetadata };
    const component = isRecord(next[componentType])
      ? { ...next[componentType] }
      : {};
    delete component[propKey];
    if (Object.keys(component).length === 0) {
      delete next[componentType];
    } else {
      next[componentType] = component;
    }
    updateEffectiveMetadata(next);
  };

  const addComponent = () => {
    const type = newComponentType.trim();
    if (!type || effectiveMetadata[type]) return;
    const next = { ...effectiveMetadata, [type]: {} };
    updateEffectiveMetadata(next);
    setNewComponentType('');
  };

  const removeComponent = (componentType: string) => {
    const next = { ...effectiveMetadata };
    delete next[componentType];
    updateEffectiveMetadata(next);
  };

  return (
    <div className='space-y-3'>
      <Select
        value={cue.sceneId !== undefined ? String(cue.sceneId) : ''}
        onChange={(value) => onUpdate({ sceneId: value ? Number(value) : undefined })}
        options={[{ value: '', label: 'Select scene...' }, ...sceneOptions]}
        className='min-w-[200px]'
      />

      {!selectedScene ? (
        <p className='text-sm text-zinc-500'>Select a scene to edit its properties.</p>
      ) : (
        <div className='space-y-3 rounded border border-zinc-800 bg-zinc-900/50 p-3'>
          <div className='flex items-center justify-between'>
            <span className='text-xs text-zinc-500'>
              {Object.keys(patch).length > 0
                ? 'Editing effective metadata'
                : 'Showing current scene metadata'}
            </span>
            <button
              type='button'
              onClick={() => updateEffectiveMetadata(currentMetadata)}
              className='text-xs font-medium text-sea hover:text-sea/80'
            >
              Reset to scene metadata
            </button>
          </div>

          <div className='flex items-center gap-2'>
            <Input
              value={newComponentType}
              onChange={(e) => setNewComponentType(e.target.value)}
              placeholder='Component type (e.g. chyron)'
              className='flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-sea'
            />
            <Button
              type='button'
              onClick={addComponent}
              disabled={!newComponentType.trim() || Boolean(effectiveMetadata[newComponentType.trim()])}
              className='flex items-center gap-1 rounded bg-sea px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-sea/90 disabled:opacity-50'
            >
              <Plus size={12} />
              Add
            </Button>
          </div>

          {Object.keys(effectiveMetadata).length === 0 && (
            <p className='text-xs text-zinc-500'>No properties yet. Add a component type above.</p>
          )}

          {Object.entries(effectiveMetadata).map(([componentType, componentProps]) => {
            const props = isRecord(componentProps) ? componentProps : {};
            return (
              <ComponentPropsCard
                key={componentType}
                componentType={componentType}
                props={props}
                isNew={currentMetadata[componentType] === undefined}
                onUpdateProp={(key, value) => updateComponentProp(componentType, key, value)}
                onRemoveProp={(key) => removeComponentProp(componentType, key)}
                onRemoveComponent={() => removeComponent(componentType)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

interface ComponentPropsCardProps {
  componentType: string;
  props: Record<string, unknown>;
  isNew: boolean;
  onUpdateProp: (key: string, value: unknown) => void;
  onRemoveProp: (key: string) => void;
  onRemoveComponent: () => void;
}

function ComponentPropsCard({
  componentType,
  props,
  isNew,
  onUpdateProp,
  onRemoveProp,
  onRemoveComponent
}: ComponentPropsCardProps) {
  const [newPropKey, setNewPropKey] = useState('');
  const [newPropValue, setNewPropValue] = useState('');

  const addProp = () => {
    const key = newPropKey.trim();
    if (!key || props[key] !== undefined) return;
    onUpdateProp(key, parsePropValue(newPropValue));
    setNewPropKey('');
    setNewPropValue('');
  };

  return (
    <div className='rounded border border-zinc-700 bg-zinc-900 p-3'>
      <div className='mb-2 flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <span className='font-mono text-sm font-semibold text-sea'>{componentType}</span>
          {isNew && (
            <span className='rounded bg-sea/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-sea'>
              New
            </span>
          )}
        </div>
        <button
          type='button'
          onClick={onRemoveComponent}
          title='Remove component'
          className='flex h-7 w-7 items-center justify-center rounded text-red-400 transition-colors hover:bg-red-950/30'
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className='space-y-2'>
        {Object.keys(props).length === 0 && (
          <p className='text-xs text-zinc-500'>No properties yet.</p>
        )}

        {Object.entries(props).map(([key, value]) => (
          <PropRow
            key={key}
            propKey={key}
            value={value}
            onChange={(next) => onUpdateProp(key, next)}
            onRemove={() => onRemoveProp(key)}
          />
        ))}

        <div className='flex items-center gap-2 pt-1'>
          <Input
            value={newPropKey}
            onChange={(e) => setNewPropKey(e.target.value)}
            placeholder='Property name'
            className='flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-sea'
          />
          <Input
            value={newPropValue}
            onChange={(e) => setNewPropValue(e.target.value)}
            placeholder='Value'
            className='flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-sea'
          />
          <Button
            type='button'
            onClick={addProp}
            disabled={!newPropKey.trim() || props[newPropKey.trim()] !== undefined}
            className='rounded bg-zinc-800 px-2 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-700 disabled:opacity-50'
          >
            Add
          </Button>
        </div>
      </div>
    </div>
  );
}

interface PropRowProps {
  propKey: string;
  value: unknown;
  onChange: (value: unknown) => void;
  onRemove: () => void;
}

function PropRow({ propKey, value, onChange, onRemove }: PropRowProps) {
  const type = inferValueType(value);

  return (
    <div className='flex items-center gap-2'>
      <span className='w-32 truncate font-mono text-xs text-zinc-400' title={propKey}>
        {propKey}
      </span>

      {type === 'boolean' ? (
        <button
          type='button'
          onClick={() => onChange(!Boolean(value))}
          className={`rounded px-2 py-1 text-xs font-semibold ${
            value ? 'bg-sea/20 text-sea' : 'bg-zinc-800 text-zinc-400'
          }`}
        >
          {value ? 'true' : 'false'}
        </button>
      ) : (
        <Input
          value={formatValueForInput(value)}
          onChange={(e) => onChange(parsePropValue(e.target.value))}
          className='flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-sea'
        />
      )}

      <button
        type='button'
        onClick={onRemove}
        title='Remove property'
        className='flex h-7 w-7 items-center justify-center rounded text-red-400 transition-colors hover:bg-red-950/30'
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

function inferValueType(value: unknown): 'string' | 'number' | 'boolean' | 'other' {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  return 'other';
}

function formatValueForInput(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

interface MixerCueFieldsProps {
  cue: FlightCue;
  onUpdate: (patch: Partial<FlightCue>) => void;
}

function MixerCueFields({ cue, onUpdate }: MixerCueFieldsProps) {
  const change = cue.mixerChange ?? {};

  return (
    <div className='flex flex-wrap items-center gap-3'>
      <Select
        value={change.channelId ?? ''}
        onChange={(value) =>
          onUpdate({
            mixerChange: {
              ...change,
              channelId: value ? (value as FlightMixerChange['channelId']) : undefined
            }
          })
        }
        options={[{ value: '', label: 'Select channel...' }, ...MIXER_CHANNEL_OPTIONS]}
        className='min-w-[160px]'
      />

      {change.channelId && (
        <>
          <label className='flex items-center gap-2 text-sm text-zinc-300'>
            Volume
            <Input
              type='number'
              min={0}
              max={1}
              step={0.05}
              value={change.volume ?? ''}
              onChange={(e) => {
                const nextVolume = e.target.value === '' ? undefined : Number(e.target.value);
                onUpdate({
                  mixerChange: { ...change, volume: nextVolume }
                });
              }}
              placeholder='0-1'
              className='w-24 rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-sea'
            />
          </label>

          <Button
            type='button'
            onClick={() =>
              onUpdate({
                mixerChange: { ...change, muted: !change.muted }
              })
            }
            className={`rounded px-3 py-1.5 text-xs font-semibold ${
              change.muted
                ? 'bg-red-600 text-white'
                : 'border border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
            }`}
          >
            {change.muted ? 'Muted' : 'Mute'}
          </Button>

          {change.channelId !== 'main' && (
            <Button
              type='button'
              onClick={() =>
                onUpdate({
                  mixerChange: { ...change, solo: !change.solo }
                })
              }
              className={`rounded px-3 py-1.5 text-xs font-semibold ${
                change.solo
                  ? 'bg-yellow-500 text-yellow-950'
                  : 'border border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
              }`}
            >
              {change.solo ? 'Soloed' : 'Solo'}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePropValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  const num = Number(trimmed);
  if (!Number.isNaN(num) && trimmed !== '') return num;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (isRecord(value) && isRecord(result[key])) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

interface RuntimePanelProps {
  activeSequence: FlightSequence | null;
  runtime: FlightRuntime | null;
  instants: InstantItem[];
  onStart: () => void;
  onStop: () => void;
  onGo: () => void;
  onReset: () => void;
}

function RuntimePanel({ activeSequence, runtime, instants, onStart, onStop, onGo, onReset }: RuntimePanelProps) {
  const isRunning = runtime?.isRunning ?? false;
  const activeCue = activeSequence && runtime ? activeSequence.items[runtime.activeIndex] : null;
  const nextCue = activeSequence && runtime ? activeSequence.items[runtime.activeIndex + 1] : null;

  return (
    <Card className='p-4'>
      <h3 className='text-sm font-bold uppercase tracking-widest text-zinc-400'>Runtime</h3>

      {!activeSequence ? (
        <p className='mt-4 text-sm text-zinc-500'>No active sequence.</p>
      ) : (
        <>
          <div className='mt-4 space-y-3'>
            <div>
              <div className='text-xs font-medium uppercase tracking-wider text-zinc-500'>Active cue</div>
              <div className='mt-1 text-sm font-semibold text-zinc-100'>
                {activeCue ? getFlightCueDisplayLabel(activeCue, { instants }) : '—'}
              </div>
            </div>

            <div>
              <div className='text-xs font-medium uppercase tracking-wider text-zinc-500'>Next cue</div>
              <div className='mt-1 text-sm text-zinc-300'>
                {nextCue ? getFlightCueDisplayLabel(nextCue, { instants }) : '—'}
              </div>
            </div>

            {runtime?.waitingForSongEnd && (
              <div className='rounded bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-300'>
                Waiting for song to end…
              </div>
            )}

            <div className='text-xs text-zinc-500'>
              Cue {runtime ? runtime.activeIndex + 1 : 0} of {activeSequence.items.length}
              {activeSequence.loop && ' (looping)'}
            </div>
          </div>

          <div className='mt-6 grid grid-cols-2 gap-2'>
            <Button
              type='button'
              onClick={isRunning ? onStop : onStart}
              className={`flex items-center justify-center gap-2 rounded px-4 py-2 text-sm font-bold ${
                isRunning
                  ? 'bg-red-600 text-white hover:bg-red-500'
                  : 'bg-green-600 text-white hover:bg-green-500'
              }`}
            >
              {isRunning ? <Pause size={16} /> : <Play size={16} />}
              {isRunning ? 'Stop' : 'Start'}
            </Button>

            <Button
              type='button'
              onClick={onGo}
              disabled={!activeSequence.items.length}
              className='flex items-center justify-center gap-2 rounded bg-sea px-4 py-2 text-sm font-bold text-zinc-950 hover:bg-sea/90 disabled:opacity-50'
            >
              <SkipForward size={16} />
              GO
            </Button>

            <Button
              type='button'
              onClick={onReset}
              className='col-span-2 flex items-center justify-center gap-2 rounded border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800'
            >
              <RefreshCcw size={16} />
              Reset
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

interface IconButtonProps {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: 'default' | 'danger';
  title?: string;
}

function IconButton({ children, onClick, disabled, variant = 'default', title }: IconButtonProps) {
  return (
    <button
      type='button'
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex h-7 w-7 items-center justify-center rounded transition-colors ${
        variant === 'danger'
          ? 'text-red-400 hover:bg-red-950/30'
          : 'text-zinc-400 hover:bg-zinc-800'
      } disabled:opacity-30`}
    >
      {children}
    </button>
  );
}
