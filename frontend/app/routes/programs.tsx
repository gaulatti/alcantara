import { TooltipButton } from "../components/BleeckerButtons";
import { AlertContainer, Button, Card, Checkbox, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Empty, IconButton, Input, LoadingSpinner, Modal, SectionHeader, StatePill, showAlert } from '@gaulatti/bleecker';
import { ExternalLink, Link2, MoreHorizontal, Pencil, Plus, Trash2, Radio, Tv } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Route } from './+types/programs';
import { apiUrl, getApiBaseUrl } from '../utils/apiBaseUrl';
import { useGlobalProgramId } from '../utils/globalProgram';
import { hasProgramCapability, resolveProgramOutputUrl, type ProgramTemplateManifest } from '../utils/programTemplate';
import { AppPage } from '../components/AppPage';
import { RenameFillerNotice } from '../components/RenameFillerNotice';

interface SceneSummary {
  id: number;
  name: string;
  layout?: {
    name?: string;
  } | null;
}
interface ProgramSceneEntry {
  id: number;
  sceneId: number;
  position: number;
  scene?: SceneSummary;
}

interface MediaGroupSummary {
  id: number;
  name: string;
  description?: string | null;
}

interface ProgramMediaGroupEntry {
  id: number;
  mediaGroupId: number;
  position: number;
  mediaGroup?: MediaGroupSummary;
}

interface StingerSummary {
  id: number;
  name: string;
}

interface ProgramStingerEntry {
  id: number;
  stingerId: number;
  position: number;
  stinger?: StingerSummary;
}

interface ProgramState {
  id: number;
  programId: string;
  type?: 'tv' | 'radio' | 'both';
  activeSceneId: number | null;
  scenes: ProgramSceneEntry[];
  mediaGroups: ProgramMediaGroupEntry[];
  stingers: ProgramStingerEntry[];
  templateUrl?: string | null;
  templateManifest?: ProgramTemplateManifest | null;
  templateVerifiedAt?: string | null;
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Shows - Alcantara' }, { name: 'description', content: 'Manage television, radio, and simulcast shows' }];
}

/** A refused show save, with the HTTP status and the server's own reason when it gave one. */
class ShowSaveRefused extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | null,
  ) {
    super(reason ?? `HTTP ${status}`);
  }
}

async function showSaveRefusal(response: Response): Promise<ShowSaveRefused> {
  const text = await response.text();
  let reason: string | null = text.trim() || null;
  try {
    // A JSON body (Nest's error shape) gives its message, or no reason at all: never the raw JSON.
    const message = (JSON.parse(text) as { message?: unknown } | null)?.message;
    reason = typeof message === 'string' ? message : Array.isArray(message) ? message.join('; ') : null;
  } catch {
    // A plain-text body is the reason itself.
  }
  return new ShowSaveRefused(response.status, reason);
}

/** The server's refusal of a rename onto an ID a deleted show's settings still hold (gaulatti/alcantara#122). */
const HELD_SHOW_ID_MESSAGE = "That ID belongs to a deleted show's settings. Choose another ID.";

/**
 * What the create or edit dialog says when saving fails. It used to say "Ensure the ID is unique" for every failure,
 * which sent operators after the wrong cause (the #744 walk).
 */
function showSaveErrorMessage(error: unknown, showSaved: boolean): string {
  if (showSaved)
    return 'The show was saved, but its scenes or stingers were not updated. Edit it to try again.';
  if (error instanceof ShowSaveRefused) {
    // An ID a deleted show's settings still hold is not a show the operator can see: say what the server said.
    if (error.status === 409)
      return error.reason === HELD_SHOW_ID_MESSAGE
        ? error.reason
        : 'A show with this ID already exists. Choose another ID.';
    if (error.status === 400 && error.reason)
      return `Failed to save show: ${error.reason}`;
    return `Failed to save show (HTTP ${error.status}). Nothing was saved.`;
  }
  return 'Failed to save show: the server could not be reached. Nothing was saved.';
}

