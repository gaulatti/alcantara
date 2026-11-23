import { AlertContainer, Button, Checkbox, Input, Modal, SectionHeader, showAlert } from '@gaulatti/bleecker';
import type { ColumnDef, SortState } from '@gaulatti/bleecker';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Route } from './+types/layouts';
import { apiUrl } from '../utils/apiBaseUrl';
import { OVERLAY_COMPONENTS } from '../models/components';
import { AppPage } from '../components/AppPage';
import { LibraryList, LibraryRowActions } from '../components/library/LibraryList';
import type { LibraryStatus } from '../components/library/LibraryList';

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
  return [{ title: 'Scene templates - Alcantara' }, { name: 'description', content: 'Manage reusable scene templates' }];
}

export default function LayoutsAdmin() {
  const [layouts, setLayouts] = useState<Layout[]>([]);
  const [componentTypes, setComponentTypes] = useState<ComponentType[]>([]);
  const [status, setStatus] = useState<LibraryStatus>('loading');

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

  const load = async () => {
    setStatus('loading');
    try {
      setComponentTypes(OVERLAY_COMPONENTS.map((c) => ({ type: c.id, name: c.name, description: c.description })));
      await fetchLayouts();
      setStatus('ready');
    } catch (err) {
      console.error(err);
      setStatus('error');
    }
  };

  useEffect(() => {
    void load();
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
      nextErrors.name = 'Please enter a template name';
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
      showAlert(editingLayout ? 'Scene template updated.' : 'Scene template created.', 'success');
    } catch (err) {
      console.error('Failed to save layout:', err);
      setErrors((prev) => ({ ...prev, request: 'Failed to save scene template. Please try again.' }));
      showAlert('Failed to save scene template.', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const deleteLayout = async (layoutId: number) => {
    try {
      const res = await fetch(apiUrl(`/layouts/${layoutId}`), {
        method: 'DELETE'
      });
      if (!res.ok) {
        throw new Error(`HTTP error ${res.status}`);
      }
      await fetchLayouts();
      showAlert('Scene template deleted.', 'success');
    } catch (err) {
      console.error('Failed to delete layout:', err);
      showAlert('Cannot delete this scene template because it may be in use by scenes.', 'error');
      throw err;
    }
  };

  const [sort, setSort] = useState<SortState>({ field: 'name', order: 'asc' });

  const columns: ColumnDef<Layout>[] = [
    { key: 'name', header: 'Name', className: 'font-medium text-text-primary' },
    {
      key: 'componentType',
      header: 'Components',
      sortable: false,
      cell: (layout) => (
        <div className='flex flex-wrap gap-1'>
          {layout.componentType
            .split(',')
            .filter(Boolean)
            .map((component) => {
              const info = componentTypes.find((ct) => ct.type === component);
              return (
                <span
                  key={component}
                  className='inline-flex rounded-full border border-sea/30 bg-sea/10 px-2 py-0.5 text-xs font-medium text-sea dark:border-accent-blue/30 dark:bg-accent-blue/10 dark:text-accent-blue'
                  title={info?.description}
                >
                  {info?.name || component}
                </span>
              );
            })}
        </div>
      )
    },
    {
      key: 'actions',
      header: '',
      sortable: false,
      cell: (layout) => (
        <LibraryRowActions
          name={layout.name}
          primary={{ label: 'Edit', onSelect: () => openEditModal(layout) }}
          onDelete={() => deleteLayout(layout.id)}
          deleteTitle={`Delete scene template "${layout.name}"?`}
        />
      )
    }
  ];

  return (
    <AppPage width='wide'>
      <AlertContainer />
      <div className='mx-auto max-w-6xl space-y-6'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
          <SectionHeader title='Scene templates' description='Create and manage reusable scene structures.' />
          <div className='flex flex-wrap items-center gap-3'>
            <Button onClick={openCreateModal}>
              <Plus size={16} />
              Create template
            </Button>
          </div>
        </div>

        <LibraryList
          caption='Scene templates'
          columns={columns}
          data={layouts}
          getRowKey={(layout) => String(layout.id)}
          status={status}
          onRetry={() => void load()}
          errorTitle='Failed to load scene templates'
          empty={{
            title: 'No scene templates yet',
            description: 'Create a reusable template to speed up scene creation.',
            action: (
              <Button onClick={openCreateModal}>
                <Plus size={16} />
                Create your first template
              </Button>
            )
          }}
          sort={sort}
          onSortChange={setSort}
        />

        <Modal isOpen={showModal} onClose={closeModal} title={editingLayout ? 'Edit scene template' : 'Create template'} className='max-w-3xl'>
          <div className='space-y-6'>
            <div>
              <label className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Template name</label>
              <Input
                value={layoutName}
                onChange={(e) => {
                  setLayoutName(e.target.value);
                  if (errors.name) {
                    setErrors((prev) => ({ ...prev, name: '' }));
                  }
                }}
                placeholder='Enter template name'
                error={!!errors.name}
                autoFocus
              />
              {errors.name ? <p className='mt-1 text-sm text-terracotta'>{errors.name}</p> : null}
            </div>

            <div>
              <label className='mb-3 block text-sm font-medium text-text-primary dark:text-text-primary'>Select Components</label>
              <div className={`grid grid-cols-1 gap-3 md:grid-cols-2 ${errors.components ? 'rounded-2xl border-2 border-terracotta p-2' : ''}`}>
                {componentTypes.map((ct) => (
                  <Button
                    key={ct.type}
                    type='button'
                    className={`w-full rounded-2xl border p-3 text-left transition-colors ${
                      selectedComponents.includes(ct.type)
                        ? 'border-sea bg-sea/10  '
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
                      <Checkbox
                        checked={selectedComponents.includes(ct.type)}
                        onChange={() => {
                          toggleComponent(ct.type);
                          if (errors.components) {
                            setErrors((prev) => ({ ...prev, components: '' }));
                          }
                        }}
                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                      />
                      <div className='min-w-0 flex-1'>
                        <p className='font-semibold text-text-primary dark:text-text-primary'>{ct.name}</p>
                        <p className='mt-1 text-xs text-text-secondary dark:text-text-secondary'>{ct.description}</p>
                      </div>
                    </div>
                  </Button>
                ))}
              </div>
              {errors.components ? <p className='mt-2 text-sm text-terracotta'>{errors.components}</p> : null}
              {errors.components ? null : selectedComponents.length > 0 ? (
                <p className='mt-2 text-sm text-sea '>
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
                {isSaving ? 'Saving...' : editingLayout ? 'Update template' : 'Create template'}
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    </AppPage>
  );
}
