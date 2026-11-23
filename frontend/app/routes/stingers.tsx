import { AlertContainer, Button, Checkbox, FileInput, Input, Modal, SectionHeader, showAlert } from '@gaulatti/bleecker';
import type { ColumnDef, SortState } from '@gaulatti/bleecker';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Route } from './+types/stingers';
import { apiUrl } from '../utils/apiBaseUrl';
import { uploadFileToMediaBucket } from '../services/uploads';
import { AppPage } from '../components/AppPage';
import { EnabledPill, LibraryList, LibraryRowActions } from '../components/library/LibraryList';
import type { LibraryStatus } from '../components/library/LibraryList';

interface StingerItem {
  id: number;
  assetId?: string;
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
  return [{ title: 'Transitions - Alcantara' }, { name: 'description', content: 'Manage transition videos and cut points' }];
}

export default function StingersAdmin() {
  const [stingers, setStingers] = useState<StingerItem[]>([]);
  const [status, setStatus] = useState<LibraryStatus>('loading');

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

  const load = async () => {
    setStatus('loading');
    try {
      await fetchStingers();
      setStatus('ready');
    } catch (err) {
      console.error('Failed to load stingers:', err);
      setStatus('error');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const [sort, setSort] = useState<SortState>({ field: 'id', order: 'asc' });

  const columns: ColumnDef<StingerItem>[] = [
    { key: 'name', header: 'Name', className: 'font-medium text-text-primary' },
    { key: 'cutPointMs', header: 'Cut point', align: 'right', cell: (stinger) => <span className='tabular-nums'>{Number.isFinite(stinger.cutPointMs) ? `${stinger.cutPointMs} ms` : '—'}</span> },
    { key: 'enabled', header: 'Status', cell: (stinger) => <EnabledPill enabled={stinger.enabled} /> },
    {
      key: 'actions',
      header: '',
      sortable: false,
      cell: (stinger) => (
        <LibraryRowActions
          name={stinger.name}
          primary={{ label: 'Edit', onSelect: () => openEditModal(stinger) }}
          onDelete={() => deleteStinger(stinger)}
          deleteTitle={`Delete transition "${stinger.name}"?`}
        />
      )
    }
  ];

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
      showAlert(isEditing ? 'Transition updated.' : 'Transition created.', 'success');
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
    try {
      const res = await fetch(apiUrl(`/stingers/${stinger.id}`), {
        method: 'DELETE'
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }

      await fetchStingers();
      showAlert('Transition deleted.', 'success');
    } catch (err) {
      console.error('Failed to delete stinger:', err);
      showAlert('Failed to delete transition.', 'error');
      throw err;
    }
  };

  return (
    <AppPage width='wide'>
      <AlertContainer />
      <div className='mx-auto max-w-6xl space-y-6'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
          <SectionHeader title='Transitions' description='Manage transition videos and their exact scene cut points.' />
          <div className='flex flex-wrap items-center gap-3'>
            <Button onClick={openCreateModal}>
              <Plus size={16} />
              Create transition
            </Button>
          </div>
        </div>

        <LibraryList
          caption='Transitions'
          columns={columns}
          data={stingers}
          getRowKey={(stinger) => String(stinger.id)}
          status={status}
          onRetry={() => void load()}
          errorTitle='Failed to load transitions'
          empty={{ title: 'No transitions yet', description: 'Upload your first .webm transition video.', action: <Button onClick={openCreateModal}>Create transition</Button> }}
          sort={sort}
          onSortChange={setSort}
        />

        <Modal isOpen={showModal} onClose={closeModal} title={editingStinger ? 'Edit transition' : 'Create transition'}>
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
                {isUploadingVideo ? 'Uploading...' : isSaving ? 'Saving...' : editingStinger ? 'Update transition' : 'Create transition'}
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    </AppPage>
  );
}
