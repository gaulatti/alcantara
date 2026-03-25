import { AlertContainer, Button, Card, Empty, IconButton, LoadingSpinner, Modal, SectionHeader, showAlert } from '@gaulatti/bleecker';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Route } from './+types/layouts';
import { apiUrl } from '../utils/apiBaseUrl';

interface Layout {
  id: number;
  name: string;
  componentType: string;
  settings: string;
}

interface ComponentType {
  type: string;
  name: string;
  description: string;
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Layouts - TV Broadcast' }, { name: 'description', content: 'Manage broadcast layouts' }];
}

export default function LayoutsAdmin() {
  const navigate = useNavigate();
  const [layouts, setLayouts] = useState<Layout[]>([]);
  const [componentTypes, setComponentTypes] = useState<ComponentType[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [showModal, setShowModal] = useState(false);
  const [editingLayout, setEditingLayout] = useState<Layout | null>(null);
  const [layoutName, setLayoutName] = useState('');
  const [selectedComponents, setSelectedComponents] = useState<string[]>([]);
  const [errors, setErrors] = useState({ name: '', components: '', request: '' });
  const [isSaving, setIsSaving] = useState(false);

  const fetchLayouts = async () => {
    const res = await fetch(apiUrl('/layouts'));
    if (!res.ok) throw new Error(`Failed to fetch layouts: ${res.status}`);
    const data = await res.json();
    setLayouts(data);
  };

  const fetchComponentTypes = async () => {
    const res = await fetch(apiUrl('/layouts/component-types'));
    if (!res.ok) throw new Error(`Failed to fetch component types: ${res.status}`);
    const data = await res.json();
    setComponentTypes(data);
  };

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      try {
        await Promise.all([fetchLayouts(), fetchComponentTypes()]);
      } catch (err) {
        console.error(err);
        showAlert('Failed to load layouts. Please refresh and try again.', 'error');
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, []);

  const openCreateModal = () => {
    setEditingLayout(null);
    setLayoutName('');
    setSelectedComponents([]);
    setErrors({ name: '', components: '', request: '' });
    setShowModal(true);
  };

  const openEditModal = (layout: Layout) => {
    setEditingLayout(layout);
    setLayoutName(layout.name);
    setSelectedComponents(layout.componentType.split(',').filter(Boolean));
    setErrors({ name: '', components: '', request: '' });
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingLayout(null);
    setLayoutName('');
    setSelectedComponents([]);
    setErrors({ name: '', components: '', request: '' });
  };

  const toggleComponent = (componentType: string) => {
    setSelectedComponents((prev) => (prev.includes(componentType) ? prev.filter((item) => item !== componentType) : [...prev, componentType]));
  };

  const saveLayout = async () => {
    const nextErrors = { name: '', components: '', request: '' };

    if (!layoutName.trim()) {
      nextErrors.name = 'Please enter a layout name';
    }
    if (selectedComponents.length === 0) {
      nextErrors.components = 'Please select at least one component';
    }
    if (nextErrors.name || nextErrors.components) {
      setErrors(nextErrors);
      return;
    }

    setIsSaving(true);
    try {
      const payload = {
        name: layoutName,
        componentType: selectedComponents.join(','),
        settings: { components: selectedComponents }
      };

      const isEditing = !!editingLayout;
      const url = isEditing ? apiUrl(`/layouts/${editingLayout.id}`) : apiUrl('/layouts');
      const method = isEditing ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || `HTTP error ${res.status}`);
      }

      await fetchLayouts();
      closeModal();
      showAlert(editingLayout ? 'Layout updated.' : 'Layout created.', 'success');
    } catch (err) {
      console.error('Failed to save layout:', err);
      setErrors((prev) => ({ ...prev, request: 'Failed to save layout. Please try again.' }));
      showAlert('Failed to save layout.', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const deleteLayout = async (layoutId: number) => {
    if (!confirm('Are you sure you want to delete this layout?')) return;

    try {
      const res = await fetch(apiUrl(`/layouts/${layoutId}`), {
        method: 'DELETE'
      });
      if (!res.ok) {
        throw new Error(`HTTP error ${res.status}`);
      }
      await fetchLayouts();
      showAlert('Layout deleted.', 'success');
    } catch (err) {
      console.error('Failed to delete layout:', err);
      showAlert('Cannot delete layout - it may be in use by scenes.', 'error');
    }
  };

  return (
    <div className='min-h-screen bg-light-sand p-6 dark:bg-deep-sea md:p-8'>
      <AlertContainer />
      <div className='mx-auto max-w-6xl space-y-6'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
          <SectionHeader title='Layouts' description='Create and manage reusable scene layouts.' />
          <div className='flex flex-wrap items-center gap-3'>
            <Button variant='secondary' onClick={() => navigate('/control')}>
              Back to Control
            </Button>
            <Button onClick={openCreateModal}>
              <Plus size={16} />
              Create Layout
            </Button>
          </div>
        </div>

        <Card className='space-y-4'>
          {isLoading ? (
            <div className='flex flex-col items-center justify-center gap-3 py-10 text-center text-text-secondary dark:text-text-secondary'>
              <LoadingSpinner />
              <p>Loading layouts...</p>
            </div>
          ) : layouts.length === 0 ? (
            <Empty
              title='No layouts yet'
              description='Create a reusable layout to speed up scene creation.'
              action={
                <Button onClick={openCreateModal}>
                  <Plus size={16} />
                  Create your first layout
                </Button>
              }
            />
          ) : (
            <div className='space-y-3'>
              {layouts.map((layout) => {
                const components = layout.componentType.split(',').filter(Boolean);
                return (
                  <article
                    key={layout.id}
                    className='rounded-2xl border border-sand/20 bg-white/80 p-4 backdrop-blur-sm transition-colors hover:border-sea/40 dark:border-sand/40 dark:bg-dark-sand/60 dark:hover:border-accent-blue/60'
                  >
                    <div className='flex justify-between gap-4'>
                      <div className='flex-1'>
                        <h3 className='text-lg font-semibold text-text-primary dark:text-text-primary'>{layout.name}</h3>
                        <p className='mt-2 text-sm text-text-secondary dark:text-text-secondary'>Components</p>
                        <div className='mt-2 flex flex-wrap gap-2'>
                          {components.map((component) => {
                            const info = componentTypes.find((ct) => ct.type === component);
                            return (
                              <span
                                key={component}
                                className='inline-flex rounded-full border border-sea/30 bg-sea/10 px-2.5 py-1 text-xs font-medium text-sea dark:border-accent-blue/40 dark:bg-accent-blue/15 dark:text-accent-blue'
                                title={info?.description}
                              >
                                {info?.name || component}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                      <div className='flex items-start gap-2'>
                        <IconButton
                          onClick={() => openEditModal(layout)}
                          className='text-sea dark:text-accent-blue'
                          title={`Edit ${layout.name}`}
                          aria-label={`Edit ${layout.name}`}
                        >
                          <Pencil size={16} />
                        </IconButton>
                        <IconButton
                          onClick={() => deleteLayout(layout.id)}
                          className='text-terracotta'
                          title={`Delete ${layout.name}`}
                          aria-label={`Delete ${layout.name}`}
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

        <Modal isOpen={showModal} onClose={closeModal} title={editingLayout ? 'Edit Layout' : 'Create Layout'} className='max-w-3xl'>
          <div className='space-y-6'>
            <div>
              <label className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Layout Name</label>
              <input
                type='text'
                value={layoutName}
                onChange={(e) => {
                  setLayoutName(e.target.value);
                  if (errors.name) {
                    setErrors((prev) => ({ ...prev, name: '' }));
                  }
                }}
                placeholder='Enter layout name'
                className={`w-full rounded-xl border bg-white px-4 py-2.5 text-sm text-text-primary outline-none transition-colors dark:bg-dark-sand ${
                  errors.name
                    ? 'border-terracotta focus:ring-2 focus:ring-terracotta'
                    : 'border-sand/40 focus:border-sea focus:ring-2 focus:ring-sea dark:focus:border-accent-blue dark:focus:ring-accent-blue'
                }`}
                autoFocus
              />
              {errors.name ? <p className='mt-1 text-sm text-terracotta'>{errors.name}</p> : null}
            </div>

            <div>
              <label className='mb-3 block text-sm font-medium text-text-primary dark:text-text-primary'>Select Components</label>
              <div className={`grid grid-cols-1 gap-3 md:grid-cols-2 ${errors.components ? 'rounded-2xl border-2 border-terracotta p-2' : ''}`}>
                {componentTypes.map((ct) => (
                  <button
                    key={ct.type}
                    type='button'
                    className={`w-full rounded-2xl border p-3 text-left transition-colors ${
                      selectedComponents.includes(ct.type)
                        ? 'border-sea bg-sea/10 dark:border-accent-blue dark:bg-accent-blue/10'
                        : 'border-sand/30 bg-white hover:bg-sand/10 dark:border-sand/50 dark:bg-dark-sand dark:hover:bg-sand/10'
                    }`}
                    onClick={() => {
                      toggleComponent(ct.type);
                      if (errors.components) {
                        setErrors((prev) => ({ ...prev, components: '' }));
                      }
                    }}
                  >
                    <div className='flex items-start gap-3'>
                      <input
                        type='checkbox'
                        checked={selectedComponents.includes(ct.type)}
                        onChange={() => {
                          toggleComponent(ct.type);
                          if (errors.components) {
                            setErrors((prev) => ({ ...prev, components: '' }));
                          }
                        }}
                        className='mt-0.5 h-4 w-4 rounded border-sand/30 accent-sea'
                        onClick={(e) => e.stopPropagation()}
                      />
                      <div className='min-w-0 flex-1'>
                        <p className='font-semibold text-text-primary dark:text-text-primary'>{ct.name}</p>
                        <p className='mt-1 text-xs text-text-secondary dark:text-text-secondary'>{ct.description}</p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
              {errors.components ? <p className='mt-2 text-sm text-terracotta'>{errors.components}</p> : null}
              {errors.components ? null : selectedComponents.length > 0 ? (
                <p className='mt-2 text-sm text-sea dark:text-accent-blue'>
                  Selected: {selectedComponents.length} component{selectedComponents.length === 1 ? '' : 's'}
                </p>
              ) : null}
              {errors.request ? <p className='mt-2 text-sm text-terracotta'>{errors.request}</p> : null}
            </div>

            <div className='flex justify-end gap-3'>
              <Button onClick={closeModal} variant='secondary' disabled={isSaving}>
                Cancel
              </Button>
              <Button onClick={saveLayout} disabled={isSaving}>
                {isSaving ? 'Saving...' : editingLayout ? 'Update Layout' : 'Create Layout'}
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    </div>
  );
}
