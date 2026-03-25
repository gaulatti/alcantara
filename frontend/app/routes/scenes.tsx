import { AlertContainer, Button, Card, Empty, IconButton, LoadingSpinner, Modal, SectionHeader, showAlert } from '@gaulatti/bleecker';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Route } from './+types/scenes';
import { apiUrl } from '../utils/apiBaseUrl';

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
  const [isLoading, setIsLoading] = useState(true);

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

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      try {
        await Promise.all([fetchScenes(), fetchLayouts()]);
      } catch (err) {
        console.error('Failed to load scenes admin data:', err);
        showAlert('Failed to load scenes. Please refresh and try again.', 'error');
      } finally {
        setIsLoading(false);
      }
    };
    void load();
  }, []);

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
    if (!confirm(`Delete scene "${scene.name}"?`)) return;

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
    }
  };

  return (
    <div className='min-h-screen bg-light-sand p-6 dark:bg-deep-sea md:p-8'>
      <AlertContainer />
      <div className='mx-auto max-w-6xl space-y-6'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
          <SectionHeader title='Scenes' description='Create and manage scenes.' />
          <div className='flex flex-wrap items-center gap-3'>
            <Button variant='secondary' onClick={() => navigate('/control')}>
              Back to Control
            </Button>
            <Button onClick={openCreateModal} disabled={layouts.length === 0}>
              <Plus size={16} />
              Create Scene
            </Button>
          </div>
        </div>

        {layouts.length === 0 ? (
          <Card>
            <Empty
              title='Create a layout first'
              description='Scenes require a layout. Create at least one layout before creating scenes.'
              action={
                <Button onClick={() => navigate('/layouts')}>
                  Go to Layouts
                </Button>
              }
            />
          </Card>
        ) : (
          <Card className='space-y-4'>
            {isLoading ? (
              <div className='flex flex-col items-center justify-center gap-3 py-10 text-center text-text-secondary dark:text-text-secondary'>
                <LoadingSpinner />
                <p>Loading scenes...</p>
              </div>
            ) : scenes.length === 0 ? (
              <Empty title='No scenes yet' description='Create your first scene.' action={<Button onClick={openCreateModal}>Create Scene</Button>} />
            ) : (
              <div className='space-y-3'>
                {scenes.map((scene) => (
                  <article
                    key={scene.id}
                    className='rounded-2xl border border-sand/20 bg-white/80 p-4 transition-colors hover:border-sea/40 dark:border-sand/40 dark:bg-dark-sand/60 dark:hover:border-accent-blue/60'
                  >
                    <div className='flex items-start justify-between gap-4'>
                      <div className='min-w-0 flex-1'>
                        <h3 className='text-lg font-semibold text-text-primary dark:text-text-primary'>{scene.name}</h3>
                        <p className='mt-2 text-sm text-text-secondary dark:text-text-secondary'>Layout: {scene.layout?.name || `#${scene.layoutId}`}</p>
                      </div>
                      <div className='flex items-start gap-2'>
                        <IconButton
                          onClick={() => openEditModal(scene)}
                          className='text-sea dark:text-accent-blue'
                          title={`Edit ${scene.name}`}
                          aria-label={`Edit ${scene.name}`}
                        >
                          <Pencil size={16} />
                        </IconButton>
                        <IconButton
                          onClick={() => {
                            void deleteScene(scene);
                          }}
                          className='text-terracotta'
                          title={`Delete ${scene.name}`}
                          aria-label={`Delete ${scene.name}`}
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
        )}

        <Modal isOpen={showModal} onClose={closeModal} title={editingScene ? 'Edit Scene' : 'Create Scene'}>
          <div className='space-y-5'>
            <div>
              <label className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Scene Name</label>
              <input
                type='text'
                value={nameInput}
                onChange={(e) => {
                  setNameInput(e.target.value);
                  if (error) setError('');
                }}
                placeholder='Morning Headlines'
                className={`w-full rounded-xl border bg-white px-4 py-2.5 text-sm text-text-primary outline-none transition-colors dark:bg-dark-sand ${
                  error
                    ? 'border-terracotta focus:ring-2 focus:ring-terracotta'
                    : 'border-sand/40 focus:border-sea focus:ring-2 focus:ring-sea dark:focus:border-accent-blue dark:focus:ring-accent-blue'
                }`}
                autoFocus
              />
            </div>

            <div>
              <label className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Layout</label>
              <select
                value={layoutIdInput ?? ''}
                onChange={(e) => {
                  const numeric = Number(e.target.value);
                  setLayoutIdInput(Number.isFinite(numeric) && numeric > 0 ? numeric : null);
                  if (error) setError('');
                }}
                className='w-full rounded-xl border border-sand/40 bg-white px-4 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-sea focus:ring-2 focus:ring-sea dark:border-sand/50 dark:bg-dark-sand dark:focus:border-accent-blue dark:focus:ring-accent-blue'
              >
                <option value=''>Select layout</option>
                {layouts.map((layout) => (
                  <option key={layout.id} value={layout.id}>
                    {layout.name}
                  </option>
                ))}
              </select>
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
    </div>
  );
}
