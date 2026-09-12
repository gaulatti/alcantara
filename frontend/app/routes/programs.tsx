import { AlertContainer, Button, Card, Checkbox, Empty, IconButton, Input, LoadingSpinner, Modal, SectionHeader, showAlert } from '@gaulatti/bleecker';
import { ExternalLink, Link2, Pencil, Plus, Trash2, Radio, Tv } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Route } from './+types/programs';
import { apiUrl, getApiBaseUrl } from '../utils/apiBaseUrl';
import { useGlobalProgramId } from '../utils/globalProgram';
import { hasProgramCapability, resolveProgramOutputUrl, type ProgramTemplateManifest } from '../utils/programTemplate';
import { AppPage } from '../components/AppPage';

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

export default function ProgramsAdmin() {
  const navigate = useNavigate();
  const [selectedProgramId, setSelectedProgramId] = useGlobalProgramId();

  const [programs, setPrograms] = useState<ProgramState[]>([]);
  const [allScenes, setAllScenes] = useState<SceneSummary[]>([]);
  const [allMediaGroups, setAllMediaGroups] = useState<MediaGroupSummary[]>([]);
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
  const [selectedMediaGroupIds, setSelectedMediaGroupIds] = useState<number[]>(
    [],
  );
  const [selectedStingerIds, setSelectedStingerIds] = useState<number[]>([]);
  const [sceneSearch, setSceneSearch] = useState('');
  const [mediaGroupSearch, setMediaGroupSearch] = useState('');
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

  const fetchMediaGroups = async (): Promise<MediaGroupSummary[]> => {
    const res = await fetch(apiUrl('/media-groups?limit=0'));
    if (!res.ok) {
      throw new Error(`Failed to fetch media groups: ${res.status}`);
    }
    const body = (await res.json()) as { data: MediaGroupSummary[] };
    setAllMediaGroups(body.data);
    return body.data;
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
        await Promise.all([fetchPrograms(), fetchScenes(), fetchMediaGroups(), fetchStingers()]);
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

  const sortedMediaGroups = useMemo(() => {
    return [...allMediaGroups].sort((a, b) => a.name.localeCompare(b.name));
  }, [allMediaGroups]);

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

  const filteredMediaGroups = useMemo(() => {
    const query = mediaGroupSearch.trim().toLocaleLowerCase();
    if (!query) return sortedMediaGroups;
    return sortedMediaGroups.filter((mediaGroup) =>
      [mediaGroup.name, mediaGroup.description].some((value) => value?.toLocaleLowerCase().includes(query))
    );
  }, [mediaGroupSearch, sortedMediaGroups]);

  const openCreateModal = () => {
    setEditingProgramId(null);
    setProgramIdInput('');
    setTemplateUrlInput('');
    setTemplatePreview(null);
    setTemplateError('');
    setSelectedSceneIds([]);
    setSelectedMediaGroupIds([]);
    setSelectedStingerIds([]);
    setSceneSearch('');
    setMediaGroupSearch('');
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
    setSelectedMediaGroupIds(
      (program.mediaGroups || []).map((entry) => entry.mediaGroupId),
    );
    setSelectedStingerIds(
      (program.stingers || []).map((entry) => entry.stingerId),
    );
    setSelectedType(program.type || 'tv');
    setSceneSearch('');
    setMediaGroupSearch('');
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
    setSelectedMediaGroupIds([]);
    setSelectedStingerIds([]);
    setSceneSearch('');
    setMediaGroupSearch('');
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

  const toggleMediaGroupSelection = (mediaGroupId: number) => {
    setSelectedMediaGroupIds((current) => {
      if (current.includes(mediaGroupId)) {
        return current.filter((id) => id !== mediaGroupId);
      }
      return [...current, mediaGroupId];
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

  const syncProgramMediaGroups = async (
    programId: string,
    currentMediaGroupIds: number[],
    nextMediaGroupIds: number[],
  ) => {
    const currentSet = new Set(currentMediaGroupIds);
    const nextSet = new Set(nextMediaGroupIds);

    const mediaGroupIdsToRemove = currentMediaGroupIds.filter(
      (mediaGroupId) => !nextSet.has(mediaGroupId),
    );
    const mediaGroupIdsToAdd = nextMediaGroupIds.filter(
      (mediaGroupId) => !currentSet.has(mediaGroupId),
    );

    await Promise.all(
      mediaGroupIdsToRemove.map(async (mediaGroupId) => {
        const res = await fetch(
          apiUrl(
            `/program/${encodeURIComponent(programId)}/media-groups/${mediaGroupId}`,
          ),
          {
            method: 'DELETE',
          },
        );
        if (!res.ok) {
          throw new Error(
            `Failed to remove media group ${mediaGroupId} from ${programId} (${res.status})`,
          );
        }
      }),
    );

    for (const mediaGroupId of mediaGroupIdsToAdd) {
      const res = await fetch(
        apiUrl(`/program/${encodeURIComponent(programId)}/media-groups`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mediaGroupId }),
        },
      );
      if (!res.ok) {
        throw new Error(
          `Failed to add media group ${mediaGroupId} to ${programId} (${res.status})`,
        );
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
    if (!templateUrl) {
      setTemplatePreview(null);
      setTemplateError('Enter a template manifest URL to inspect.');
      return;
    }

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
      setError('Program ID is ');
      return;
    }

    setIsSaving(true);
    try {
      const isEditing = !!editingProgramId;
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
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `HTTP ${res.status}`);
        }
        savedProgram = (await res.json()) as ProgramState;

        const currentSceneIds = editingProgram?.scenes.map((entry) => entry.sceneId) || [];
        const currentMediaGroupIds = editingProgram?.mediaGroups.map((entry) => entry.mediaGroupId) || [];
        const currentStingerIds = editingProgram?.stingers.map((entry) => entry.stingerId) || [];
        if (isVisualProgram) {
          if (!savedProgram.templateManifest || hasProgramCapability(savedProgram.templateManifest, 'scene.configuration')) {
            await syncProgramScenes(nextProgramId, currentSceneIds, selectedSceneIds);
          }
          if (!savedProgram.templateManifest || hasProgramCapability(savedProgram.templateManifest, 'media.groups')) {
            await syncProgramMediaGroups(nextProgramId, currentMediaGroupIds, selectedMediaGroupIds);
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
        if (!createRes.ok) {
          const text = await createRes.text();
          throw new Error(text || `HTTP ${createRes.status}`);
        }
        savedProgram = (await createRes.json()) as ProgramState;

        if (isVisualProgram && (!savedProgram.templateManifest || hasProgramCapability(savedProgram.templateManifest, 'scene.configuration'))) {
          await syncProgramScenes(nextProgramId, [], selectedSceneIds);
        }
        if (isVisualProgram && (!savedProgram.templateManifest || hasProgramCapability(savedProgram.templateManifest, 'media.groups'))) {
          await syncProgramMediaGroups(nextProgramId, [], selectedMediaGroupIds);
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
      setError('Failed to save show. Ensure the ID is unique.');
      showAlert('Failed to save show.', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const supportsSceneConfiguration = selectedType !== 'radio' && (!templatePreview || hasProgramCapability(templatePreview, 'scene.configuration'));
  const supportsMediaGroups = selectedType !== 'radio' && (!templatePreview || hasProgramCapability(templatePreview, 'media.groups'));
  const supportsStingers = selectedType !== 'radio' && (!templatePreview || hasProgramCapability(templatePreview, 'stinger.transitions'));

  const deleteProgram = async (programId: string) => {
    if (!confirm(`Delete program "${programId}"? This removes its scene assignments and active scene state.`)) return;

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
                    <div className='flex items-start justify-between gap-4'>
                      <div className='min-w-0 flex-1'>
                        <div className='flex flex-wrap items-center gap-2'>
                          <h3 className='text-lg font-semibold text-text-primary dark:text-text-primary'>{program.programId}</h3>
                          <span className='inline-flex items-center gap-1 rounded-full border border-sand/30 bg-sand/10 px-2 py-0.5 text-xs font-medium text-text-secondary dark:border-sand/40 dark:bg-sand/15'>
                            {program.type === 'radio' ? <><Radio size={12} /> Radio</> : program.type === 'both' ? <><Tv size={12} /><Radio size={12} /> Simulcast</> : <><Tv size={12} /> TV</>}
                          </span>
                          {isSelected ? (
                            <span className='inline-flex rounded-full border border-sea/30 bg-sea/10 px-2 py-0.5 text-xs font-medium text-sea   '>
                              Selected
                            </span>
                          ) : null}
                        </div>
                        {program.type === 'radio' ? (
                          <p className='mt-2 text-sm text-text-secondary dark:text-text-secondary'>Audio-only show · Songs, audio clips, mixer, and Radio distribution</p>
                        ) : (
                          <p className='mt-2 text-sm text-text-secondary dark:text-text-secondary'>
                            Scenes assigned: {program.scenes.length} · Media groups assigned: {(program.mediaGroups || []).length} · Stingers assigned: {(program.stingers || []).length} · Active scene:{' '}
                            {program.activeSceneId ?? 'none'}
                          </p>
                        )}
                        {program.type !== 'radio' && program.templateManifest ? (
                          <div className='mt-3 flex flex-wrap items-center gap-2 text-xs text-text-secondary'>
                            <Link2 size={13} />
                            <span>
                              {program.templateManifest.name} · {program.templateManifest.bundleVersion}
                            </span>
                            <a href={resolveProgramOutputUrl(program, getApiBaseUrl())} target='_blank' rel='noopener noreferrer' className='inline-flex items-center gap-1 font-medium text-sea underline-offset-2 hover:underline'>
                              Open renderer <ExternalLink size={12} />
                            </a>
                          </div>
                        ) : program.type !== 'radio' ? (
                          <p className='mt-3 text-xs text-terracotta'>Transitional Alcantara renderer · no external template registered</p>
                        ) : null}

                      </div>
                      <div className='flex items-start gap-2'>
                        <Button size='sm' variant={isSelected ? 'secondary' : 'ghost'} onClick={() => setSelectedProgramId(program.programId)} className='px-3'>
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
                        <IconButton
                          onClick={() => {
                            void deleteProgram(program.programId);
                          }}
                          className='text-terracotta'
                          title={`Delete ${program.programId}`}
                          aria-label={`Delete ${program.programId}`}
                        >
                          <Trash2 size={16} />
                        </IconButton>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </Card>

        <Modal isOpen={showModal} onClose={closeModal} title={editingProgramId ? 'Edit show' : 'Create show'}>
          <div className='space-y-5'>
            <div>
              <label className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Program ID</label>
              <Input
                value={programIdInput}
                onChange={(e) => {
                  setProgramIdInput(e.target.value);
                  if (error) {
                    setError('');
                  }
                }}
                placeholder='main'
                error={!!error}
                autoFocus
              />
            </div>

            <div>
              <label className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Program Type</label>
              <div className='flex gap-2'>
                {(['tv', 'radio', 'both'] as const).map((type) => (
                  <button
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
                  </button>
                ))}
              </div>
              {selectedType === 'radio' ? (
                <p className='mt-2 rounded-xl border border-sea/20 bg-sea/5 p-3 text-sm text-text-secondary'>
                  Radio is audio-only. Configure songs, audio clips, the mixer, and distribution from the Radio desk.
                </p>
              ) : null}
            </div>

            {selectedType !== 'radio' ? <div>
              <label className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Template URL</label>
              <div className='flex items-start gap-2'>
                <Input
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

            {supportsMediaGroups ? (
              <div>
                <div className='mb-2 flex items-center justify-between'>
                  <label className='block text-sm font-medium text-text-primary dark:text-text-primary'>Program Media Groups</label>
                  <Button size='sm' variant='ghost' onClick={() => navigate('/media')}>
                    Manage Media
                  </Button>
                </div>
                {sortedMediaGroups.length === 0 ? (
                  <p className='text-sm text-text-secondary dark:text-text-secondary'>No media groups available. Create media groups first.</p>
                ) : (
                  <div className='max-h-64 space-y-2 overflow-y-auto rounded-xl border border-sand/20 bg-white/70 p-3 dark:border-sand/40 dark:bg-dark-sand/50'>
                    <Input type='search' value={mediaGroupSearch} onChange={(event) => setMediaGroupSearch(event.target.value)} placeholder='Search media groups by name or description…' aria-label='Search program media groups' className='sticky top-0 z-10 w-full border-sand/30 bg-white/95 px-3 py-2 text-sm dark:bg-dark-sand/95' />
                    {filteredMediaGroups.map((mediaGroup) => {
                      const checked = selectedMediaGroupIds.includes(mediaGroup.id);
                      return (
                        <label key={mediaGroup.id} className='flex cursor-pointer items-start gap-3 rounded-lg px-2 py-1.5 hover:bg-sand/10 dark:hover:bg-sand/15'>
                          <Checkbox checked={checked} onChange={() => toggleMediaGroupSelection(mediaGroup.id)} />
                          <span className='min-w-0'>
                            <span className='block text-sm font-medium text-text-primary dark:text-text-primary'>{mediaGroup.name}</span>
                            <span className='block text-xs text-text-secondary dark:text-text-secondary'>{mediaGroup.description || 'No description'}</span>
                          </span>
                        </label>
                      );
                    })}
                    {filteredMediaGroups.length === 0 ? <p className='px-2 py-4 text-center text-sm text-text-secondary'>No media groups match “{mediaGroupSearch}”.</p> : null}
                  </div>
                )}
              </div>
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
