import { useEffect, useState } from 'react';
import type { Route } from './+types/control';

interface Layout {
  id: number;
  name: string;
  componentType: string;
  settings: string;
}

interface Scene {
  id: number;
  name: string;
  layoutId: number;
  layout: Layout;
  chyronText: string | null;
  metadata: string | null;
}

interface ComponentType {
  type: string;
  name: string;
  description: string;
}

interface ProgramSceneEntry {
  id: number;
  sceneId: number;
  position: number;
  scene: Scene;
}

interface ProgramState {
  id: number;
  programId: string;
  activeSceneId: number | null;
  scenes: ProgramSceneEntry[];
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Control Panel - TV Broadcast' }, { name: 'description', content: 'Control panel for TV broadcast overlay system' }];
}

export default function Control() {
  const [programIdInput, setProgramIdInput] = useState('main');
  const [programId, setProgramId] = useState('main');
  const [programState, setProgramState] = useState<ProgramState | null>(null);
  const [programs, setPrograms] = useState<ProgramState[]>([]);
  const activeProgramId = programId.trim() || 'main';
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [layouts, setLayouts] = useState<Layout[]>([]);
  const [componentTypes, setComponentTypes] = useState<ComponentType[]>([]);
  const [selectedScene, setSelectedScene] = useState<number | null>(null);
  const [sceneEditorChyronText, setSceneEditorChyronText] = useState('');
  const [sceneEditorProps, setSceneEditorProps] = useState<Record<string, any>>({});
  const [isSavingSceneAttributes, setIsSavingSceneAttributes] = useState(false);
  const [editingScene, setEditingScene] = useState<Scene | null>(null);
  const [editingLayout, setEditingLayout] = useState<Layout | null>(null);
  const [showLayoutModal, setShowLayoutModal] = useState(false);
  const [newLayoutName, setNewLayoutName] = useState('');
  const [selectedComponents, setSelectedComponents] = useState<string[]>([]);
  const [layoutErrors, setLayoutErrors] = useState({ name: '', components: '' });
  const [isCreatingLayout, setIsCreatingLayout] = useState(false);

  const [showSceneModal, setShowSceneModal] = useState(false);
  const [newSceneName, setNewSceneName] = useState('');
  const [selectedLayoutId, setSelectedLayoutId] = useState<number | null>(null);
  const [sceneComponentProps, setSceneComponentProps] = useState<Record<string, any>>({});
  const [sceneErrors, setSceneErrors] = useState({ name: '', layout: '', props: '' });
  const [isCreatingScene, setIsCreatingScene] = useState(false);

  useEffect(() => {
    fetchScenes();
    fetchLayouts();
    fetchComponentTypes();
    fetchPrograms();
  }, []);

  useEffect(() => {
    fetchProgramState(activeProgramId);
  }, [activeProgramId]);

  useEffect(() => {
    console.log('showLayoutModal changed to:', showLayoutModal);
  }, [showLayoutModal]);

  const fetchScenes = async () => {
    try {
      const res = await fetch('http://localhost:3000/scenes');
      const data = await res.json();
      setScenes(data);
    } catch (err) {
      console.error('Failed to fetch scenes:', err);
    }
  };

  const fetchLayouts = async () => {
    try {
      const res = await fetch('http://localhost:3000/layouts');
      const data = await res.json();
      setLayouts(data);
    } catch (err) {
      console.error('Failed to fetch layouts:', err);
    }
  };

  const fetchComponentTypes = async () => {
    try {
      const res = await fetch('http://localhost:3000/layouts/component-types');
      const data = await res.json();
      setComponentTypes(data);
    } catch (err) {
      console.error('Failed to fetch component types:', err);
    }
  };

  const fetchPrograms = async () => {
    try {
      const res = await fetch('http://localhost:3000/program');
      const data = await res.json();
      setPrograms(data);
    } catch (err) {
      console.error('Failed to fetch programs:', err);
    }
  };

  const fetchProgramState = async (targetProgramId: string) => {
    try {
      const res = await fetch(
        `http://localhost:3000/program/${encodeURIComponent(targetProgramId)}/state`,
      );
      const data = await res.json();
      setProgramState(data);
      setSelectedScene(data?.activeSceneId ?? null);
      fetchPrograms();
    } catch (err) {
      console.error('Failed to fetch program state:', err);
    }
  };

  const buildComponentPropsForScene = (scene: Scene): Record<string, any> => {
    let metadata: Record<string, any> = {};
    try {
      const parsed = scene.metadata ? JSON.parse(scene.metadata) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed;
      }
    } catch (err) {
      console.error('Failed to parse scene metadata for editor:', err);
    }

    const components = scene.layout.componentType.split(',').filter(Boolean);
    const combined: Record<string, any> = {};

    for (const componentType of components) {
      combined[componentType] = {
        ...getDefaultPropsForComponent(componentType),
        ...(metadata[componentType] || {})
      };
    }

    return combined;
  };

  const createOrSelectProgram = async () => {
    const nextProgramId = programIdInput.trim() || 'main';

    try {
      await fetch('http://localhost:3000/program', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ programId: nextProgramId }),
      });
      setProgramId(nextProgramId);
      setProgramIdInput(nextProgramId);
    } catch (err) {
      console.error('Failed to create/select program:', err);
    }
  };

  const isSceneAssigned = (sceneId: number) =>
    !!programState?.scenes.some((programScene) => programScene.sceneId === sceneId);

  const assignSceneToProgram = async (sceneId: number) => {
    try {
      await fetch(`http://localhost:3000/program/${encodeURIComponent(activeProgramId)}/scenes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneId }),
      });
      await fetchProgramState(activeProgramId);
    } catch (err) {
      console.error('Failed to assign scene to program:', err);
    }
  };

  const removeSceneFromProgram = async (sceneId: number) => {
    try {
      await fetch(
        `http://localhost:3000/program/${encodeURIComponent(activeProgramId)}/scenes/${sceneId}`,
        { method: 'DELETE' },
      );
      await fetchProgramState(activeProgramId);
    } catch (err) {
      console.error('Failed to remove scene from program:', err);
    }
  };

  const activateScene = async (sceneId: number) => {
    try {
      if (!isSceneAssigned(sceneId)) {
        await assignSceneToProgram(sceneId);
      }
      await fetch(`http://localhost:3000/program/${encodeURIComponent(activeProgramId)}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneId })
      });
      setSelectedScene(sceneId);
      await fetchProgramState(activeProgramId);
    } catch (err) {
      console.error('Failed to activate scene:', err);
    }
  };

  useEffect(() => {
    if (!selectedScene) {
      setSceneEditorChyronText('');
      setSceneEditorProps({});
      return;
    }

    const scene = scenes.find((s) => s.id === selectedScene);
    if (!scene) {
      return;
    }

    setSceneEditorChyronText(scene.chyronText || '');
    setSceneEditorProps(buildComponentPropsForScene(scene));
  }, [selectedScene, scenes]);

  const updateSceneEditorProp = (componentType: string, propName: string, value: any) => {
    setSceneEditorProps((prev) => ({
      ...prev,
      [componentType]: {
        ...prev[componentType],
        [propName]: value
      }
    }));
  };

  const saveSceneAttributes = async () => {
    if (!selectedScene) return;

    setIsSavingSceneAttributes(true);
    try {
      const response = await fetch(`http://localhost:3000/scenes/${selectedScene}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chyronText: sceneEditorChyronText,
          metadata: sceneEditorProps
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      await fetchScenes();
      await fetchProgramState(activeProgramId);
    } catch (err) {
      console.error('Failed to update scene attributes:', err);
    } finally {
      setIsSavingSceneAttributes(false);
    }
  };

  const openSceneModal = () => {
    if (layouts.length === 0) {
      alert('Please create a layout first');
      return;
    }
    setEditingScene(null);
    setNewSceneName('');
    setSelectedLayoutId(null);
    setSceneComponentProps({});
    setSceneErrors({ name: '', layout: '', props: '' });
    setShowSceneModal(true);
  };

  const openEditSceneModal = (scene: Scene) => {
    console.log('Editing scene:', scene);
    console.log('Scene metadata (raw):', scene.metadata);

    setEditingScene(scene);
    setNewSceneName(scene.name);
    setSelectedLayoutId(scene.layoutId);

    // Parse metadata if it exists
    try {
      const metadata = scene.metadata ? JSON.parse(scene.metadata) : {};
      console.log('Parsed metadata:', metadata);
      console.log('Metadata is array?', Array.isArray(metadata));
      console.log('Metadata keys:', Object.keys(metadata));

      // If metadata is valid object with component keys, use it
      if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
        setSceneComponentProps(metadata);
      } else {
        console.warn('Invalid metadata structure, falling back to defaults');
        handleLayoutSelect(scene.layoutId);
      }
    } catch (err) {
      console.error('Failed to parse scene metadata:', err);
      // Fall back to default props
      handleLayoutSelect(scene.layoutId);
    }

    setSceneErrors({ name: '', layout: '', props: '' });
    setShowSceneModal(true);
  };

  const closeSceneModal = () => {
    setShowSceneModal(false);
    setEditingScene(null);
    setNewSceneName('');
    setSelectedLayoutId(null);
    setSceneComponentProps({});
    setSceneErrors({ name: '', layout: '', props: '' });
  };

  const handleLayoutSelect = (layoutId: number) => {
    setSelectedLayoutId(layoutId);
    const layout = layouts.find((l) => l.id === layoutId);
    if (layout) {
      const components = layout.componentType.split(',').filter(Boolean);
      const initialProps: Record<string, any> = {};
      components.forEach((comp) => {
        initialProps[comp] = getDefaultPropsForComponent(comp);
      });
      setSceneComponentProps(initialProps);
    }
  };

  const getDefaultPropsForComponent = (componentType: string): any => {
    switch (componentType) {
      case 'ticker':
        return { hashtag: '#ModoSanremoMR', url: 'modoradio.cl' };
      case 'chyron':
        return { text: '', duration: 5000 };
      case 'header':
        return { title: '', date: new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }) };
      case 'clock-widget':
        return { showIcon: true, iconUrl: '', timezone: 'America/Argentina/Buenos_Aires' };
      case 'live-indicator':
        return { text: 'VIVO', animate: true };
      case 'logo-widget':
        return { text: 'mr', logoUrl: '', position: 'bottom-right' };
      case 'qr-code':
        return { qrCodeUrl: '', placeholder: true, content: 'https://modoradio.cl' };
      case 'broadcast-layout':
        return {
          headerTitle: '',
          hashtag: '#ModoSanremoMR',
          url: 'modoradio.cl',
          logoText: 'mr',
          liveText: 'VIVO',
          qrCodeContent: 'https://modoradio.cl',
          clockTimezone: 'America/Argentina/Buenos_Aires'
        };
      default:
        return {};
    }
  };

  const updateComponentProp = (componentType: string, propName: string, value: any) => {
    setSceneComponentProps((prev) => ({
      ...prev,
      [componentType]: {
        ...prev[componentType],
        [propName]: value
      }
    }));
  };

  const createScene = async () => {
    const errors = { name: '', layout: '', props: '' };

    if (!newSceneName.trim()) {
      errors.name = 'Please enter a scene name';
    }

    if (!selectedLayoutId) {
      errors.layout = 'Please select a layout';
    }

    if (errors.name || errors.layout) {
      setSceneErrors(errors);
      return;
    }

    setIsCreatingScene(true);

    try {
      const payload = {
        name: newSceneName,
        layoutId: selectedLayoutId,
        chyronText: sceneComponentProps['chyron']?.text || '',
        metadata: sceneComponentProps // Send as object, backend will stringify
      };

      const url = editingScene ? `http://localhost:3000/scenes/${editingScene.id}` : 'http://localhost:3000/scenes';
      const method = editingScene ? 'PUT' : 'POST';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      await fetchScenes();
      closeSceneModal();
    } catch (err) {
      console.error('Failed to save scene:', err);
      setSceneErrors({ ...errors, name: 'Failed to save scene. Please try again.' });
    } finally {
      setIsCreatingScene(false);
    }
  };

  const deleteScene = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this scene?')) return;

    try {
      await fetch(`http://localhost:3000/scenes/${id}`, {
        method: 'DELETE'
      });
      if (selectedScene === id) {
        setSelectedScene(null);
      }
      fetchScenes();
      fetchProgramState(activeProgramId);
    } catch (err) {
      console.error('Failed to delete scene:', err);
    }
  };

  const openLayoutModal = () => {
    console.log('Opening layout modal - BEFORE setState');
    setEditingLayout(null);
    setNewLayoutName('');
    setSelectedComponents([]);
    setLayoutErrors({ name: '', components: '' });
    setShowLayoutModal(true);
    console.log('Opening layout modal - AFTER setState');
    // Use setTimeout to log the state after it updates
    setTimeout(() => {
      console.log('Modal should now be visible, showLayoutModal should be true');
    }, 100);
  };

  const openEditLayoutModal = (layout: Layout) => {
    setEditingLayout(layout);
    setNewLayoutName(layout.name);
    setSelectedComponents(layout.componentType.split(',').filter(Boolean));
    setLayoutErrors({ name: '', components: '' });
    setShowLayoutModal(true);
  };

  const closeLayoutModal = () => {
    setShowLayoutModal(false);
    setEditingLayout(null);
    setNewLayoutName('');
    setSelectedComponents([]);
    setLayoutErrors({ name: '', components: '' });
  };

  const toggleComponent = (componentType: string) => {
    console.log('Toggle component:', componentType);
    setSelectedComponents((prev) => {
      const newSelection = prev.includes(componentType) ? prev.filter((c) => c !== componentType) : [...prev, componentType];
      console.log('New selection:', newSelection);
      return newSelection;
    });
  };

  const createLayout = async () => {
    console.log('Creating/updating layout:', { newLayoutName, selectedComponents, editingLayout });
    const errors = { name: '', components: '' };

    if (!newLayoutName.trim()) {
      errors.name = 'Please enter a layout name';
    }

    if (selectedComponents.length === 0) {
      errors.components = 'Please select at least one component';
    }

    if (errors.name || errors.components) {
      console.log('Validation errors:', errors);
      setLayoutErrors(errors);
      return;
    }

    setIsCreatingLayout(true);

    try {
      const payload = {
        name: newLayoutName,
        componentType: selectedComponents.join(','),
        settings: { components: selectedComponents }
      };

      console.log('Sending request with payload:', payload);

      const url = editingLayout ? `http://localhost:3000/layouts/${editingLayout.id}` : 'http://localhost:3000/layouts';
      const method = editingLayout ? 'PUT' : 'POST';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Server error:', response.status, errorText);
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      console.log('Layout saved successfully:', result);

      await fetchLayouts();
      closeLayoutModal();
    } catch (err) {
      console.error('Failed to save layout:', err);
      setLayoutErrors({ ...errors, name: 'Failed to save layout. Please try again.' });
    } finally {
      setIsCreatingLayout(false);
    }
  };

  const deleteLayout = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this layout?')) return;

    try {
      await fetch(`http://localhost:3000/layouts/${id}`, {
        method: 'DELETE'
      });
      fetchLayouts();
    } catch (err) {
      console.error('Failed to delete layout:', err);
      alert('Cannot delete layout - it may be in use by scenes');
    }
  };

  return (
    <div className='min-h-screen bg-gray-100 p-8'>
      <div className='max-w-7xl mx-auto'>
        <div className='flex justify-between items-center mb-8'>
          <h1 className='text-4xl font-bold'>Control Panel</h1>
          <div className='flex items-center gap-3'>
            <label htmlFor='programIdInput' className='text-sm font-semibold text-gray-700'>
              Program ID
            </label>
            <input
              id='programIdInput'
              value={programIdInput}
              onChange={(e) => setProgramIdInput(e.target.value)}
              className='border border-gray-300 rounded px-3 py-2 text-sm w-48'
              placeholder='main'
            />
            <button
              onClick={createOrSelectProgram}
              className='bg-emerald-600 text-white px-4 py-2 rounded hover:bg-emerald-700 text-sm font-semibold'
            >
              Create / Select
            </button>
            <a
              href={`/program/${encodeURIComponent(activeProgramId)}`}
              className='bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 text-sm font-semibold'
              target='_blank'
              rel='noopener noreferrer'
            >
              Open Program
            </a>
            <a
              href='/preview'
              className='bg-indigo-600 text-white px-6 py-3 rounded-lg hover:bg-indigo-700 font-semibold'
              target='_blank'
              rel='noopener noreferrer'
            >
              👁️ Preview Components
            </a>
          </div>
        </div>

        <div className='bg-white rounded-lg shadow-lg p-4 mb-8'>
          <div className='text-sm text-gray-600 mb-2'>Current program: <span className='font-semibold text-gray-900'>{activeProgramId}</span></div>
          <div className='flex flex-wrap gap-2'>
            {programs.map((program) => (
              <button
                key={program.programId}
                onClick={() => {
                  setProgramId(program.programId);
                  setProgramIdInput(program.programId);
                }}
                className={`px-3 py-1 rounded text-sm border ${
                  program.programId === activeProgramId ? 'bg-blue-100 border-blue-300 text-blue-700' : 'bg-gray-50 border-gray-200 text-gray-700'
                }`}
              >
                {program.programId}
              </button>
            ))}
          </div>
        </div>

        {/* Component Types Info */}
        <div className='bg-blue-50 border border-blue-200 rounded-lg p-4 mb-8'>
          <h3 className='font-bold text-blue-900 mb-2'>Available Component Types:</h3>
          <div className='grid grid-cols-1 md:grid-cols-3 gap-4'>
            {componentTypes.map((ct) => (
              <div key={ct.type} className='bg-white rounded p-3'>
                <div className='font-semibold text-blue-700'>{ct.name}</div>
                <div className='text-sm text-gray-600'>{ct.type}</div>
                <div className='text-xs text-gray-500 mt-1'>{ct.description}</div>
              </div>
            ))}
          </div>
        </div>

        <div className='bg-white rounded-lg shadow-lg p-6 mb-8'>
          <h2 className='text-2xl font-bold mb-4'>Program Scenes</h2>
          <p className='text-sm text-gray-600 mb-4'>Assign scenes to this program, then activate one at a time.</p>
          <div className='space-y-2 max-h-64 overflow-y-auto'>
            {programState?.scenes.length ? (
              programState.scenes.map((programScene) => (
                <div key={programScene.id} className='p-3 border rounded flex items-center justify-between'>
                  <div>
                    <div className='font-semibold'>
                      {programScene.position + 1}. {programScene.scene.name}
                    </div>
                    <div className='text-sm text-gray-500'>Layout: {programScene.scene.layout.name}</div>
                  </div>
                  <div className='flex gap-2'>
                    <button
                      onClick={() => activateScene(programScene.sceneId)}
                      className='px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 text-sm'
                    >
                      {selectedScene === programScene.sceneId ? 'Active' : 'Activate'}
                    </button>
                    <button
                      onClick={() => removeSceneFromProgram(programScene.sceneId)}
                      className='px-3 py-1 rounded bg-red-100 text-red-700 hover:bg-red-200 text-sm'
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className='text-gray-500 text-sm'>No scenes assigned to this program yet.</div>
            )}
          </div>
        </div>

        <div className='grid grid-cols-1 md:grid-cols-2 gap-8'>
          {/* Scenes Panel */}
          <div className='bg-white rounded-lg shadow-lg p-6'>
            <div className='flex justify-between items-center mb-4'>
              <h2 className='text-2xl font-bold'>Scenes</h2>
              <button onClick={openSceneModal} className='bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700'>
                + Create Scene
              </button>
            </div>
            <div className='space-y-2 max-h-96 overflow-y-auto'>
              {scenes.length === 0 ? (
                <div className='text-gray-500 text-center py-8'>No scenes yet. Create one to get started!</div>
              ) : (
                scenes.map((scene) => {
                  const components = scene.layout.componentType.split(',').filter(Boolean);
                  const assigned = isSceneAssigned(scene.id);
                  return (
                    <div
                      key={scene.id}
                      className={`p-4 border rounded hover:bg-gray-50 ${selectedScene === scene.id ? 'bg-blue-50 border-blue-500 ring-2 ring-blue-200' : ''}`}
                    >
                      <div className='flex justify-between items-start'>
                        <div className='flex-1 cursor-pointer' onClick={() => activateScene(scene.id)}>
                          <div className='font-bold text-lg'>{scene.name}</div>
                          <div className='text-sm text-gray-600 mt-1'>Layout: {scene.layout.name}</div>
                          <div className='flex flex-wrap gap-1 mt-1'>
                            {components.slice(0, 3).map((component) => {
                              const ct = componentTypes.find((c) => c.type === component);
                              return (
                                <span key={component} className='inline-block bg-blue-100 text-blue-700 text-xs px-2 py-1 rounded'>
                                  {ct?.name || component}
                                </span>
                              );
                            })}
                            {components.length > 3 && (
                              <span className='inline-block bg-gray-100 text-gray-600 text-xs px-2 py-1 rounded'>+{components.length - 3} more</span>
                            )}
                          </div>
                          <div className='text-xs mt-2'>
                            {assigned ? (
                              <span className='inline-block px-2 py-1 rounded bg-emerald-100 text-emerald-700'>Assigned to program</span>
                            ) : (
                              <span className='inline-block px-2 py-1 rounded bg-gray-100 text-gray-600'>Not assigned</span>
                            )}
                          </div>
                          <div className='text-sm text-gray-500 mt-1'>Text: {scene.chyronText || '(none)'}</div>
                        </div>
                        <div className='flex gap-2'>
                          {assigned ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                removeSceneFromProgram(scene.id);
                              }}
                              className='text-orange-600 hover:text-orange-800 px-2 py-1 rounded hover:bg-orange-50'
                              title='Remove from program'
                            >
                              ➖
                            </button>
                          ) : (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                assignSceneToProgram(scene.id);
                              }}
                              className='text-blue-600 hover:text-blue-800 px-2 py-1 rounded hover:bg-blue-50'
                              title='Add to program'
                            >
                              ➕
                            </button>
                          )}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              openEditSceneModal(scene);
                            }}
                            className='text-green-600 hover:text-green-800 px-2 py-1 rounded hover:bg-green-50'
                            title='Edit scene'
                          >
                            ✏️
                          </button>
                          <button
                            onClick={(e) => deleteScene(scene.id, e)}
                            className='text-red-600 hover:text-red-800 px-2 py-1 rounded hover:bg-red-50'
                            title='Delete scene'
                          >
                            🗑️
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Layouts Panel */}
          <div className='bg-white rounded-lg shadow-lg p-6'>
            <div className='flex justify-between items-center mb-4'>
              <h2 className='text-2xl font-bold'>Layouts</h2>
              <button onClick={openLayoutModal} className='bg-purple-600 text-white px-4 py-2 rounded hover:bg-purple-700'>
                + Create Layout
              </button>
            </div>
            <div className='space-y-2 max-h-96 overflow-y-auto'>
              {layouts.length === 0 ? (
                <div className='text-gray-500 text-center py-8'>No layouts yet. Create one to get started!</div>
              ) : (
                layouts.map((layout) => {
                  const components = layout.componentType.split(',').filter(Boolean);
                  return (
                    <div key={layout.id} className='p-4 border rounded'>
                      <div className='flex justify-between items-start'>
                        <div className='flex-1'>
                          <div className='font-bold text-lg'>{layout.name}</div>
                          <div className='text-sm text-gray-600 mt-1'>Components:</div>
                          <div className='flex flex-wrap gap-1 mt-1'>
                            {components.map((component) => {
                              const ct = componentTypes.find((c) => c.type === component);
                              return (
                                <span key={component} className='inline-block bg-purple-100 text-purple-700 text-xs px-2 py-1 rounded' title={ct?.description}>
                                  {ct?.name || component}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                        <div className='flex gap-2'>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              openEditLayoutModal(layout);
                            }}
                            className='text-purple-600 hover:text-purple-800 px-2 py-1 rounded hover:bg-purple-50'
                            title='Edit layout'
                          >
                            ✏️
                          </button>
                          <button
                            onClick={(e) => deleteLayout(layout.id, e)}
                            className='text-red-600 hover:text-red-800 px-2 py-1 rounded hover:bg-red-50'
                            title='Delete layout'
                          >
                            🗑️
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Scene Attributes Panel */}
        <div className='bg-white rounded-lg shadow-lg p-6 mt-8'>
          <h2 className='text-2xl font-bold mb-4'>Edit Scene Attributes</h2>
          {!selectedScene ? (
            <p className='text-sm text-gray-500 mt-2'>Click on a scene above to edit all component attributes for that scene.</p>
          ) : (
            <div className='space-y-4'>
              <p className='text-sm text-blue-600'>Editing scene: {scenes.find((s) => s.id === selectedScene)?.name}</p>
              <div>
                <label className='block text-xs text-gray-600 mb-1'>Scene Chyron Text</label>
                <input
                  type='text'
                  value={sceneEditorChyronText}
                  onChange={(e) => setSceneEditorChyronText(e.target.value)}
                  placeholder='Enter chyron text'
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-blue-500'
                />
              </div>
              <div className='space-y-4 max-h-96 overflow-y-auto border rounded p-4'>
                {Object.entries(sceneEditorProps).map(([componentType, props]) => {
                  const compInfo = componentTypes.find((ct) => ct.type === componentType);
                  return (
                    <div key={componentType} className='border-b pb-4 last:border-b-0'>
                      <h4 className='font-semibold text-md mb-2 text-gray-800'>{compInfo?.name || componentType}</h4>
                      <ComponentPropsFields componentType={componentType} props={props} updateProp={updateSceneEditorProp} />
                    </div>
                  );
                })}
              </div>
              <div className='flex justify-end'>
                <button
                  onClick={saveSceneAttributes}
                  disabled={isSavingSceneAttributes}
                  className='bg-blue-600 text-white px-6 py-2 rounded hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed'
                >
                  {isSavingSceneAttributes ? 'Saving...' : 'Save Scene Attributes'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Layout Creation Modal */}
        {showLayoutModal && (
          <div
            className='fixed inset-0 bg-transparent bg-opacity-50 flex items-center justify-center z-50'
            onClick={(e) => {
              // Close modal if clicking on backdrop
              if (e.target === e.currentTarget) {
                closeLayoutModal();
              }
            }}
          >
            <div className='bg-white rounded-lg shadow-xl p-6 max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto' onClick={(e) => e.stopPropagation()}>
              <h2 className='text-2xl font-bold mb-4'>{editingLayout ? 'Edit Layout' : 'Create New Layout'}</h2>

              <div className='mb-6'>
                <label className='block text-sm font-medium text-gray-700 mb-2'>Layout Name</label>
                <input
                  type='text'
                  value={newLayoutName}
                  onChange={(e) => {
                    console.log('Input changed:', e.target.value);
                    setNewLayoutName(e.target.value);
                    if (layoutErrors.name) {
                      setLayoutErrors({ ...layoutErrors, name: '' });
                    }
                  }}
                  placeholder='Enter layout name'
                  className={`w-full px-4 py-2 border rounded focus:ring-2 focus:ring-purple-500 focus:border-purple-500 ${
                    layoutErrors.name ? 'border-red-500 focus:ring-red-500 focus:border-red-500' : ''
                  }`}
                  autoFocus
                />
                {layoutErrors.name && <p className='text-red-600 text-sm mt-1'>{layoutErrors.name}</p>}
              </div>

              <div className='mb-6'>
                <label className='block text-sm font-medium text-gray-700 mb-3'>Select Components</label>
                <div className={`grid grid-cols-1 md:grid-cols-2 gap-3 ${layoutErrors.components ? 'border-2 border-red-500 rounded p-2' : ''}`}>
                  {componentTypes.map((ct) => (
                    <div
                      key={ct.type}
                      className={`border rounded p-3 cursor-pointer transition-all ${
                        selectedComponents.includes(ct.type) ? 'bg-purple-50 border-purple-500 ring-2 ring-purple-200' : 'hover:bg-gray-50'
                      }`}
                      onClick={() => {
                        toggleComponent(ct.type);
                        if (layoutErrors.components) {
                          setLayoutErrors({ ...layoutErrors, components: '' });
                        }
                      }}
                    >
                      <div className='flex items-start gap-3'>
                        <input
                          type='checkbox'
                          checked={selectedComponents.includes(ct.type)}
                          onChange={() => {
                            toggleComponent(ct.type);
                            if (layoutErrors.components) {
                              setLayoutErrors({ ...layoutErrors, components: '' });
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
                {layoutErrors.components && <p className='text-red-600 text-sm mt-2'>{layoutErrors.components}</p>}
                {!layoutErrors.components && selectedComponents.length > 0 && (
                  <div className='mt-3 text-sm text-purple-600'>
                    Selected: {selectedComponents.length} component{selectedComponents.length !== 1 ? 's' : ''}
                  </div>
                )}
              </div>

              <div className='flex justify-end gap-3'>
                <button onClick={closeLayoutModal} type='button' disabled={isCreatingLayout} className='px-4 py-2 border rounded hover:bg-gray-50'>
                  Cancel
                </button>
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    console.log('Create Layout button clicked');
                    createLayout();
                  }}
                  type='button'
                  disabled={isCreatingLayout}
                  className='bg-purple-600 text-white px-6 py-2 rounded hover:bg-purple-700 disabled:bg-purple-400 disabled:cursor-not-allowed'
                >
                  {isCreatingLayout ? 'Creating...' : 'Create Layout'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Scene Creation Modal */}
        {showSceneModal && (
          <div
            className='fixed inset-0 bg-transparent bg-opacity-50 flex items-center justify-center z-50'
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                closeSceneModal();
              }
            }}
          >
            <div className='bg-white rounded-lg shadow-xl p-6 max-w-3xl w-full mx-4 max-h-[90vh] overflow-y-auto' onClick={(e) => e.stopPropagation()}>
              <h2 className='text-2xl font-bold mb-4'>{editingScene ? 'Edit Scene' : 'Create New Scene'}</h2>

              {/* Scene Name */}
              <div className='mb-6'>
                <label className='block text-sm font-medium text-gray-700 mb-2'>Scene Name</label>
                <input
                  type='text'
                  value={newSceneName}
                  onChange={(e) => {
                    setNewSceneName(e.target.value);
                    if (sceneErrors.name) {
                      setSceneErrors({ ...sceneErrors, name: '' });
                    }
                  }}
                  placeholder='Enter scene name'
                  className={`w-full px-4 py-2 border rounded focus:ring-2 focus:ring-green-500 focus:border-green-500 ${
                    sceneErrors.name ? 'border-red-500 focus:ring-red-500 focus:border-red-500' : ''
                  }`}
                  autoFocus
                />
                {sceneErrors.name && <p className='text-red-600 text-sm mt-1'>{sceneErrors.name}</p>}
              </div>

              {/* Layout Selection */}
              <div className='mb-6'>
                <label className='block text-sm font-medium text-gray-700 mb-2'>Select Layout</label>
                <select
                  value={selectedLayoutId || ''}
                  onChange={(e) => {
                    handleLayoutSelect(Number(e.target.value));
                    if (sceneErrors.layout) {
                      setSceneErrors({ ...sceneErrors, layout: '' });
                    }
                  }}
                  className={`w-full px-4 py-2 border rounded focus:ring-2 focus:ring-green-500 focus:border-green-500 ${
                    sceneErrors.layout ? 'border-red-500 focus:ring-red-500 focus:border-red-500' : ''
                  }`}
                >
                  <option value=''>-- Select a layout --</option>
                  {layouts.map((layout) => (
                    <option key={layout.id} value={layout.id}>
                      {layout.name}
                    </option>
                  ))}
                </select>
                {sceneErrors.layout && <p className='text-red-600 text-sm mt-1'>{sceneErrors.layout}</p>}
              </div>

              {/* Component Props */}
              {selectedLayoutId && (
                <div className='mb-6'>
                  <h3 className='text-lg font-semibold mb-3'>Component Configuration</h3>
                  <div className='space-y-4 max-h-96 overflow-y-auto border rounded p-4'>
                    {Object.entries(sceneComponentProps).map(([componentType, props]) => {
                      const compInfo = componentTypes.find((ct) => ct.type === componentType);
                      return (
                        <div key={componentType} className='border-b pb-4 last:border-b-0'>
                          <h4 className='font-semibold text-md mb-2 text-gray-800'>{compInfo?.name || componentType}</h4>
                          <ComponentPropsFields componentType={componentType} props={props} updateProp={updateComponentProp} />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className='flex justify-end gap-3'>
                <button onClick={closeSceneModal} type='button' disabled={isCreatingScene} className='px-4 py-2 border rounded hover:bg-gray-50'>
                  Cancel
                </button>
                <button
                  onClick={createScene}
                  type='button'
                  disabled={isCreatingScene || !selectedLayoutId}
                  className='bg-green-600 text-white px-6 py-2 rounded hover:bg-green-700 disabled:bg-green-400 disabled:cursor-not-allowed'
                >
                  {isCreatingScene ? (editingScene ? 'Updating...' : 'Creating...') : editingScene ? 'Update Scene' : 'Create Scene'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ComponentPropsFields({
  componentType,
  props,
  updateProp
}: {
  componentType: string;
  props: any;
  updateProp: (componentType: string, propName: string, value: any) => void;
}): JSX.Element {
  switch (componentType) {
    case 'ticker':
      return (
        <div className='grid grid-cols-2 gap-3'>
          <div>
            <label className='block text-xs text-gray-600 mb-1'>Hashtag</label>
            <input
              type='text'
              value={props.hashtag || ''}
              onChange={(e) => updateProp(componentType, 'hashtag', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              placeholder='#Hashtag'
            />
          </div>
          <div>
            <label className='block text-xs text-gray-600 mb-1'>URL</label>
            <input
              type='text'
              value={props.url || ''}
              onChange={(e) => updateProp(componentType, 'url', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              placeholder='website.com'
            />
          </div>
        </div>
      );
    case 'chyron':
      return (
        <div className='space-y-2'>
          <div>
            <label className='block text-xs text-gray-600 mb-1'>Text</label>
            <input
              type='text'
              value={props.text || ''}
              onChange={(e) => updateProp(componentType, 'text', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              placeholder='Chyron message'
            />
          </div>
        </div>
      );
    case 'header':
      return (
        <div className='grid grid-cols-2 gap-3'>
          <div>
            <label className='block text-xs text-gray-600 mb-1'>Title</label>
            <input
              type='text'
              value={props.title || ''}
              onChange={(e) => updateProp(componentType, 'title', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              placeholder='Program title'
            />
          </div>
          <div>
            <label className='block text-xs text-gray-600 mb-1'>Date</label>
            <input
              type='text'
              value={props.date || ''}
              onChange={(e) => updateProp(componentType, 'date', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
            />
          </div>
        </div>
      );
    case 'live-indicator':
      return (
        <div>
          <label className='block text-xs text-gray-600 mb-1'>Text</label>
          <input
            type='text'
            value={props.text || 'VIVO'}
            onChange={(e) => updateProp(componentType, 'text', e.target.value)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
          />
        </div>
      );
    case 'logo-widget':
      return (
        <div>
          <label className='block text-xs text-gray-600 mb-1'>Logo Text</label>
          <input
            type='text'
            value={props.text || 'mr'}
            onChange={(e) => updateProp(componentType, 'text', e.target.value)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
          />
        </div>
      );
    case 'qr-code':
      return (
        <div>
          <label className='block text-xs text-gray-600 mb-1'>QR Code Content (URL or text)</label>
          <input
            type='text'
            value={props.content || ''}
            onChange={(e) => updateProp(componentType, 'content', e.target.value)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
            placeholder='https://example.com'
          />
          <p className='text-xs text-gray-500 mt-1'>Enter URL or text to encode in QR code</p>
        </div>
      );
    case 'broadcast-layout':
      return (
        <div className='grid grid-cols-2 gap-3'>
          <div>
            <label className='block text-xs text-gray-600 mb-1'>Header Title</label>
            <input
              type='text'
              value={props.headerTitle || ''}
              onChange={(e) => updateProp(componentType, 'headerTitle', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              placeholder='Program title'
            />
          </div>
          <div>
            <label className='block text-xs text-gray-600 mb-1'>Hashtag</label>
            <input
              type='text'
              value={props.hashtag || ''}
              onChange={(e) => updateProp(componentType, 'hashtag', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
            />
          </div>
          <div>
            <label className='block text-xs text-gray-600 mb-1'>URL</label>
            <input
              type='text'
              value={props.url || ''}
              onChange={(e) => updateProp(componentType, 'url', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
            />
          </div>
          <div>
            <label className='block text-xs text-gray-600 mb-1'>Logo Text</label>
            <input
              type='text'
              value={props.logoText || ''}
              onChange={(e) => updateProp(componentType, 'logoText', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
            />
          </div>
          <div className='col-span-2'>
            <label className='block text-xs text-gray-600 mb-1'>QR Code Content</label>
            <input
              type='text'
              value={props.qrCodeContent || ''}
              onChange={(e) => updateProp(componentType, 'qrCodeContent', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              placeholder='https://example.com'
            />
          </div>
          <div className='col-span-2'>
            <label className='block text-xs text-gray-600 mb-1'>Clock Timezone</label>
            <select
              value={props.clockTimezone || 'America/Argentina/Buenos_Aires'}
              onChange={(e) => updateProp(componentType, 'clockTimezone', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
            >
              <option value='America/Argentina/Buenos_Aires'>Buenos Aires (GMT-3)</option>
              <option value='America/New_York'>New York (GMT-5)</option>
              <option value='America/Los_Angeles'>Los Angeles (GMT-8)</option>
              <option value='America/Mexico_City'>Mexico City (GMT-6)</option>
              <option value='America/Sao_Paulo'>São Paulo (GMT-3)</option>
              <option value='Europe/London'>London (GMT+0)</option>
              <option value='Europe/Paris'>Paris (GMT+1)</option>
              <option value='Europe/Madrid'>Madrid (GMT+1)</option>
              <option value='Asia/Tokyo'>Tokyo (GMT+9)</option>
              <option value='Asia/Shanghai'>Shanghai (GMT+8)</option>
              <option value='Australia/Sydney'>Sydney (GMT+11)</option>
              <option value='UTC'>UTC</option>
            </select>
          </div>
        </div>
      );
    case 'clock-widget':
      return (
        <div>
          <label className='block text-xs text-gray-600 mb-1'>Timezone</label>
          <select
            value={props.timezone || 'America/Argentina/Buenos_Aires'}
            onChange={(e) => updateProp(componentType, 'timezone', e.target.value)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
          >
            <option value='America/Argentina/Buenos_Aires'>Buenos Aires (GMT-3)</option>
            <option value='America/New_York'>New York (GMT-5)</option>
            <option value='America/Los_Angeles'>Los Angeles (GMT-8)</option>
            <option value='America/Mexico_City'>Mexico City (GMT-6)</option>
            <option value='America/Sao_Paulo'>São Paulo (GMT-3)</option>
            <option value='Europe/London'>London (GMT+0)</option>
            <option value='Europe/Paris'>Paris (GMT+1)</option>
            <option value='Europe/Madrid'>Madrid (GMT+1)</option>
            <option value='Asia/Tokyo'>Tokyo (GMT+9)</option>
            <option value='Asia/Shanghai'>Shanghai (GMT+8)</option>
            <option value='Australia/Sydney'>Sydney (GMT+11)</option>
            <option value='UTC'>UTC</option>
          </select>
        </div>
      );
    default:
      return <div className='text-xs text-gray-500 italic'>Default configuration</div>;
  }
}
