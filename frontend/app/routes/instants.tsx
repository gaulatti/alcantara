import {
  AlertContainer,
  Button,
  Card,
  Checkbox,
  Empty,
  FileInput,
  IconButton,
  Input,
  LoadingSpinner,
  Modal,
  SectionHeader,
  SortableTableHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  showAlert
} from '@gaulatti/bleecker';
import type { SortState } from '@gaulatti/bleecker';
import { Play, Plus, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Route } from './+types/instants';
import { apiUrl } from '../utils/apiBaseUrl';
import { uploadFileToMediaBucket } from '../services/uploads';
import { useGlobalProgramId } from '../utils/globalProgram';
import { AppPage } from '../components/AppPage';

interface InstantItem {
  id: number;
  name: string;
  audioUrl: string;
  volume: number;
  enabled: boolean;
  position: number;
}

async function extractErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  if (!text) {
    return `HTTP ${res.status}`;
  }

  try {
    const parsed = JSON.parse(text) as { message?: string | string[] };
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message;
    }
    if (Array.isArray(parsed.message)) {
      const joined = parsed.message.filter((value) => typeof value === 'string' && value.trim()).join(', ');
      if (joined) {
        return joined;
      }
    }
  } catch {
    // Not JSON; fallback to raw text.
  }

  return text;
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: 'Audio clips - Alcantara' },
    {
      name: 'description',
      content: 'Manage reusable audio clips and sounders'
    }
  ];
}

