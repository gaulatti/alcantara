import { AlertContainer, Button, Card, Empty, IconButton, LoadingSpinner, Modal, SectionHeader, showAlert } from '@gaulatti/bleecker';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Route } from './+types/programs';
import { apiUrl } from '../utils/apiBaseUrl';
import { useGlobalProgramId } from '../utils/globalProgram';

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

interface ProgramState {
  id: number;
  programId: string;
  activeSceneId: number | null;
  scenes: ProgramSceneEntry[];
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Programs - TV Broadcast' }, { name: 'description', content: 'Create, edit, and delete programs' }];
}

export default function ProgramsAdmin() {
  const navigate = useNavigate();
  const [selectedProgramId, setSelectedProgramId] = useGlobalProgramId();

  const [programs, setPrograms] = useState<ProgramState[]>([]);
  const [allScenes, setAllScenes] = useState<SceneSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [showModal, setShowModal] = useState(false);
  const [editingProgramId, setEditingProgramId] = useState<string | null>(null);
  const [programIdInput, setProgramIdInput] = useState('');
  const [selectedSceneIds, setSelectedSceneIds] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

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

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      try {
        await Promise.all([fetchPrograms(), fetchScenes()]);
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

  const openCreateModal = () => {
    setEditingProgramId(null);
    setProgramIdInput('');
    setSelectedSceneIds([]);
    setError('');
    setShowModal(true);
  };

  const openEditModal = (program: ProgramState) => {
    setEditingProgramId(program.programId);
    setProgramIdInput(program.programId);
    setSelectedSceneIds(program.scenes.map((entry) => entry.sceneId));
    setError('');
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingProgramId(null);
    setProgramIdInput('');
    setSelectedSceneIds([]);
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

  const saveProgram = async () => {
    const nextProgramId = programIdInput.trim();
    if (!nextProgramId) {
      setError('Program ID is required');
      return;
    }

    setIsSaving(true);
    try {
      const isEditing = !!editingProgramId;
      const editingProgram = isEditing ? programs.find((program) => program.programId === editingProgramId) || null : null;

      if (isEditing) {
        const needsRename = editingProgramId !== nextProgramId;
        if (needsRename) {
          const res = await fetch(apiUrl(`/program/${encodeURIComponent(editingProgramId)}`), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nextProgramId })
          });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(text || `HTTP ${res.status}`);
          }
        }

        const currentSceneIds = editingProgram?.scenes.map((entry) => entry.sceneId) || [];
        await syncProgramScenes(nextProgramId, currentSceneIds, selectedSceneIds);
      } else {
        const createRes = await fetch(apiUrl('/program'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ programId: nextProgramId })
        });
        if (!createRes.ok) {
          const text = await createRes.text();
          throw new Error(text || `HTTP ${createRes.status}`);
        }

        await syncProgramScenes(nextProgramId, [], selectedSceneIds);
      }

      if (isEditing && editingProgramId === selectedProgramId) {
        setSelectedProgramId(nextProgramId);
      } else if (!isEditing) {
        setSelectedProgramId(nextProgramId);
      }

      await fetchPrograms();
      closeModal();
      showAlert(isEditing ? 'Program updated.' : 'Program created.', 'success');
    } catch (err) {
      console.error('Failed to save program:', err);
      setError('Failed to save program. Ensure the ID is unique.');
      showAlert('Failed to save program.', 'error');
    } finally {
      setIsSaving(false);
    }
  };

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
      showAlert('Program deleted.', 'success');
    } catch (err) {
      console.error('Failed to delete program:', err);
      showAlert('Failed to delete program.', 'error');
    }
  };

  return (
    <div className='min-h-screen bg-light-sand p-6 dark:bg-deep-sea md:p-8'>
      <AlertContainer />
      <div className='mx-auto max-w-5xl space-y-6'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
          <SectionHeader title='Programs' description='Create, rename, and delete broadcast programs. Assign scenes per program in edit mode.' />
          <div className='flex flex-wrap items-center gap-3'>
            <Button variant='secondary' onClick={() => navigate('/control')}>
              Back to Control
            </Button>
            <Button onClick={openCreateModal}>
              <Plus size={16} />
              Create Program
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
            <Empty title='No programs yet' description='Create your first program.' action={<Button onClick={openCreateModal}>Create Program</Button>} />
          ) : (
            <div className='space-y-3'>
              {sortedPrograms.map((program) => {
                const isSelected = selectedProgramId === program.programId;

                return (
                  <article
                    key={program.id}
                    className={`rounded-2xl border p-4 transition-colors ${
                      isSelected
                        ? 'border-sea bg-sea/10 dark:border-accent-blue dark:bg-accent-blue/10'
                        : 'border-sand/20 bg-white/80 hover:border-sea/30 dark:border-sand/40 dark:bg-dark-sand/60 dark:hover:border-accent-blue/50'
                    }`}
                  >
                    <div className='flex items-start justify-between gap-4'>
                      <div className='min-w-0 flex-1'>
                        <div className='flex flex-wrap items-center gap-2'>
                          <h3 className='text-lg font-semibold text-text-primary dark:text-text-primary'>{program.programId}</h3>
                          {isSelected ? (
                            <span className='inline-flex rounded-full border border-sea/30 bg-sea/10 px-2 py-0.5 text-xs font-medium text-sea dark:border-accent-blue/30 dark:bg-accent-blue/15 dark:text-accent-blue'>
                              Selected
                            </span>
                          ) : null}
                        </div>
                        <p className='mt-2 text-sm text-text-secondary dark:text-text-secondary'>
                          Scenes assigned: {program.scenes.length} · Active scene: {program.activeSceneId ?? 'none'}
                        </p>
                      </div>
                      <div className='flex items-start gap-2'>
                        <Button
                          size='sm'
                          variant={isSelected ? 'secondary' : 'ghost'}
                          onClick={() => setSelectedProgramId(program.programId)}
                          className='px-3'
                        >
                          Select
                        </Button>
                        <IconButton
                          onClick={() => openEditModal(program)}
                          className='text-sea dark:text-accent-blue'
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

        <Modal isOpen={showModal} onClose={closeModal} title={editingProgramId ? 'Edit Program' : 'Create Program'}>
          <div className='space-y-5'>
            <div>
              <label className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Program ID</label>
              <input
                type='text'
                value={programIdInput}
                onChange={(e) => {
                  setProgramIdInput(e.target.value);
                  if (error) {
                    setError('');
                  }
                }}
                placeholder='main'
                className={`w-full rounded-xl border bg-white px-4 py-2.5 text-sm text-text-primary outline-none transition-colors dark:bg-dark-sand ${
                  error
                    ? 'border-terracotta focus:ring-2 focus:ring-terracotta'
                    : 'border-sand/40 focus:border-sea focus:ring-2 focus:ring-sea dark:focus:border-accent-blue dark:focus:ring-accent-blue'
                }`}
                autoFocus
              />
            </div>

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
                  {sortedScenes.map((scene) => {
                    const checked = selectedSceneIds.includes(scene.id);
                    return (
                      <label key={scene.id} className='flex cursor-pointer items-start gap-3 rounded-lg px-2 py-1.5 hover:bg-sand/10 dark:hover:bg-sand/15'>
                        <input
                          type='checkbox'
                          checked={checked}
                          onChange={() => toggleSceneSelection(scene.id)}
                          className='mt-0.5'
                        />
                        <span className='min-w-0'>
                          <span className='block text-sm font-medium text-text-primary dark:text-text-primary'>{scene.name}</span>
                          <span className='block text-xs text-text-secondary dark:text-text-secondary'>{scene.layout?.name || 'No layout'}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            {error ? <p className='text-sm text-terracotta'>{error}</p> : null}

            <div className='flex justify-end gap-3'>
              <Button variant='secondary' onClick={closeModal} disabled={isSaving}>
                Cancel
              </Button>
              <Button onClick={saveProgram} disabled={isSaving}>
                {isSaving ? 'Saving...' : editingProgramId ? 'Update Program' : 'Create Program'}
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    </div>
  );
}
