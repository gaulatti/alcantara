import { useEffect, useState } from 'react';
import type { Route } from './+types/control';
import { getTimezonesSortedByOffset, getTimezoneOptionLabel } from '../utils/timezones';

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

interface BroadcastSettings {
  id: number;
  timeOverrideEnabled: boolean;
  timeOverrideStartTime: string | null;
  timeOverrideStartedAt: string | null;
  updatedAt: string;
}

const hasConfigurableSceneAttributes = (componentType: string): boolean => {
  switch (componentType) {
    case 'ticker':
    case 'header':
    case 'qr-code':
    case 'broadcast-layout':
    case 'clock-widget':
    case 'reloj-clock':
      return true;
    default:
      return false;
  }
};

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

  const [showSceneModal, setShowSceneModal] = useState(false);
  const [newSceneName, setNewSceneName] = useState('');
  const [selectedLayoutId, setSelectedLayoutId] = useState<number | null>(null);
  const [sceneComponentProps, setSceneComponentProps] = useState<Record<string, any>>({});
  const [sceneErrors, setSceneErrors] = useState({ name: '', layout: '', props: '' });
  const [isCreatingScene, setIsCreatingScene] = useState(false);
  const [broadcastSettings, setBroadcastSettings] = useState<BroadcastSettings | null>(null);
  const [timeOverrideInput, setTimeOverrideInput] = useState('');
  const [broadcastTimeError, setBroadcastTimeError] = useState('');
  const [isSavingBroadcastTime, setIsSavingBroadcastTime] = useState(false);

  useEffect(() => {
    fetchScenes();
    fetchLayouts();
    fetchComponentTypes();
    fetchPrograms();
    fetchBroadcastSettings();
  }, []);

  useEffect(() => {
    fetchProgramState(activeProgramId);
  }, [activeProgramId]);

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

  const fetchBroadcastSettings = async () => {
    try {
      const res = await fetch('http://localhost:3000/program/broadcast-settings');
      const data = await res.json();
      setBroadcastSettings(data);
      setTimeOverrideInput(data?.timeOverrideStartTime || '');
    } catch (err) {
      console.error('Failed to fetch broadcast settings:', err);
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

    const nextProps = buildComponentPropsForScene(scene);
    setSceneEditorProps(nextProps);
    setSceneEditorChyronText(scene.chyronText ?? nextProps.chyron?.text ?? '');
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
      const nextMetadata: Record<string, any> = { ...sceneEditorProps };
      if (Object.prototype.hasOwnProperty.call(nextMetadata, 'chyron')) {
        const currentChyron = nextMetadata.chyron;
        nextMetadata.chyron = {
          ...(currentChyron && typeof currentChyron === 'object' ? currentChyron : {}),
          text: sceneEditorChyronText
        };
      }

      const response = await fetch(`http://localhost:3000/scenes/${selectedScene}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chyronText: sceneEditorChyronText,
          metadata: nextMetadata
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
        return { animate: true };
      case 'logo-widget':
        return { logoUrl: '', position: 'bottom-right' };
      case 'qr-code':
        return { qrCodeUrl: '', placeholder: true, content: 'https://modoradio.cl' };
      case 'broadcast-layout':
        return {
          headerTitle: '',
          hashtag: '#ModoSanremoMR',
          url: 'modoradio.cl',
          qrCodeContent: 'https://modoradio.cl',
          clockTimezone: 'America/Argentina/Buenos_Aires'
        };
      case 'reloj-clock':
        return { timezone: 'America/Argentina/Buenos_Aires' };
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

  const saveBroadcastTimeOverride = async () => {
    const normalized = timeOverrideInput.trim();
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(normalized)) {
      setBroadcastTimeError('Use HH:mm format (24h), e.g. 19:55');
      return;
    }

    setIsSavingBroadcastTime(true);
    setBroadcastTimeError('');
    try {
      const res = await fetch('http://localhost:3000/program/broadcast-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          startTime: normalized,
        }),
      });
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }

      const updated = await res.json();
      setBroadcastSettings(updated);
      setTimeOverrideInput(updated.timeOverrideStartTime || normalized);
    } catch (err) {
      console.error('Failed to save broadcast time override:', err);
      setBroadcastTimeError('Failed to apply time override. Please try again.');
    } finally {
      setIsSavingBroadcastTime(false);
    }
  };

  const clearBroadcastTimeOverride = async () => {
    setIsSavingBroadcastTime(true);
    setBroadcastTimeError('');
    try {
      const res = await fetch('http://localhost:3000/program/broadcast-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: false,
          startTime: null,
        }),
      });
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }

      const updated = await res.json();
      setBroadcastSettings(updated);
    } catch (err) {
      console.error('Failed to clear broadcast time override:', err);
      setBroadcastTimeError('Failed to disable time override. Please try again.');
    } finally {
      setIsSavingBroadcastTime(false);
    }
  };

  const editableSceneComponentEntries = Object.entries(sceneEditorProps).filter(
    ([componentType]) => componentType !== 'chyron' && hasConfigurableSceneAttributes(componentType)
  );

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
            <a href='/layouts' className='bg-purple-600 text-white px-4 py-2 rounded hover:bg-purple-700 text-sm font-semibold'>
              Manage Layouts
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

        <div className='bg-white rounded-lg shadow-lg p-4 mb-8'>
          <div className='flex flex-col md:flex-row md:items-end md:justify-between gap-4'>
            <div>
              <h2 className='text-lg font-bold text-gray-900'>Global Broadcast Time Override</h2>
              <p className='text-sm text-gray-600'>Applies to all programs and scenes for both clock widgets.</p>
              <p className='text-xs text-gray-500 mt-1'>
                {broadcastSettings?.timeOverrideEnabled
                  ? `Active from ${broadcastSettings.timeOverrideStartTime || '--:--'} (started ${new Date(
                      broadcastSettings.timeOverrideStartedAt || Date.now()
                    ).toLocaleString()})`
                  : 'Disabled (clocks use live timezone time)'}
              </p>
            </div>
            <div className='flex flex-col sm:flex-row items-start sm:items-end gap-2'>
              <div>
                <label htmlFor='timeOverride' className='block text-xs text-gray-600 mb-1'>
                  Start Time (HH:mm)
                </label>
                <input
                  id='timeOverride'
                  type='text'
                  value={timeOverrideInput}
                  onChange={(e) => {
                    setTimeOverrideInput(e.target.value);
                    if (broadcastTimeError) {
                      setBroadcastTimeError('');
                    }
                  }}
                  placeholder='19:55'
                  className='border border-gray-300 rounded px-3 py-2 text-sm w-28'
                />
              </div>
              <button
                onClick={saveBroadcastTimeOverride}
                disabled={isSavingBroadcastTime}
                className='bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 text-sm font-semibold disabled:bg-blue-400 disabled:cursor-not-allowed'
              >
                {isSavingBroadcastTime ? 'Saving...' : 'Apply'}
              </button>
              <button
                onClick={clearBroadcastTimeOverride}
                disabled={isSavingBroadcastTime || !broadcastSettings?.timeOverrideEnabled}
                className='bg-gray-700 text-white px-4 py-2 rounded hover:bg-gray-800 text-sm font-semibold disabled:bg-gray-400 disabled:cursor-not-allowed'
              >
                Disable
              </button>
            </div>
          </div>
          {broadcastTimeError && <p className='text-red-600 text-sm mt-2'>{broadcastTimeError}</p>}
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
            <div className='space-y-2'>
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

          {/* Scene Attributes Panel */}
          <div className='bg-white rounded-lg shadow-lg p-6'>
            <h2 className='text-2xl font-bold mb-4'>Edit Scene Attributes</h2>
            {!selectedScene ? (
              <p className='text-sm text-gray-500 mt-2'>Click on a scene above to edit all component attributes for that scene.</p>
            ) : (
              <div className='space-y-4'>
                <p className='text-sm text-blue-600'>Editing scene: {scenes.find((s) => s.id === selectedScene)?.name}</p>
                <div>
                  <label className='block text-xs text-gray-600 mb-1'>Chyron Text</label>
                  <input
                    type='text'
                    value={sceneEditorChyronText}
                    onChange={(e) => setSceneEditorChyronText(e.target.value)}
                    placeholder='Enter chyron text'
                    className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-blue-500'
                  />
                </div>
                <div className='space-y-4 border rounded p-4'>
                  {editableSceneComponentEntries.length === 0 && (
                    <p className='text-sm text-gray-500'>No configurable component attributes for this scene.</p>
                  )}
                  {editableSceneComponentEntries.map(([componentType, props]) => {
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
        </div>

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
                <div className='flex items-center justify-between mb-2'>
                  <label className='block text-sm font-medium text-gray-700'>Select Layout</label>
                  <a href='/layouts' className='text-sm text-purple-600 hover:text-purple-800'>
                    Manage layouts
                  </a>
                </div>
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
  const timezoneOptions = getTimezonesSortedByOffset();

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
          <p className='text-xs text-gray-500 italic'>No configurable attributes. This component renders its SVG indicator.</p>
        </div>
      );
    case 'logo-widget':
      return (
        <div>
          <p className='text-xs text-gray-500 italic'>No configurable attributes. This component renders its SVG logo.</p>
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
              {timezoneOptions.map((timezone) => (
                <option key={timezone} value={timezone}>
                  {getTimezoneOptionLabel(timezone)}
                </option>
              ))}
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
            {timezoneOptions.map((timezone) => (
              <option key={timezone} value={timezone}>
                {getTimezoneOptionLabel(timezone)}
              </option>
            ))}
          </select>
        </div>
      );
    case 'reloj-clock':
      return (
        <div>
          <label className='block text-xs text-gray-600 mb-1'>Timezone</label>
          <select
            value={props.timezone || 'America/Argentina/Buenos_Aires'}
            onChange={(e) => updateProp(componentType, 'timezone', e.target.value)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
          >
            {timezoneOptions.map((timezone) => (
              <option key={timezone} value={timezone}>
                {getTimezoneOptionLabel(timezone)}
              </option>
            ))}
          </select>
        </div>
      );
    default:
      return <div className='text-xs text-gray-500 italic'>Default configuration</div>;
  }
}
