import { useEffect, useState } from 'react';
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
    } catch (err) {
      console.error('Failed to save layout:', err);
      setErrors((prev) => ({ ...prev, request: 'Failed to save layout. Please try again.' }));
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
    } catch (err) {
      console.error('Failed to delete layout:', err);
      alert('Cannot delete layout - it may be in use by scenes');
    }
  };

  return (
    <div className='min-h-screen bg-gray-100 p-8'>
      <div className='max-w-6xl mx-auto'>
        <div className='flex justify-between items-center mb-8'>
          <div>
            <h1 className='text-4xl font-bold'>Layouts</h1>
            <p className='text-gray-600 mt-2'>Create and manage reusable scene layouts.</p>
          </div>
          <div className='flex items-center gap-3'>
            <a href='/control' className='px-4 py-2 rounded border border-gray-300 bg-white hover:bg-gray-50 text-sm font-semibold'>
              Back to Control
            </a>
            <button onClick={openCreateModal} className='bg-purple-600 text-white px-4 py-2 rounded hover:bg-purple-700 text-sm font-semibold'>
              + Create Layout
            </button>
          </div>
        </div>

        <div className='bg-white rounded-lg shadow-lg p-6'>
          {isLoading ? (
            <div className='text-gray-500 text-center py-8'>Loading layouts...</div>
          ) : layouts.length === 0 ? (
            <div className='text-gray-500 text-center py-8'>No layouts yet. Create one to get started.</div>
          ) : (
            <div className='space-y-2'>
              {layouts.map((layout) => {
                const components = layout.componentType.split(',').filter(Boolean);
                return (
                  <div key={layout.id} className='p-4 border rounded'>
                    <div className='flex justify-between items-start'>
                      <div className='flex-1'>
                        <div className='font-bold text-lg'>{layout.name}</div>
                        <div className='text-sm text-gray-600 mt-1'>Components:</div>
                        <div className='flex flex-wrap gap-1 mt-1'>
                          {components.map((component) => {
                            const info = componentTypes.find((ct) => ct.type === component);
                            return (
                              <span key={component} className='inline-block bg-purple-100 text-purple-700 text-xs px-2 py-1 rounded' title={info?.description}>
                                {info?.name || component}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                      <div className='flex gap-2'>
                        <button
                          onClick={() => openEditModal(layout)}
                          className='text-purple-600 hover:text-purple-800 px-2 py-1 rounded hover:bg-purple-50'
                          title='Edit layout'
                        >
                          ✏️
                        </button>
                        <button
                          onClick={() => deleteLayout(layout.id)}
                          className='text-red-600 hover:text-red-800 px-2 py-1 rounded hover:bg-red-50'
                          title='Delete layout'
                        >
                          🗑️
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {showModal && (
          <div
            className='fixed inset-0 bg-transparent bg-opacity-50 flex items-center justify-center z-50'
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                closeModal();
              }
            }}
          >
            <div className='bg-white rounded-lg shadow-xl p-6 max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto' onClick={(e) => e.stopPropagation()}>
              <h2 className='text-2xl font-bold mb-4'>{editingLayout ? 'Edit Layout' : 'Create New Layout'}</h2>

              <div className='mb-6'>
                <label className='block text-sm font-medium text-gray-700 mb-2'>Layout Name</label>
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
                  className={`w-full px-4 py-2 border rounded focus:ring-2 focus:ring-purple-500 focus:border-purple-500 ${
                    errors.name ? 'border-red-500 focus:ring-red-500 focus:border-red-500' : ''
                  }`}
                  autoFocus
                />
                {errors.name && <p className='text-red-600 text-sm mt-1'>{errors.name}</p>}
              </div>

              <div className='mb-6'>
                <label className='block text-sm font-medium text-gray-700 mb-3'>Select Components</label>
                <div className={`grid grid-cols-1 md:grid-cols-2 gap-3 ${errors.components ? 'border-2 border-red-500 rounded p-2' : ''}`}>
                  {componentTypes.map((ct) => (
                    <div
                      key={ct.type}
                      className={`border rounded p-3 cursor-pointer transition-all ${
                        selectedComponents.includes(ct.type) ? 'bg-purple-50 border-purple-500 ring-2 ring-purple-200' : 'hover:bg-gray-50'
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
                          className='mt-1 h-4 w-4 text-purple-600 rounded focus:ring-purple-500'
                          onClick={(e) => e.stopPropagation()}
                        />
                        <div className='flex-1'>
                          <div className='font-semibold text-gray-900'>{ct.name}</div>
                          <div className='text-xs text-gray-500 mt-1'>{ct.description}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                {errors.components && <p className='text-red-600 text-sm mt-2'>{errors.components}</p>}
                {!errors.components && selectedComponents.length > 0 && (
                  <div className='mt-3 text-sm text-purple-600'>
                    Selected: {selectedComponents.length} component{selectedComponents.length !== 1 ? 's' : ''}
                  </div>
                )}
                {errors.request && <p className='text-red-600 text-sm mt-2'>{errors.request}</p>}
              </div>

              <div className='flex justify-end gap-3'>
                <button onClick={closeModal} type='button' disabled={isSaving} className='px-4 py-2 border rounded hover:bg-gray-50'>
                  Cancel
                </button>
                <button
                  onClick={saveLayout}
                  type='button'
                  disabled={isSaving}
                  className='bg-purple-600 text-white px-6 py-2 rounded hover:bg-purple-700 disabled:bg-purple-400 disabled:cursor-not-allowed'
                >
                  {isSaving ? 'Saving...' : editingLayout ? 'Update Layout' : 'Create Layout'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