export default function InstantsAdmin() {
  const [activeProgramId] = useGlobalProgramId();
  const [instants, setInstants] = useState<InstantItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [showModal, setShowModal] = useState(false);
  const [editingInstant, setEditingInstant] = useState<InstantItem | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [uploadedAudioUrl, setUploadedAudioUrl] = useState('');
  const [selectedAudioFile, setSelectedAudioFile] = useState<File | null>(null);
  const [volumeInput, setVolumeInput] = useState('1');
  const [enabledInput, setEnabledInput] = useState(true);
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingAudio, setIsUploadingAudio] = useState(false);

  const fetchInstants = async () => {
    const res = await fetch(apiUrl('/instants'));
    if (!res.ok) {
      throw new Error(`Failed to fetch instants: ${res.status}`);
    }
    const payload = (await res.json()) as InstantItem[];
    setInstants(payload);
  };

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      try {
        await fetchInstants();
      } catch (err) {
        console.error('Failed to load instants:', err);
        showAlert('Failed to load audio clips.', 'error');
      } finally {
        setIsLoading(false);
      }
    };

    void load();
  }, []);

  const openCreateModal = () => {
    setEditingInstant(null);
    setNameInput('');
    setUploadedAudioUrl('');
    setSelectedAudioFile(null);
    setVolumeInput('1');
    setEnabledInput(true);
    setError('');
    setShowModal(true);
  };

  const openEditModal = (instant: InstantItem) => {
    setEditingInstant(instant);
    setNameInput(instant.name);
    setUploadedAudioUrl(instant.audioUrl);
    setSelectedAudioFile(null);
    setVolumeInput(String(instant.volume));
    setEnabledInput(instant.enabled);
    setError('');
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingInstant(null);
    setNameInput('');
    setUploadedAudioUrl('');
    setSelectedAudioFile(null);
    setVolumeInput('1');
    setEnabledInput(true);
    setError('');
  };

  const playInstant = async (instantId: number) => {
    try {
      const res = await fetch(apiUrl(`/instants/${instantId}/play?programId=${encodeURIComponent(activeProgramId)}`), {
        method: 'POST'
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      showAlert('Audio clip triggered.', 'success');
    } catch (err) {
      console.error('Failed to trigger audio clip:', err);
      showAlert('Failed to trigger audio clip.', 'error');
    }
  };

  const stopAllInstants = async () => {
    try {
      const res = await fetch(apiUrl(`/instants/stop-all?programId=${encodeURIComponent(activeProgramId)}`), {
        method: 'POST'
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      showAlert('Stop command sent.', 'success');
    } catch (err) {
      console.error('Failed to stop audio clips:', err);
      showAlert('Failed to stop audio clips.', 'error');
    }
  };

  const saveInstant = async () => {
    const normalizedName = nameInput.trim();
    const parsedVolume = Number(volumeInput);

    if (!normalizedName) {
      setError('Name is required.');
      return;
    }

    if (!Number.isFinite(parsedVolume) || parsedVolume < 0 || parsedVolume > 1) {
      setError('Volume must be between 0 and 1.');
      return;
    }

    setIsSaving(true);
    setError('');
    try {
      let nextAudioUrl = uploadedAudioUrl.trim();
      if (selectedAudioFile) {
        setIsUploadingAudio(true);
        const upload = await uploadFileToMediaBucket('instant', selectedAudioFile);
        nextAudioUrl = upload.url;
        setUploadedAudioUrl(upload.url);
      }

      if (!nextAudioUrl) {
        setError('Audio file is required.');
        return;
      }

      const isEditing = !!editingInstant;
      const endpoint = isEditing ? apiUrl(`/instants/${editingInstant.id}`) : apiUrl('/instants');
      const method = isEditing ? 'PUT' : 'POST';

      const res = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: normalizedName,
          audioUrl: nextAudioUrl,
          volume: parsedVolume,
          enabled: enabledInput
        })
      });

      if (!res.ok) {
        throw new Error(await extractErrorMessage(res));
      }

      await fetchInstants();
      closeModal();
      showAlert(isEditing ? 'Audio clip updated.' : 'Audio clip created.', 'success');
    } catch (err) {
      console.error('Failed to save instant:', err);
      const message = err instanceof Error ? err.message : 'Failed to save audio clip.';
      setError(message);
      showAlert(message, 'error');
    } finally {
      setIsUploadingAudio(false);
      setIsSaving(false);
    }
  };

  const deleteInstant = async (instant: InstantItem) => {
    if (!confirm(`Delete instant "${instant.name}"?`)) return;

    try {
      const res = await fetch(apiUrl(`/instants/${instant.id}`), {
        method: 'DELETE'
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }

      await fetchInstants();
      showAlert('Audio clip deleted.', 'success');
    } catch (err) {
      console.error('Failed to delete instant:', err);
      showAlert('Failed to delete audio clip.', 'error');
    }
  };

  const [sort, setSort] = useState<SortState>({
    field: 'position',
    order: 'asc'
  });

  const handleSort = (field: string, order: 'asc' | 'desc') => {
    setSort({ field, order });
  };

  const sortedInstants = useMemo(() => {
    return [...instants].sort((a, b) => {
      const field = sort.field as keyof InstantItem;
      const av = a[field];
      const bv = b[field];
      if (typeof av === 'number' && typeof bv === 'number') {
        return sort.order === 'asc' ? av - bv : bv - av;
      }
      return sort.order === 'asc' ? String(av ?? '').localeCompare(String(bv ?? '')) : String(bv ?? '').localeCompare(String(av ?? ''));
    });
  }, [instants, sort]);

  return (
    <AppPage width='wide'>
      <AlertContainer />
      <div className='mx-auto max-w-6xl space-y-6'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
          <SectionHeader title='Audio clips' description='Reusable sounders, bumpers, and instant audio for every broadcast mode.' />
          <div className='flex flex-wrap items-center gap-3'>
            <Button variant='secondary' onClick={() => void stopAllInstants()}>
              Stop all
            </Button>
            <Button onClick={openCreateModal}>
              <Plus size={16} />
              Create audio clip
            </Button>
          </div>
        </div>

        <Card className='space-y-4'>
          {isLoading ? (
            <div className='flex flex-col items-center justify-center gap-3 py-10 text-center text-text-secondary dark:text-text-secondary'>
              <LoadingSpinner />
              <p>Loading audio clips...</p>
            </div>
          ) : sortedInstants.length === 0 ? (
            <Empty title='No audio clips yet' description='Create your first reusable sounder or bumper.' action={<Button onClick={openCreateModal}>Create audio clip</Button>} />
          ) : (
            <>
              <div className='space-y-3 md:hidden'>
                {sortedInstants.map((instant) => (
                  <article key={instant.id} className='rounded-[var(--radius-card)] border border-sand/25 bg-white/80 p-4 dark:border-white/10 dark:bg-dark-sand/60'>
                    <div className='flex items-start justify-between gap-3'>
                      <div className='min-w-0'>
                        <p className='truncate font-medium text-text-primary'>{instant.name}</p>
                        <p className='mt-1 text-xs text-text-secondary'>
                          Position {instant.position} · Volume {instant.volume.toFixed(2)} · {instant.enabled ? 'Enabled' : 'Disabled'}
                        </p>
                      </div>
                    </div>
                    <div className='mt-3 grid grid-cols-3 gap-2'>
                      <Button size='sm' variant='secondary' onClick={() => void playInstant(instant.id)}>
                        <Play size={14} /> Play
                      </Button>
                      <Button size='sm' variant='secondary' onClick={() => openEditModal(instant)}>
                        <Pencil size={14} /> Edit
                      </Button>
                      <Button size='sm' variant='destructive' onClick={() => void deleteInstant(instant)}>
                        <Trash2 size={14} /> Delete
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
              <div className='hidden overflow-hidden rounded-xl border border-sand/20 dark:border-sand/40 md:block'>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>#</TableHead>
                      <SortableTableHeader field='name' label='Name' currentSort={sort} onSort={handleSort} />
                      <SortableTableHeader field='volume' label='Volume' currentSort={sort} onSort={handleSort} />
                      <SortableTableHeader field='enabled' label='Status' currentSort={sort} onSort={handleSort} />
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedInstants.map((instant) => (
                      <TableRow key={instant.id}>
                        <TableCell className='text-xs text-text-secondary dark:text-text-secondary'>{instant.position}</TableCell>
                        <TableCell className='font-medium text-text-primary dark:text-text-primary'>{instant.name}</TableCell>
                        <TableCell>{instant.volume.toFixed(2)}</TableCell>
                        <TableCell>
                          {instant.enabled ? (
                            <span className='text-xs font-medium text-green-600 dark:text-green-400'>Enabled</span>
                          ) : (
                            <span className='text-xs text-text-secondary dark:text-text-secondary'>Disabled</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className='flex items-center justify-end gap-1'>
                            <IconButton
                              onClick={() => {
                                void playInstant(instant.id);
                              }}
                              className='text-sea '
                              title={`Play ${instant.name}`}
                              aria-label={`Play ${instant.name}`}
                            >
                              <Play size={14} />
                            </IconButton>
                            <IconButton onClick={() => openEditModal(instant)} className='text-sea ' title={`Edit ${instant.name}`} aria-label={`Edit ${instant.name}`}>
                              <Pencil size={14} />
                            </IconButton>
                            <IconButton
                              onClick={() => {
                                void deleteInstant(instant);
                              }}
                              className='text-terracotta'
                              title={`Delete ${instant.name}`}
                              aria-label={`Delete ${instant.name}`}
                            >
                              <Trash2 size={14} />
                            </IconButton>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </Card>

        <Modal isOpen={showModal} onClose={closeModal} title={editingInstant ? 'Edit audio clip' : 'Create audio clip'}>
          <div className='space-y-5'>
            <div>
              <label className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Name</label>
              <Input
                value={nameInput}
                onChange={(e) => {
                  setNameInput(e.target.value);
                  if (error) setError('');
                }}
                placeholder='Hit FX'
                autoFocus
                error={!!error && !nameInput}
              />
            </div>

            <div>
              <label className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Audio file</label>
              <div className='mt-2 flex flex-col gap-2'>
                <FileInput
                  accept='audio/*'
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    event.target.value = '';
                    setSelectedAudioFile(file);
                    if (error) setError('');
                  }}
                  disabled={isUploadingAudio}
                  error={!!error && !selectedAudioFile && !uploadedAudioUrl}
                />
                <span className='text-xs text-text-secondary dark:text-text-secondary'>
                  {selectedAudioFile ? `Selected: ${selectedAudioFile.name}` : uploadedAudioUrl ? 'Using existing uploaded audio.' : 'No audio selected yet.'}
                </span>
              </div>
              {uploadedAudioUrl ? <p className='mt-2 truncate text-xs text-text-secondary dark:text-text-secondary'> URL: {uploadedAudioUrl}</p> : null}
            </div>

            <div className='grid gap-4 sm:grid-cols-2'>
              <div>
                <label className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Volume (0-1)</label>
                <Input
                  type='number'
                  min='0'
                  max='1'
                  step='0.01'
                  value={volumeInput}
                  onChange={(e) => {
                    setVolumeInput(e.target.value);
                    if (error) setError('');
                  }}
                />
              </div>

              <div className='mt-7 flex items-center'>
                <Checkbox checked={enabledInput} onChange={(e) => setEnabledInput(e.target.checked)} label='Enabled' />
              </div>
            </div>

            {error ? <p className='text-sm text-terracotta'>{error}</p> : null}

            <div className='flex justify-end gap-3'>
              <Button variant='secondary' onClick={closeModal} disabled={isSaving}>
                Cancel
              </Button>
              <Button onClick={saveInstant} disabled={isSaving || isUploadingAudio}>
                {isUploadingAudio ? 'Uploading...' : isSaving ? 'Saving...' : editingInstant ? 'Update audio clip' : 'Create audio clip'}
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    </AppPage>
  );
}