export default function ProgramsAdmin() {
  const navigate = useNavigate();
  const [selectedProgramId, setSelectedProgramId] = useGlobalProgramId();

  const [programs, setPrograms] = useState<ProgramState[]>([]);
  const [allScenes, setAllScenes] = useState<SceneSummary[]>([]);
  const [allStingers, setAllStingers] = useState<StingerSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [showModal, setShowModal] = useState(false);
  const [editingProgramId, setEditingProgramId] = useState<string | null>(null);
  const [programIdInput, setProgramIdInput] = useState('');
  const [templateUrlInput, setTemplateUrlInput] = useState('');
  const [templatePreview, setTemplatePreview] = useState<ProgramTemplateManifest | null>(null);
  const [isInspectingTemplate, setIsInspectingTemplate] = useState(false);
  const [templateError, setTemplateError] = useState('');
  const [selectedSceneIds, setSelectedSceneIds] = useState<number[]>([]);
  const [selectedStingerIds, setSelectedStingerIds] = useState<number[]>([]);
  const [sceneSearch, setSceneSearch] = useState('');
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [selectedType, setSelectedType] = useState<'tv' | 'radio' | 'both'>('tv');

  const fetchPrograms = async (): Promise<ProgramState[]> => {
    const res = await fetch(apiUrl('/program'));
    if (!res.ok) throw new Error(`Failed to fetch programs: ${res.status}`);
    const data = (await res.json()) as ProgramState[];
    setPrograms(data);
    return data;
  };

  const fetchScenes = async (): Promise<SceneSummary[]> => {
    const res = await fetch(apiUrl('/scenes'));
    if (!res.ok) throw new Error(`Failed to fetch scenes: ${res.status}`);
    const data = (await res.json()) as SceneSummary[];
    setAllScenes(data);
    return data;
  };

  const fetchStingers = async (): Promise<StingerSummary[]> => {
    const res = await fetch(apiUrl('/stingers'));
    if (!res.ok) {
      throw new Error(`Failed to fetch stingers: ${res.status}`);
    }
    const data = (await res.json()) as StingerSummary[];
    setAllStingers(data);
    return data;
  };

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      try {
        await Promise.all([fetchPrograms(), fetchScenes(), fetchStingers()]);
      } catch (err) {
        console.error(err);
        showAlert('Failed to load programs. Please refresh and try again.', 'error');
      } finally {
        setIsLoading(false);
      }
    };
    void load();
  }, []);

  const sortedPrograms = useMemo(() => {
    return [...programs].sort((a, b) => a.programId.localeCompare(b.programId));
  }, [programs]);

  const sortedScenes = useMemo(() => {
    return [...allScenes].sort((a, b) => a.name.localeCompare(b.name));
  }, [allScenes]);

  const sortedStingers = useMemo(() => {
    return [...allStingers].sort((a, b) => a.name.localeCompare(b.name));
  }, [allStingers]);

  const filteredScenes = useMemo(() => {
    const query = sceneSearch.trim().toLocaleLowerCase();
    if (!query) return sortedScenes;
    return sortedScenes.filter((scene) =>
      [scene.name, scene.layout?.name].some((value) => value?.toLocaleLowerCase().includes(query))
    );
  }, [sceneSearch, sortedScenes]);

  const openCreateModal = () => {
    setEditingProgramId(null);
    setProgramIdInput('');
    setTemplateUrlInput('');
    setTemplatePreview(null);
    setTemplateError('');
    setSelectedSceneIds([]);
    setSelectedStingerIds([]);
    setSceneSearch('');
    setSelectedType('tv');
    setError('');
    setShowModal(true);
  };

  const openEditModal = (program: ProgramState) => {
    setEditingProgramId(program.programId);
    setProgramIdInput(program.programId);
    setTemplateUrlInput(program.templateUrl || '');
    setTemplatePreview(program.templateManifest || null);
    setTemplateError('');
    setSelectedSceneIds(program.scenes.map((entry) => entry.sceneId));
    setSelectedStingerIds(
      (program.stingers || []).map((entry) => entry.stingerId),
    );
    setSelectedType(program.type || 'tv');
    setSceneSearch('');
    setError('');
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingProgramId(null);
    setProgramIdInput('');
    setTemplateUrlInput('');
    setTemplatePreview(null);
    setTemplateError('');
    setSelectedSceneIds([]);
    setSelectedStingerIds([]);
    setSceneSearch('');
    setSelectedType('tv');
    setError('');
  };

  const toggleSceneSelection = (sceneId: number) => {
    setSelectedSceneIds((current) => {
      if (current.includes(sceneId)) {
        return current.filter((id) => id !== sceneId);
      }
      return [...current, sceneId];
    });
  };

  const toggleStingerSelection = (stingerId: number) => {
    setSelectedStingerIds((current) => {
      if (current.includes(stingerId)) {
        return current.filter((id) => id !== stingerId);
      }
      return [...current, stingerId];
    });
  };

  const syncProgramScenes = async (programId: string, currentSceneIds: number[], nextSceneIds: number[]) => {
    const currentSet = new Set(currentSceneIds);
    const nextSet = new Set(nextSceneIds);

    const sceneIdsToRemove = currentSceneIds.filter((sceneId) => !nextSet.has(sceneId));
    const sceneIdsToAdd = nextSceneIds.filter((sceneId) => !currentSet.has(sceneId));

    await Promise.all(
      sceneIdsToRemove.map(async (sceneId) => {
        const res = await fetch(apiUrl(`/program/${encodeURIComponent(programId)}/scenes/${sceneId}`), {
          method: 'DELETE'
        });
        if (!res.ok) {
          throw new Error(`Failed to remove scene ${sceneId} from ${programId} (${res.status})`);
        }
      })
    );

    for (const sceneId of sceneIdsToAdd) {
      const res = await fetch(apiUrl(`/program/${encodeURIComponent(programId)}/scenes`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneId })
      });
      if (!res.ok) {
        throw new Error(`Failed to add scene ${sceneId} to ${programId} (${res.status})`);
      }
    }
  };

  const syncProgramStingers = async (
    programId: string,
    currentStingerIds: number[],
    nextStingerIds: number[],
  ) => {
    const currentSet = new Set(currentStingerIds);
    const nextSet = new Set(nextStingerIds);

    const stingerIdsToRemove = currentStingerIds.filter(
      (stingerId) => !nextSet.has(stingerId),
    );
    const stingerIdsToAdd = nextStingerIds.filter(
      (stingerId) => !currentSet.has(stingerId),
    );

    await Promise.all(
      stingerIdsToRemove.map(async (stingerId) => {
        const res = await fetch(
          apiUrl(`/program/${encodeURIComponent(programId)}/stingers/${stingerId}`),
          { method: 'DELETE' },
        );
        if (!res.ok) {
          throw new Error(
            `Failed to remove stinger ${stingerId} from ${programId} (${res.status})`,
          );
        }
      }),
    );

    for (const stingerId of stingerIdsToAdd) {
      const res = await fetch(
        apiUrl(`/program/${encodeURIComponent(programId)}/stingers`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stingerId }),
        },
      );
      if (!res.ok) {
        throw new Error(
          `Failed to add stinger ${stingerId} to ${programId} (${res.status})`,
        );
      }
    }
  };

  const inspectTemplate = async () => {
    const templateUrl = templateUrlInput.trim();
    /* v8 ignore start -- the Inspect button is disabled while the template URL is empty, so inspectTemplate never runs without one; this guard is defensive. */
    if (!templateUrl) {
      setTemplatePreview(null);
      setTemplateError('Enter a template manifest URL to inspect.');
      return;
    }
    /* v8 ignore stop */

    setIsInspectingTemplate(true);
    setTemplateError('');
    try {
      const response = await fetch(apiUrl('/program/template/inspect'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateUrl }),
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `HTTP ${response.status}`);
      }
      const registration = (await response.json()) as {
        templateManifest: ProgramTemplateManifest;
      };
      setTemplatePreview(registration.templateManifest);
    } catch (inspectionError) {
      console.error('Failed to inspect program template:', inspectionError);
      setTemplatePreview(null);
      setTemplateError('The template contract could not be verified.');
    } finally {
      setIsInspectingTemplate(false);
    }
  };

  const saveProgram = async () => {
    const nextProgramId = programIdInput.trim();
    if (!nextProgramId) {
      setError('Program ID is required.');
      return;
    }

    setIsSaving(true);
    // Set once the show itself is saved: a failure after that is in syncing its scenes or stingers.
    let showSaved = false;
    try {
      const isEditing = !!editingProgramId;
      /* v8 ignore next -- editingProgramId is set only from a listed program, and the list is replaced only by a reload; the fallback covers a reload that drops the program mid-edit, and no UI path opens the edit without a listed program. */
      const editingProgram = isEditing ? programs.find((program) => program.programId === editingProgramId) || null : null;
      let savedProgram: ProgramState;
      const isVisualProgram = selectedType !== 'radio';
      const templateUrl = isVisualProgram ? templateUrlInput.trim() || null : null;

      if (isEditing) {
        const res = await fetch(apiUrl(`/program/${encodeURIComponent(editingProgramId)}`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nextProgramId,
            type: selectedType,
            templateUrl,
          }),
        });
        if (!res.ok) throw await showSaveRefusal(res);
        savedProgram = (await res.json()) as ProgramState;
        showSaved = true;

        /* v8 ignore next -- editingProgramId is set only from a listed program, and the list is replaced only by a reload; the fallback covers a reload that drops the program mid-edit, and no UI path opens the edit without a listed program. */
        const currentSceneIds = editingProgram?.scenes.map((entry) => entry.sceneId) || [];
        /* v8 ignore next -- editingProgramId is set only from a listed program, and the list is replaced only by a reload; the fallback covers a reload that drops the program mid-edit, and no UI path opens the edit without a listed program. */
        const currentStingerIds = editingProgram?.stingers.map((entry) => entry.stingerId) || [];
        if (isVisualProgram) {
          if (!savedProgram.templateManifest || hasProgramCapability(savedProgram.templateManifest, 'scene.configuration')) {
            await syncProgramScenes(nextProgramId, currentSceneIds, selectedSceneIds);
          }
          if (!savedProgram.templateManifest || hasProgramCapability(savedProgram.templateManifest, 'stinger.transitions')) {
            await syncProgramStingers(nextProgramId, currentStingerIds, selectedStingerIds);
          }
        }
      } else {
        const createRes = await fetch(apiUrl('/program'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            programId: nextProgramId,
            type: selectedType,
            templateUrl,
          }),
        });
        if (!createRes.ok) throw await showSaveRefusal(createRes);
        savedProgram = (await createRes.json()) as ProgramState;
        showSaved = true;

        if (isVisualProgram && (!savedProgram.templateManifest || hasProgramCapability(savedProgram.templateManifest, 'scene.configuration'))) {
          await syncProgramScenes(nextProgramId, [], selectedSceneIds);
        }
        if (isVisualProgram && (!savedProgram.templateManifest || hasProgramCapability(savedProgram.templateManifest, 'stinger.transitions'))) {
          await syncProgramStingers(nextProgramId, [], selectedStingerIds);
        }
      }

      if (isEditing && editingProgramId === selectedProgramId) {
        setSelectedProgramId(nextProgramId);
      } else if (!isEditing) {
        setSelectedProgramId(nextProgramId);
      }

      await fetchPrograms();
      closeModal();
      showAlert(isEditing ? 'Show updated.' : 'Show created.', 'success');
    } catch (err) {
      console.error('Failed to save program:', err);
      setError(showSaveErrorMessage(err, showSaved));
      showAlert('Failed to save show.', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const supportsSceneConfiguration = selectedType !== 'radio' && (!templatePreview || hasProgramCapability(templatePreview, 'scene.configuration'));
  const supportsStingers = selectedType !== 'radio' && (!templatePreview || hasProgramCapability(templatePreview, 'stinger.transitions'));

  // Delete is confirmed by name in a dialog before it is sent (gaulatti/alcantara#349).
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const deleteProgram = async (programId: string) => {

    try {
      const res = await fetch(apiUrl(`/program/${encodeURIComponent(programId)}`), {
        method: 'DELETE'
      });

      if (!res.ok) {
        const responseText = await res.text();
        throw new Error(responseText || `HTTP ${res.status}`);
      }

      const nextPrograms = await fetchPrograms();
      if (selectedProgramId === programId) {
        const fallbackProgramId = nextPrograms[0]?.programId || 'main';
        setSelectedProgramId(fallbackProgramId);
      }
      showAlert('Show deleted.', 'success');
    } catch (err) {
      console.error('Failed to delete program:', err);
      showAlert('Failed to delete show.', 'error');
    }
  };

  return (
    <AppPage width='wide'>
      <AlertContainer />
      <div className='mx-auto max-w-5xl space-y-6'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
          <SectionHeader
            title='Shows'
            description='Create and organize TV, radio, or simulcast shows and their production assets.'
          />
          <div className='flex flex-wrap items-center gap-3'>
            <Button onClick={openCreateModal}>
              <Plus size={16} />
              Create show
            </Button>
          </div>
        </div>

        <Card className='space-y-4'>
          {isLoading ? (
            <div className='flex flex-col items-center justify-center gap-3 py-10 text-center text-text-secondary dark:text-text-secondary'>
              <LoadingSpinner />
              <p>Loading programs...</p>
            </div>
          ) : sortedPrograms.length === 0 ? (
            <Empty title='No shows yet' description='Create your first show.' action={<Button onClick={openCreateModal}>Create show</Button>} />
          ) : (
            <div className='space-y-3'>
              {sortedPrograms.map((program) => {
                const isSelected = selectedProgramId === program.programId;

                return (
                  <article
                    key={program.id}
                    className={`rounded-2xl border p-4 transition-colors ${
                      isSelected
                        ? 'border-sea bg-sea/10  '
                        : 'border-sand/20 bg-white/80 hover:border-sea/30 dark:border-sand/40 dark:bg-dark-sand/60 '
                    }`}
                  >
                    <div className='flex items-start justify-between gap-4 max-sm:flex-col'>
                      <div className='min-w-0 flex-1'>
                        <div className='flex flex-wrap items-center gap-2'>
                          <h3 className='text-lg font-semibold text-text-primary dark:text-text-primary'>{program.programId}</h3>
                          <StatePill
                            tone='info'
                            label={program.type === 'radio' ? 'Radio' : program.type === 'both' ? 'Simulcast' : 'TV'}
                          />
                          {isSelected ? <StatePill tone='live' label='Active' /> : null}
                        </div>
                        {program.type === 'radio' ? (
                          <p className='mt-2 text-sm text-text-secondary dark:text-text-secondary'>Audio-only show · Songs, audio clips, mixer, and Radio distribution</p>
                        ) : (
                          <p className='mt-2 text-sm text-text-secondary dark:text-text-secondary'>
                            Scenes assigned: {program.scenes.length} · Media labels are available globally · Stingers assigned: {(program.stingers || []).length} · Active scene:{' '}
                            {program.activeSceneId ?? 'none'}
                          </p>
                        )}
                        {program.type !== 'radio' && program.templateManifest ? (
                          <div className='mt-3 flex flex-wrap items-center gap-2 text-xs text-text-secondary'>
                            <StatePill tone='ok' label='Renderer ready' />
                            <Link2 size={13} />
                            <span>
                              {program.templateManifest.name} · {program.templateManifest.bundleVersion}
                            </span>
                            <a href={resolveProgramOutputUrl(program, getApiBaseUrl())} target='_blank' rel='noopener noreferrer' className='inline-flex items-center gap-1 font-medium text-sea underline-offset-2 hover:underline'>
                              Open renderer <ExternalLink size={12} />
                            </a>
                          </div>
                        ) : program.type !== 'radio' ? (
                          <div className='mt-3 flex flex-wrap items-center gap-2 text-xs text-text-secondary'>
                            <StatePill tone='idle' label='No template' />
                            <span>Uses the built-in Alcantara renderer; no external template is registered.</span>
                          </div>
                        ) : null}

                      </div>
                      <div className='flex items-start gap-2'>
                        <Button
                          size='sm'
                          variant={isSelected ? 'secondary' : 'ghost'}
                          onClick={() => setSelectedProgramId(program.programId)}
                          className='px-3'
                          aria-label={`Select ${program.programId}`}
                        >
                          Select
                        </Button>
                        <IconButton
                          onClick={() => openEditModal(program)}
                          className='text-sea '
                          title={`Edit ${program.programId}`}
                          aria-label={`Edit ${program.programId}`}
                        >
                          <Pencil size={16} />
                        </IconButton>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <IconButton title={`Actions for ${program.programId}`} aria-label={`Actions for ${program.programId}`}>
                              <MoreHorizontal size={16} />
                            </IconButton>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align='end'>
                            <DropdownMenuItem onSelect={() => setPendingDelete(program.programId)}>
                              <Trash2 size={14} className='mr-2' /> Delete show
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </Card>

        <Modal isOpen={pendingDelete !== null} onClose={() => setPendingDelete(null)} title='Confirm delete'>
          <div className='space-y-4'>
            <p className='text-sm text-text-secondary'>
              Delete show &ldquo;{pendingDelete}&rdquo;? This removes its scene assignments and active scene state.
            </p>
            <div className='flex justify-end gap-2'>
              <Button variant='ghost' onClick={() => setPendingDelete(null)}>Cancel</Button>
              <Button
                variant='destructive'
                onClick={() => {
                  const target = pendingDelete;
                  setPendingDelete(null);
                  if (target) void deleteProgram(target);
                }}
              >
                Delete show
              </Button>
            </div>
          </div>
        </Modal>

        {/* Anchored to the top, not centered: picking Radio hides the TV fields, and a centered dialog moved the toggle just clicked about 100 px (the walk's polish). */}
        <Modal isOpen={showModal} onClose={closeModal} title={editingProgramId ? 'Edit show' : 'Create show'} className='mt-[8vh] mb-auto'>
          <div className='space-y-5'>
            <div>
              <label htmlFor='show-id' className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Show ID</label>
              <Input
                id='show-id'
                value={programIdInput}
                onChange={(e) => {
                  setProgramIdInput(e.target.value);
                  if (error) {
                    setError('');
                  }
                }}
                // Not "main": an example, not a value, and never the name of an existing show (the rundown-building walk).
                placeholder='morning-show'
                error={!!error}
                autoFocus
              />
              {editingProgramId ? <RenameFillerNotice programId={editingProgramId} nextProgramId={programIdInput} /> : null}
            </div>

            <div>
              <p id='show-type-label' className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Show type</p>
              <div role='group' aria-labelledby='show-type-label' className='flex gap-2'>
                {(['tv', 'radio', 'both'] as const).map((type) => (
                  <TooltipButton
                    key={type}
                    type='button'
                    onClick={() => setSelectedType(type)}
                    aria-pressed={selectedType === type}
                    className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                      selectedType === type
                        ? 'border-sea bg-sea/10 text-sea'
                        : 'border-sand/20 bg-white/70 text-text-secondary hover:border-sea/30 dark:border-sand/40 dark:bg-dark-sand/50'
                    }`}
                  >
                    {type === 'radio' ? <Radio size={14} /> : type === 'both' ? <><Tv size={14} /><Radio size={14} /></> : <Tv size={14} />}
                    {type === 'tv' ? 'TV' : type === 'radio' ? 'Radio' : 'Simulcast'}
                  </TooltipButton>
                ))}
              </div>
              {selectedType === 'radio' ? (
                <p className='mt-2 rounded-xl border border-sea/20 bg-sea/5 p-3 text-sm text-text-secondary'>
                  Radio is audio-only. Configure songs, audio clips, the mixer, and distribution from the Radio desk.
                </p>
              ) : null}
            </div>

            {selectedType !== 'radio' ? <div>
              <label htmlFor='show-template-url' className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Template URL</label>
              <div className='flex items-start gap-2'>
                <Input
                  id='show-template-url'
                  type='url'
                  value={templateUrlInput}
                  onChange={(event) => {
                    setTemplateUrlInput(event.target.value);
                    setTemplatePreview(null);
                    setTemplateError('');
                  }}
                  placeholder='https://cdn.fifthbell.com/html/program-releases/0.1.65/live-program-manifest.json'
                  aria-describedby='template-url-help'
                  error={!!templateError}
                />
                <Button type='button' variant='secondary' onClick={() => void inspectTemplate()} disabled={isInspectingTemplate || !templateUrlInput.trim()}>
                  {isInspectingTemplate ? 'Inspecting…' : 'Inspect'}
                </Button>
              </div>
              <p id='template-url-help' className='mt-2 text-xs text-text-secondary'>
                Reference the immutable JSON manifest published with the template. Alcantara verifies its contract before saving.
              </p>
              {templateError ? (
                <p className='mt-2 text-sm text-terracotta' role='alert'>
                  {templateError}
                </p>
              ) : null}
              {templatePreview ? (
                <div className='mt-3 rounded-xl border border-sea/20 bg-sea/5 p-3'>
                  <p className='text-sm font-medium text-text-primary'>
                    {templatePreview.name} · {templatePreview.bundleVersion}
                  </p>
                  <div className='mt-2 flex flex-wrap gap-1.5'>
                    {templatePreview.capabilities.map((capability) => (
                      <span key={capability} className='rounded-full border border-sea/20 bg-white/70 px-2 py-0.5 text-xs text-sea dark:bg-dark-sand/70'>
                        {capability}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div> : null}

            {supportsSceneConfiguration ? (
              <div>
                <div className='mb-2 flex items-center justify-between'>
                  <label className='block text-sm font-medium text-text-primary dark:text-text-primary'>Program Scenes</label>
                  <Button size='sm' variant='ghost' onClick={() => navigate('/scenes')}>
                    Manage Scenes
                  </Button>
                </div>
                {sortedScenes.length === 0 ? (
                  <p className='text-sm text-text-secondary dark:text-text-secondary'>No scenes available. Create scenes first.</p>
                ) : (
                  <div className='max-h-64 space-y-2 overflow-y-auto rounded-xl border border-sand/20 bg-white/70 p-3 dark:border-sand/40 dark:bg-dark-sand/50'>
                    <Input type='search' value={sceneSearch} onChange={(event) => setSceneSearch(event.target.value)} placeholder='Search scenes by name or layout…' aria-label='Search program scenes' className='sticky top-0 z-10 w-full border-sand/30 bg-white/95 px-3 py-2 text-sm dark:bg-dark-sand/95' />
                    {filteredScenes.map((scene) => {
                      const checked = selectedSceneIds.includes(scene.id);
                      return (
                        <label key={scene.id} className='flex cursor-pointer items-start gap-3 rounded-lg px-2 py-1.5 hover:bg-sand/10 dark:hover:bg-sand/15'>
                          <Checkbox checked={checked} onChange={() => toggleSceneSelection(scene.id)} />
                          <span className='min-w-0'>
                            <span className='block text-sm font-medium text-text-primary dark:text-text-primary'>{scene.name}</span>
                            <span className='block text-xs text-text-secondary dark:text-text-secondary'>{scene.layout?.name || 'No layout'}</span>
                          </span>
                        </label>
                      );
                    })}
                    {filteredScenes.length === 0 ? <p className='px-2 py-4 text-center text-sm text-text-secondary'>No scenes match “{sceneSearch}”.</p> : null}
                  </div>
                )}
              </div>
            ) : selectedType !== 'radio' ? (
              <p className='rounded-xl border border-sand/20 bg-white/60 p-3 text-sm text-text-secondary dark:bg-dark-sand/50'>Scene assignment is unavailable because this template does not declare scene configuration.</p>
            ) : null}

            {supportsStingers ? (
              <div>
                <div className='mb-2 flex items-center justify-between'>
                  <label className='block text-sm font-medium text-text-primary dark:text-text-primary'>Program Stingers</label>
                  <Button size='sm' variant='ghost' onClick={() => navigate('/stingers')}>
                    Manage Stingers
                  </Button>
                </div>
                {sortedStingers.length === 0 ? (
                  <p className='text-sm text-text-secondary dark:text-text-secondary'>No stingers available. Create stingers first.</p>
                ) : (
                  <div className='max-h-64 space-y-2 overflow-y-auto rounded-xl border border-sand/20 bg-white/70 p-3 dark:border-sand/40 dark:bg-dark-sand/50'>
                    {sortedStingers.map((stinger) => {
                      const checked = selectedStingerIds.includes(stinger.id);
                      return (
                        <label key={stinger.id} className='flex cursor-pointer items-start gap-3 rounded-lg px-2 py-1.5 hover:bg-sand/10 dark:hover:bg-sand/15'>
                          <Checkbox checked={checked} onChange={() => toggleStingerSelection(stinger.id)} />
                          <span className='min-w-0'>
                            <span className='block text-sm font-medium text-text-primary dark:text-text-primary'>{stinger.name}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : null}

            {error ? <p className='text-sm text-terracotta'>{error}</p> : null}

            <div className='flex justify-end gap-3'>
              <Button variant='secondary' onClick={closeModal} disabled={isSaving}>
                Cancel
              </Button>
              <Button onClick={saveProgram} disabled={isSaving}>
                {isSaving ? 'Saving...' : editingProgramId ? 'Update show' : 'Create show'}
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    </AppPage>
  );
}
