import { AlertContainer, Button, Card, Empty, Input, Modal, SectionHeader, Select, showAlert } from '@gaulatti/bleecker';
import type { ColumnDef, SortState } from '@gaulatti/bleecker';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Route } from './+types/scenes';
import { apiUrl } from '../utils/apiBaseUrl';
import { AppPage } from '../components/AppPage';
import { LibraryList, LibraryRowActions } from '../components/library/LibraryList';
import type { LibraryStatus } from '../components/library/LibraryList';

interface LayoutSummary {
  id: number;
  name: string;
}

interface SceneSummary {
  id: number;
  name: string;
  layoutId: number;
  layout: LayoutSummary;
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Scenes - TV Broadcast' }, { name: 'description', content: 'Create, edit, and delete scenes' }];
}

export default function ScenesAdmin() {
  const navigate = useNavigate();
  const [scenes, setScenes] = useState<SceneSummary[]>([]);
  const [layouts, setLayouts] = useState<LayoutSummary[]>([]);
  const [status, setStatus] = useState<LibraryStatus>('loading');

  const [showModal, setShowModal] = useState(false);
  const [editingScene, setEditingScene] = useState<SceneSummary | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [layoutIdInput, setLayoutIdInput] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const fetchScenes = async () => {
    const res = await fetch(apiUrl('/scenes'));
    if (!res.ok) {
      throw new Error(`Failed to fetch scenes: ${res.status}`);
    }
    const payload = (await res.json()) as SceneSummary[];
    setScenes(payload);
  };

  const fetchLayouts = async () => {
    const res = await fetch(apiUrl('/layouts'));
    if (!res.ok) {
      throw new Error(`Failed to fetch layouts: ${res.status}`);
    }
    const payload = (await res.json()) as LayoutSummary[];
    setLayouts(payload);
  };

  const load = async () => {
    setStatus('loading');
    try {
      await Promise.all([fetchScenes(), fetchLayouts()]);
      setStatus('ready');
    } catch (err) {
      console.error('Failed to load scenes admin data:', err);
      setStatus('error');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const [sort, setSort] = useState<SortState>({ field: 'name', order: 'asc' });

  const openCreateModal = () => {
    setEditingScene(null);
    setNameInput('');
    setLayoutIdInput(layouts[0]?.id ?? null);
    setError('');
    setShowModal(true);
  };

  const openEditModal = (scene: SceneSummary) => {
    setEditingScene(scene);
    setNameInput(scene.name);
    setLayoutIdInput(scene.layoutId);
    setError('');
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingScene(null);
    setNameInput('');
    setLayoutIdInput(null);
    setError('');
  };

  const saveScene = async () => {
    const normalizedName = nameInput.trim();
    if (!normalizedName) {
      setError('Scene name is required.');
      return;
    }
    if (!layoutIdInput) {
      setError('Select a layout.');
      return;
    }

    setIsSaving(true);
    try {
      const isEditing = !!editingScene;
      const endpoint = isEditing ? apiUrl(`/scenes/${editingScene.id}`) : apiUrl('/scenes');
      const method = isEditing ? 'PUT' : 'POST';

      const res = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: normalizedName,
          layoutId: layoutIdInput
        })
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }

      await fetchScenes();
      closeModal();
      showAlert(isEditing ? 'Scene updated.' : 'Scene created.', 'success');
    } catch (err) {
      console.error('Failed to save scene:', err);
      setError('Failed to save scene.');
      showAlert('Failed to save scene.', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const deleteScene = async (scene: SceneSummary) => {
    try {
      const res = await fetch(apiUrl(`/scenes/${scene.id}`), {
        method: 'DELETE'
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }

      await fetchScenes();
      showAlert('Scene deleted.', 'success');
    } catch (err) {
      console.error('Failed to delete scene:', err);
      showAlert('Failed to delete scene.', 'error');
      throw err;
    }
  };

  const columns: ColumnDef<SceneSummary>[] = [
    { key: 'name', header: 'Name', className: 'font-medium text-text-primary' },
    {
      key: 'layout',
      header: 'Scene template',
      sortable: false,
      className: 'text-text-secondary',
      cell: (scene) => scene.layout?.name || `#${scene.layoutId}`
    },
    {
      key: 'actions',
      header: '',
      sortable: false,
      cell: (scene) => (
        <LibraryRowActions
          name={scene.name}
          primary={{ label: 'Edit', onSelect: () => openEditModal(scene) }}
          onDelete={() => deleteScene(scene)}
          deleteTitle={`Delete scene "${scene.name}"?`}
        />
      )
    }
  ];

  return (
    <AppPage width='wide'>
      <AlertContainer />
      <div className='mx-auto max-w-6xl space-y-6'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
          <SectionHeader title='Scenes' description='Create and manage scenes.' />
          <div className='flex flex-wrap items-center gap-3'>
            <Button onClick={openCreateModal} disabled={layouts.length === 0}>
              <Plus size={16} />
              Create Scene
            </Button>
          </div>
        </div>

        {status === 'ready' && layouts.length === 0 ? (
          <Card>
            <Empty
              title='Create a layout first'
              description='Scenes require a layout. Create at least one layout before creating scenes.'
              action={<Button onClick={() => navigate('/layouts')}>Go to scene templates</Button>}
            />
          </Card>
        ) : (
          <LibraryList
            caption='Scenes'
            columns={columns}
            data={scenes}
            getRowKey={(scene) => String(scene.id)}
            status={status}
            onRetry={() => void load()}
            errorTitle='Failed to load scenes'
            empty={{ title: 'No scenes yet', description: 'Create your first scene.', action: <Button onClick={openCreateModal}>Create Scene</Button> }}
            sort={sort}
            onSortChange={setSort}
          />
        )}

        <Modal isOpen={showModal} onClose={closeModal} title={editingScene ? 'Edit Scene' : 'Create Scene'}>
          <div className='space-y-5'>
            <div>
              <label className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Scene Name</label>
              <Input
                value={nameInput}
                onChange={(e) => {
                  setNameInput(e.target.value);
                  if (error) setError('');
                }}
                placeholder='Morning Headlines'
                error={!!error}
                autoFocus
              />
            </div>

            <div>
              <label className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Layout</label>
              <Select
                value={layoutIdInput ? String(layoutIdInput) : ''}
                onChange={(val) => {
                  const numeric = Number(val);
                  setLayoutIdInput(Number.isFinite(numeric) && numeric > 0 ? numeric : null);
                  if (error) setError('');
                }}
                placeholder='Select template'
                options={layouts.map((l) => ({ value: String(l.id), label: l.name }))}
              />
            </div>

            {error ? <p className='text-sm text-terracotta'>{error}</p> : null}

            <div className='flex justify-end gap-3'>
              <Button variant='secondary' onClick={closeModal} disabled={isSaving}>
                Cancel
              </Button>
              <Button onClick={saveScene} disabled={isSaving}>
                {isSaving ? 'Saving...' : editingScene ? 'Update Scene' : 'Create Scene'}
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    </AppPage>
  );
}
