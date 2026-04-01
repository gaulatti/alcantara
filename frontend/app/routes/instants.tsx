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
  showAlert
} from '@gaulatti/bleecker';
import { Play, Plus, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Route } from './+types/instants';
import { apiUrl } from '../utils/apiBaseUrl';
import { uploadFileToMediaBucket } from '../services/uploads';
import { useGlobalProgramId } from '../utils/globalProgram';

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
  return [{ title: 'Instants - TV Broadcast' }, { name: 'description', content: 'Manage global instant audio triggers' }];
}

export default function InstantsAdmin() {
  const navigate = useNavigate();
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
        showAlert('Failed to load instants.', 'error');
      } finally {
        setIsLoading(false);
      }
    };

    void load();
  }, []);

  const sortedInstants = useMemo(() => [...instants].sort((a, b) => a.position - b.position), [instants]);

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
      showAlert('Instant triggered.', 'success');
    } catch (err) {
      console.error('Failed to trigger instant:', err);
      showAlert('Failed to trigger instant.', 'error');
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
      console.error('Failed to stop instants:', err);
      showAlert('Failed to stop instants.', 'error');
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
      showAlert(isEditing ? 'Instant updated.' : 'Instant created.', 'success');
    } catch (err) {
      console.error('Failed to save instant:', err);
      const message = err instanceof Error ? err.message : 'Failed to save instant.';
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
      showAlert('Instant deleted.', 'success');
    } catch (err) {
      console.error('Failed to delete instant:', err);
      showAlert('Failed to delete instant.', 'error');
    }
  };

  return (
    <div className='min-h-screen bg-light-sand p-6 dark:bg-deep-sea md:p-8'>
      <AlertContainer />
      <div className='mx-auto max-w-6xl space-y-6'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
          <SectionHeader title='Instants' description='Audio trigger cart shared across the app.' />
          <div className='flex flex-wrap items-center gap-3'>
            <Button variant='secondary' onClick={() => navigate('/control')}>
              Back to Control
            </Button>
            <Button variant='secondary' onClick={() => void stopAllInstants()}>
              Stop All
            </Button>
            <Button onClick={openCreateModal}>
              <Plus size={16} />
              Create Instant
            </Button>
          </div>
        </div>

        <Card className='space-y-4'>
          {isLoading ? (
            <div className='flex flex-col items-center justify-center gap-3 py-10 text-center text-text-secondary dark:text-text-secondary'>
              <LoadingSpinner />
              <p>Loading instants...</p>
            </div>
          ) : sortedInstants.length === 0 ? (
            <Empty
              title='No instants yet'
              description='Create your first instant trigger.'
              action={<Button onClick={openCreateModal}>Create Instant</Button>}
            />
          ) : (
            <div className='space-y-3'>
              {sortedInstants.map((instant) => (
                <article
                  key={instant.id}
                  className='rounded-2xl border border-sand/20 bg-white/80 p-4 transition-colors hover:border-sea/40 dark:border-sand/40 dark:bg-dark-sand/60 dark:hover:border-accent-blue/60'
                >
                  <div className='flex items-start justify-between gap-4'>
                    <div className='min-w-0 flex-1'>
                      <div className='flex flex-wrap items-center gap-2'>
                        <h3 className='text-lg font-semibold text-text-primary dark:text-text-primary'>{instant.name}</h3>
                        {!instant.enabled ? (
                          <span className='inline-flex rounded-full border border-sand/30 bg-sand/10 px-2 py-0.5 text-xs font-medium text-text-secondary dark:border-sand/40 dark:bg-sand/15 dark:text-text-secondary'>
                            Disabled
                          </span>
                        ) : null}
                      </div>
                      <p className='mt-2 truncate text-sm text-text-secondary dark:text-text-secondary'>{instant.audioUrl}</p>
                      <p className='mt-1 text-xs text-text-secondary dark:text-text-secondary'>Volume: {instant.volume}</p>
                    </div>
                    <div className='flex items-start gap-2'>
                      <IconButton
                        onClick={() => {
                          void playInstant(instant.id);
                        }}
                        className='text-sea dark:text-accent-blue'
                        title={`Play ${instant.name}`}
                        aria-label={`Play ${instant.name}`}
                      >
                        <Play size={16} />
                      </IconButton>
                      <IconButton
                        onClick={() => openEditModal(instant)}
                        className='text-sea dark:text-accent-blue'
                        title={`Edit ${instant.name}`}
                        aria-label={`Edit ${instant.name}`}
                      >
                        <Pencil size={16} />
                      </IconButton>
                      <IconButton
                        onClick={() => {
                          void deleteInstant(instant);
                        }}
                        className='text-terracotta'
                        title={`Delete ${instant.name}`}
                        aria-label={`Delete ${instant.name}`}
                      >
                        <Trash2 size={16} />
                      </IconButton>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </Card>

        <Modal isOpen={showModal} onClose={closeModal} title={editingInstant ? 'Edit Instant' : 'Create Instant'}>
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
              <label className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Audio File</label>
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
              {uploadedAudioUrl ? <p className='mt-2 truncate text-xs text-text-secondary dark:text-text-secondary'>Stored URL: {uploadedAudioUrl}</p> : null}
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
                {isUploadingAudio ? 'Uploading...' : isSaving ? 'Saving...' : editingInstant ? 'Update Instant' : 'Create Instant'}
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    </div>
  );
}
