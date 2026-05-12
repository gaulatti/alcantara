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
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Route } from './+types/stingers';
import { apiUrl } from '../utils/apiBaseUrl';
import { uploadFileToMediaBucket } from '../services/uploads';

interface StingerItem {
  id: number;
  name: string;
  videoUrl: string;
  cutPointMs: number;
  enabled: boolean;
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
  }

  return text;
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Stingers - TV Broadcast' }, { name: 'description', content: 'Manage .webm stinger transition videos' }];
}

export default function StingersAdmin() {
  const navigate = useNavigate();
  const [stingers, setStingers] = useState<StingerItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [showModal, setShowModal] = useState(false);
  const [editingStinger, setEditingStinger] = useState<StingerItem | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [uploadedVideoUrl, setUploadedVideoUrl] = useState('');
  const [selectedVideoFile, setSelectedVideoFile] = useState<File | null>(null);
  const [cutPointMsInput, setCutPointMsInput] = useState('1000');
  const [enabledInput, setEnabledInput] = useState(true);
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingVideo, setIsUploadingVideo] = useState(false);

  const fetchStingers = async () => {
    const res = await fetch(apiUrl('/stingers'));
    if (!res.ok) {
      throw new Error(`Failed to fetch stingers: ${res.status}`);
    }
    const payload = (await res.json()) as StingerItem[];
    setStingers(payload);
  };

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      try {
        await fetchStingers();
      } catch (err) {
        console.error('Failed to load stingers:', err);
        showAlert('Failed to load stingers.', 'error');
      } finally {
        setIsLoading(false);
      }
    };

    void load();
  }, []);

  const sortedStingers = useMemo(() => [...stingers].sort((a, b) => a.id - b.id), [stingers]);

  const openCreateModal = () => {
    setEditingStinger(null);
    setNameInput('');
    setUploadedVideoUrl('');
    setSelectedVideoFile(null);
    setCutPointMsInput('1000');
    setEnabledInput(true);
    setError('');
    setShowModal(true);
  };

  const openEditModal = (stinger: StingerItem) => {
    setEditingStinger(stinger);
    setNameInput(stinger.name);
    setUploadedVideoUrl(stinger.videoUrl);
    setSelectedVideoFile(null);
    setCutPointMsInput(String(stinger.cutPointMs ?? 1000));
    setEnabledInput(stinger.enabled);
    setError('');
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingStinger(null);
    setNameInput('');
    setUploadedVideoUrl('');
    setSelectedVideoFile(null);
    setCutPointMsInput('1000');
    setEnabledInput(true);
    setError('');
  };

  const saveStinger = async () => {
    const normalizedName = nameInput.trim();

    if (!normalizedName) {
      setError('Name is required.');
      return;
    }

    const parsedCutPointMs = Number(cutPointMsInput);
    if (!Number.isFinite(parsedCutPointMs) || parsedCutPointMs < 0) {
      setError('Cut point must be a positive number.');
      return;
    }

    setIsSaving(true);
    setError('');
    try {
      let nextVideoUrl = uploadedVideoUrl.trim();
      if (selectedVideoFile) {
        setIsUploadingVideo(true);
        const upload = await uploadFileToMediaBucket('stinger', selectedVideoFile);
        nextVideoUrl = upload.url;
        setUploadedVideoUrl(upload.url);
      }

      if (!nextVideoUrl) {
        setError('Video file is required.');
        return;
      }

      const isEditing = !!editingStinger;
      const endpoint = isEditing ? apiUrl(`/stingers/${editingStinger.id}`) : apiUrl('/stingers');
      const method = isEditing ? 'PUT' : 'POST';

      const res = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: normalizedName,
          videoUrl: nextVideoUrl,
          cutPointMs: parsedCutPointMs,
          enabled: enabledInput
        })
      });

      if (!res.ok) {
        throw new Error(await extractErrorMessage(res));
      }

      await fetchStingers();
      closeModal();
      showAlert(isEditing ? 'Stinger updated.' : 'Stinger created.', 'success');
    } catch (err) {
      console.error('Failed to save stinger:', err);
      const message = err instanceof Error ? err.message : 'Failed to save stinger.';
      setError(message);
      showAlert(message, 'error');
    } finally {
      setIsUploadingVideo(false);
      setIsSaving(false);
    }
  };

  const deleteStinger = async (stinger: StingerItem) => {
    if (!confirm(`Delete stinger "${stinger.name}"?`)) return;

    try {
      const res = await fetch(apiUrl(`/stingers/${stinger.id}`), {
        method: 'DELETE'
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }

      await fetchStingers();
      showAlert('Stinger deleted.', 'success');
    } catch (err) {
      console.error('Failed to delete stinger:', err);
      showAlert('Failed to delete stinger.', 'error');
    }
  };

  return (
    <div className='min-h-screen bg-light-sand p-6 dark:bg-deep-sea md:p-8'>
      <AlertContainer />
      <div className='mx-auto max-w-6xl space-y-6'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
          <SectionHeader title='Stingers' description='Upload and manage .webm stinger transition videos with alpha channel support.' />
          <div className='flex flex-wrap items-center gap-3'>
            <Button variant='secondary' onClick={() => navigate('/')}>
              Back to Control
            </Button>
            <Button onClick={openCreateModal}>
              <Plus size={16} />
              Create Stinger
            </Button>
          </div>
        </div>

        <Card className='space-y-4'>
          {isLoading ? (
            <div className='flex flex-col items-center justify-center gap-3 py-10 text-center text-text-secondary dark:text-text-secondary'>
              <LoadingSpinner />
              <p>Loading stingers...</p>
            </div>
          ) : sortedStingers.length === 0 ? (
            <Empty
              title='No stingers yet'
              description='Upload your first .webm stinger transition video.'
              action={<Button onClick={openCreateModal}>Create Stinger</Button>}
            />
          ) : (
            <div className='space-y-3'>
              {sortedStingers.map((stinger) => (
                <article
                  key={stinger.id}
                  className='rounded-2xl border border-sand/20 bg-white/80 p-4 transition-colors hover:border-sea/40 dark:border-sand/40 dark:bg-dark-sand/60'
                >
                  <div className='flex items-start justify-between gap-4'>
                    <div className='min-w-0 flex-1'>
                      <div className='flex flex-wrap items-center gap-2'>
                        <h3 className='text-lg font-semibold text-text-primary dark:text-text-primary'>{stinger.name}</h3>
                        {!stinger.enabled ? (
                          <span className='inline-flex rounded-full border border-sand/30 bg-sand/10 px-2 py-0.5 text-xs font-medium text-text-secondary dark:border-sand/40 dark:bg-sand/15 dark:text-text-secondary'>
                            Disabled
                          </span>
                        ) : null}
                      </div>
                      <p className='mt-2 truncate text-sm text-text-secondary dark:text-text-secondary'>{stinger.videoUrl}</p>
                      <p className='mt-1 text-xs text-text-secondary dark:text-text-secondary'>Cut point: {stinger.cutPointMs}ms</p>
                    </div>
                    <div className='flex items-start gap-2'>
                      <IconButton
                        onClick={() => openEditModal(stinger)}
                        className='text-sea'
                        title={`Edit ${stinger.name}`}
                        aria-label={`Edit ${stinger.name}`}
                      >
                        <Pencil size={16} />
                      </IconButton>
                      <IconButton
                        onClick={() => { void deleteStinger(stinger); }}
                        className='text-terracotta'
                        title={`Delete ${stinger.name}`}
                        aria-label={`Delete ${stinger.name}`}
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

        <Modal isOpen={showModal} onClose={closeModal} title={editingStinger ? 'Edit Stinger' : 'Create Stinger'}>
          <div className='space-y-5'>
            <div>
              <label className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Name</label>
              <Input
                value={nameInput}
                onChange={(e) => {
                  setNameInput(e.target.value);
                  if (error) setError('');
                }}
                placeholder='My Stinger'
                autoFocus
                error={!!error && !nameInput}
              />
            </div>

            <div>
              <label className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Video File (.webm with alpha)</label>
              <div className='mt-2 flex flex-col gap-2'>
                <FileInput
                  accept='.webm,video/webm'
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    event.target.value = '';
                    setSelectedVideoFile(file);
                    if (error) setError('');
                  }}
                  disabled={isUploadingVideo}
                  error={!!error && !selectedVideoFile && !uploadedVideoUrl}
                />
                <span className='text-xs text-text-secondary dark:text-text-secondary'>
                  {selectedVideoFile ? `Selected: ${selectedVideoFile.name}` : uploadedVideoUrl ? 'Using existing uploaded video.' : 'No video selected yet.'}
                </span>
              </div>
              {uploadedVideoUrl ? <p className='mt-2 truncate text-xs text-text-secondary dark:text-text-secondary'>URL: {uploadedVideoUrl}</p> : null}
            </div>

            <div>
              <label className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Cut Point (ms)</label>
              <Input
                type='number'
                min='0'
                step='100'
                value={cutPointMsInput}
                onChange={(e) => {
                  setCutPointMsInput(e.target.value);
                  if (error) setError('');
                }}
                placeholder='1000'
              />
              <span className='mt-1 text-xs text-text-secondary dark:text-text-secondary'>
                The moment during the stinger (in milliseconds) when the scene should switch.
              </span>
            </div>

            <div className='flex items-center'>
              <Checkbox checked={enabledInput} onChange={(e) => setEnabledInput(e.target.checked)} label='Enabled' />
            </div>

            {error ? <p className='text-sm text-terracotta'>{error}</p> : null}

            <div className='flex justify-end gap-3'>
              <Button variant='secondary' onClick={closeModal} disabled={isSaving}>
                Cancel
              </Button>
              <Button onClick={saveStinger} disabled={isSaving || isUploadingVideo}>
                {isUploadingVideo ? 'Uploading...' : isSaving ? 'Saving...' : editingStinger ? 'Update Stinger' : 'Create Stinger'}
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    </div>
  );
}
