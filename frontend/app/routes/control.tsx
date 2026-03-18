import { useEffect, useState } from 'react';
import { GripVertical } from 'lucide-react';
import type { Route } from './+types/control';
import { apiUrl } from '../utils/apiBaseUrl';
import { getTimezonesSortedByOffset, getTimezoneOptionLabel } from '../utils/timezones';
import { SCENE_TRANSITIONS, getSceneTransitionPreset } from '../utils/sceneTransitions';
import {
  countSequenceLeafItems,
  createToniChyronSequence,
  createToniChyronSequenceItem,
  getToniChyronContentMode,
  getToniChyronSequenceSelectedItemId,
  normalizeToniChyronSequence,
  type ToniChyronSequence,
  type ToniChyronSequenceItem
} from '../utils/toniChyronSequence';

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

interface FifthBellSettings {
  id: number;
  showArticles: boolean;
  showWeather: boolean;
  showEarthquakes: boolean;
  showMarkets: boolean;
  showMarquee: boolean;
  showCallsignTake: boolean;
  weatherCities: string[];
  availableWeatherCities: string[];
  updatedAt: string;
}

type ComponentPropsMap = Record<string, any>;

const hasConfigurableSceneAttributes = (componentType: string): boolean => {
  switch (componentType) {
    case 'ticker':
    case 'header':
    case 'qr-code':
    case 'broadcast-layout':
    case 'clock-widget':
    case 'reloj-clock':
    case 'reloj-loop-clock':
    case 'toni-chyron':
    case 'earone':
      return true;
    default:
      return false;
  }
};

function getStoredSceneChyronText(metadata: ComponentPropsMap, fallbackText: string): string {
  const toniProps = metadata['toni-chyron'];
  if (toniProps && typeof toniProps === 'object' && typeof toniProps.text === 'string') {
    return toniProps.text;
  }

  if (Object.prototype.hasOwnProperty.call(metadata, 'chyron')) {
    const chyronProps = metadata.chyron;
    if (chyronProps && typeof chyronProps === 'object' && typeof chyronProps.text === 'string') {
      return chyronProps.text;
    }
  }

  return fallbackText;
}

function getSceneSummaryText(scene: Scene): string {
  try {
    const metadata = scene.metadata ? JSON.parse(scene.metadata) : {};
    const toniProps = metadata?.['toni-chyron'];

    if (toniProps && typeof toniProps === 'object') {
      const sequence = normalizeToniChyronSequence(toniProps.sequence);
      const contentMode = getToniChyronContentMode(toniProps.contentMode, sequence);

      if (contentMode === 'sequence' && sequence) {
        return `Sequence (${countSequenceLeafItems(sequence)} items)`;
      }

      if (typeof toniProps.text === 'string' && toniProps.text.trim()) {
        return toniProps.text;
      }
    }
  } catch (err) {
    console.error('Failed to parse scene metadata for summary:', err);
  }

  return scene.chyronText || '(none)';
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

  const [showSceneModal, setShowSceneModal] = useState(false);
  const [newSceneName, setNewSceneName] = useState('');
  const [selectedLayoutId, setSelectedLayoutId] = useState<number | null>(null);
  const [sceneComponentProps, setSceneComponentProps] = useState<Record<string, any>>({});
  const [sceneErrors, setSceneErrors] = useState({ name: '', layout: '', props: '' });
  const [isCreatingScene, setIsCreatingScene] = useState(false);
  const [broadcastSettings, setBroadcastSettings] = useState<BroadcastSettings | null>(null);
  const [fifthBellSettings, setFifthBellSettings] = useState<FifthBellSettings | null>(null);
  const [timeOverrideInput, setTimeOverrideInput] = useState('');
  const [broadcastTimeError, setBroadcastTimeError] = useState('');
  const [isSavingBroadcastTime, setIsSavingBroadcastTime] = useState(false);
  const [isSavingFifthBellSettings, setIsSavingFifthBellSettings] = useState(false);
  const [fifthBellSettingsError, setFifthBellSettingsError] = useState('');
  const [selectedTransitionId, setSelectedTransitionId] = useState('crescendo-prism');
  const selectedTransition = getSceneTransitionPreset(selectedTransitionId);

  useEffect(() => {
    fetchScenes();
    fetchLayouts();
    fetchComponentTypes();
    fetchPrograms();
    fetchBroadcastSettings();
    fetchFifthBellSettings();
  }, []);

  useEffect(() => {
    fetchProgramState(activeProgramId);
  }, [activeProgramId]);

  useEffect(() => {
    if (activeProgramId === 'fifthbell') {
      fetchFifthBellSettings();
    }
  }, [activeProgramId]);

  const fetchScenes = async () => {
    try {
      const res = await fetch(apiUrl('/scenes'));
      const data = await res.json();
      setScenes(data);
    } catch (err) {
      console.error('Failed to fetch scenes:', err);
    }
  };

  const fetchLayouts = async () => {
    try {
      const res = await fetch(apiUrl('/layouts'));
      const data = await res.json();
      setLayouts(data);
    } catch (err) {
      console.error('Failed to fetch layouts:', err);
    }
  };

  const fetchComponentTypes = async () => {
    try {
      const res = await fetch(apiUrl('/layouts/component-types'));
      const data = await res.json();
      setComponentTypes(data);
    } catch (err) {
      console.error('Failed to fetch component types:', err);
    }
  };

  const fetchPrograms = async () => {
    try {
      const res = await fetch(apiUrl('/program'));
      const data = await res.json();
      setPrograms(data);
    } catch (err) {
      console.error('Failed to fetch programs:', err);
    }
  };

  const fetchBroadcastSettings = async () => {
    try {
      const res = await fetch(apiUrl('/program/broadcast-settings'));
      const data = await res.json();
      setBroadcastSettings(data);
      setTimeOverrideInput(data?.timeOverrideStartTime || '');
    } catch (err) {
      console.error('Failed to fetch broadcast settings:', err);
    }
  };

  const fetchFifthBellSettings = async () => {
    try {
      const res = await fetch(apiUrl('/program/fifthbell-settings'));
      const data = await res.json();
      setFifthBellSettings(data);
      setFifthBellSettingsError('');
    } catch (err) {
      console.error('Failed to fetch FifthBell settings:', err);
      setFifthBellSettingsError('Failed to load FifthBell settings.');
    }
  };

  const fetchProgramState = async (targetProgramId: string) => {
    try {
      const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/state`));
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
      await fetch(apiUrl('/program'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ programId: nextProgramId })
      });
      setProgramId(nextProgramId);
      setProgramIdInput(nextProgramId);
    } catch (err) {
      console.error('Failed to create/select program:', err);
    }
  };

  const isSceneAssigned = (sceneId: number) => !!programState?.scenes.some((programScene) => programScene.sceneId === sceneId);

  const assignSceneToProgram = async (sceneId: number) => {
    try {
      await fetch(apiUrl(`/program/${encodeURIComponent(activeProgramId)}/scenes`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneId })
      });
      await fetchProgramState(activeProgramId);
    } catch (err) {
      console.error('Failed to assign scene to program:', err);
    }
  };

  const removeSceneFromProgram = async (sceneId: number) => {
    try {
      await fetch(apiUrl(`/program/${encodeURIComponent(activeProgramId)}/scenes/${sceneId}`), { method: 'DELETE' });
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
      await fetch(apiUrl(`/program/${encodeURIComponent(activeProgramId)}/activate`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneId, transitionId: selectedTransitionId })
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

  const replaceSceneEditorComponentProps = (componentType: string, nextProps: any) => {
    setSceneEditorProps((prev) => ({
      ...prev,
      [componentType]: nextProps
    }));
  };

  const persistSceneAttributes = async (nextSceneProps: ComponentPropsMap) => {
    if (!selectedScene) return;

    setIsSavingSceneAttributes(true);
    try {
      const nextMetadata: ComponentPropsMap = { ...nextSceneProps };
      const resolvedChyronText = getStoredSceneChyronText(nextMetadata, sceneEditorChyronText);
      if (Object.prototype.hasOwnProperty.call(nextMetadata, 'chyron')) {
        const currentChyron = nextMetadata.chyron;
        nextMetadata.chyron = {
          ...(currentChyron && typeof currentChyron === 'object' ? currentChyron : {}),
          text: resolvedChyronText
        };
      }

      const response = await fetch(apiUrl(`/scenes/${selectedScene}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chyronText: resolvedChyronText,
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

  const saveSceneAttributes = async () => {
    await persistSceneAttributes(sceneEditorProps);
  };

  const commitSceneEditorComponentProps = async (componentType: string, nextProps: any) => {
    const nextSceneProps = {
      ...sceneEditorProps,
      [componentType]: nextProps
    };
    setSceneEditorProps(nextSceneProps);
    await persistSceneAttributes(nextSceneProps);
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
        setSceneComponentProps(buildComponentPropsForScene(scene));
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
      case 'reloj-loop-clock':
        return { timezone: 'Europe/Madrid' };
      case 'toni-chyron':
        return { text: '', useMarquee: false };
      case 'toni-clock':
        return {};
      case 'toni-logo':
        return {};
      case 'earone':
        return { label: 'EARONE', rank: '', spins: '' };
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

  const replaceSceneComponentProps = (componentType: string, nextProps: any) => {
    setSceneComponentProps((prev) => ({
      ...prev,
      [componentType]: nextProps
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
        chyronText: getStoredSceneChyronText(sceneComponentProps, ''),
        metadata: sceneComponentProps // Send as object, backend will stringify
      };

      const url = editingScene ? apiUrl(`/scenes/${editingScene.id}`) : apiUrl('/scenes');
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
      await fetch(apiUrl(`/scenes/${id}`), {
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
      const res = await fetch(apiUrl('/program/broadcast-settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          startTime: normalized
        })
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
      const res = await fetch(apiUrl('/program/broadcast-settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: false,
          startTime: null
        })
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

  const updateFifthBellSetting = (key: keyof FifthBellSettings, value: any) => {
    setFifthBellSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const toggleFifthBellWeatherCity = (city: string, checked: boolean) => {
    setFifthBellSettings((prev) => {
      if (!prev) {
        return prev;
      }

      const next = new Set(prev.weatherCities || []);
      if (checked) {
        next.add(city);
      } else {
        next.delete(city);
      }

      return {
        ...prev,
        weatherCities: [...next]
      };
    });
  };

  const saveFifthBellSettings = async () => {
    if (!fifthBellSettings) {
      return;
    }

    setIsSavingFifthBellSettings(true);
    setFifthBellSettingsError('');
    try {
      const res = await fetch(apiUrl('/program/fifthbell-settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          showArticles: fifthBellSettings.showArticles,
          showWeather: fifthBellSettings.showWeather,
          showEarthquakes: fifthBellSettings.showEarthquakes,
          showMarkets: fifthBellSettings.showMarkets,
          showMarquee: fifthBellSettings.showMarquee,
          showCallsignTake: fifthBellSettings.showCallsignTake,
          weatherCities: fifthBellSettings.weatherCities
        })
      });
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }

      const updated = await res.json();
      setFifthBellSettings(updated);
    } catch (err) {
      console.error('Failed to save FifthBell settings:', err);
      setFifthBellSettingsError('Failed to save FifthBell settings. Please try again.');
    } finally {
      setIsSavingFifthBellSettings(false);
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
            <button onClick={createOrSelectProgram} className='bg-emerald-600 text-white px-4 py-2 rounded hover:bg-emerald-700 text-sm font-semibold'>
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
          <div className='text-sm text-gray-600 mb-2'>
            Current program: <span className='font-semibold text-gray-900'>{activeProgramId}</span>
          </div>
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

        {activeProgramId === 'fifthbell' && (
          <div className='bg-white rounded-lg shadow-lg p-4 mb-8'>
            <div className='flex flex-col md:flex-row md:items-start md:justify-between gap-4'>
              <div>
                <h2 className='text-lg font-bold text-gray-900'>FifthBell Program Controls</h2>
                <p className='text-sm text-gray-600'>Manage which segments are shown, weather cities, marquee visibility, and callsign take behavior.</p>
                {fifthBellSettings?.updatedAt && (
                  <p className='text-xs text-gray-500 mt-1'>Updated: {new Date(fifthBellSettings.updatedAt).toLocaleString()}</p>
                )}
              </div>
              <button
                onClick={saveFifthBellSettings}
                disabled={isSavingFifthBellSettings || !fifthBellSettings}
                className='bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 text-sm font-semibold disabled:bg-blue-400 disabled:cursor-not-allowed'
              >
                {isSavingFifthBellSettings ? 'Saving...' : 'Save FifthBell Controls'}
              </button>
            </div>

            {fifthBellSettings ? (
              <div className='mt-4 space-y-4'>
                <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3'>
                  <label className='flex items-center gap-2 text-sm text-gray-700'>
                    <input
                      type='checkbox'
                      checked={Boolean(fifthBellSettings.showArticles)}
                      onChange={(e) => updateFifthBellSetting('showArticles', e.target.checked)}
                      className='h-4 w-4'
                    />
                    Show Articles
                  </label>
                  <label className='flex items-center gap-2 text-sm text-gray-700'>
                    <input
                      type='checkbox'
                      checked={Boolean(fifthBellSettings.showWeather)}
                      onChange={(e) => updateFifthBellSetting('showWeather', e.target.checked)}
                      className='h-4 w-4'
                    />
                    Show Weather
                  </label>
                  <label className='flex items-center gap-2 text-sm text-gray-700'>
                    <input
                      type='checkbox'
                      checked={Boolean(fifthBellSettings.showEarthquakes)}
                      onChange={(e) => updateFifthBellSetting('showEarthquakes', e.target.checked)}
                      className='h-4 w-4'
                    />
                    Show Earthquakes
                  </label>
                  <label className='flex items-center gap-2 text-sm text-gray-700'>
                    <input
                      type='checkbox'
                      checked={Boolean(fifthBellSettings.showMarkets)}
                      onChange={(e) => updateFifthBellSetting('showMarkets', e.target.checked)}
                      className='h-4 w-4'
                    />
                    Show Markets
                  </label>
                  <label className='flex items-center gap-2 text-sm text-gray-700'>
                    <input
                      type='checkbox'
                      checked={Boolean(fifthBellSettings.showMarquee)}
                      onChange={(e) => updateFifthBellSetting('showMarquee', e.target.checked)}
                      className='h-4 w-4'
                    />
                    Show Bottom Marquee
                  </label>
                  <label className='flex items-center gap-2 text-sm text-gray-700'>
                    <input
                      type='checkbox'
                      checked={Boolean(fifthBellSettings.showCallsignTake)}
                      onChange={(e) => updateFifthBellSetting('showCallsignTake', e.target.checked)}
                      className='h-4 w-4'
                    />
                    Enable Callsign Take
                  </label>
                </div>

                <div>
                  <h3 className='text-sm font-semibold text-gray-800 mb-2'>Weather Cities</h3>
                  <p className='text-xs text-gray-500 mb-2'>Select which cities appear in the weather segment.</p>
                  <div className='grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 max-h-64 overflow-auto border rounded p-3 bg-gray-50'>
                    {(fifthBellSettings.availableWeatherCities || []).map((city) => (
                      <label key={city} className='flex items-center gap-2 text-sm text-gray-700'>
                        <input
                          type='checkbox'
                          checked={fifthBellSettings.weatherCities?.includes(city) ?? false}
                          onChange={(e) => toggleFifthBellWeatherCity(city, e.target.checked)}
                          className='h-4 w-4'
                        />
                        {city}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <p className='text-sm text-gray-500 mt-3'>Loading FifthBell controls...</p>
            )}

            {fifthBellSettingsError && <p className='text-red-600 text-sm mt-3'>{fifthBellSettingsError}</p>}
          </div>
        )}

        <div className='bg-white rounded-lg shadow-lg p-4 mb-8'>
          <div className='flex flex-col md:flex-row md:items-end md:justify-between gap-4'>
            <div>
              <h2 className='text-lg font-bold text-gray-900'>Scene Take Transition</h2>
              <p className='text-sm text-gray-600'>
                Transitions are code-defined presets. The program can play them, but only control chooses which one to use on the next take.
              </p>
              <p className='text-xs text-gray-500 mt-1'>
                Active preset: <span className='font-semibold text-gray-700'>{selectedTransition.name}</span> ({selectedTransition.durationMs}ms total, cut at{' '}
                {selectedTransition.cutPointMs}ms)
              </p>
            </div>
            <div className='w-full md:w-85'>
              <label htmlFor='takeTransition' className='block text-xs text-gray-600 mb-1'>
                Transition Preset
              </label>
              <select
                id='takeTransition'
                value={selectedTransitionId}
                onChange={(e) => setSelectedTransitionId(e.target.value)}
                className='w-full border border-gray-300 rounded px-3 py-2 text-sm'
              >
                {SCENE_TRANSITIONS.map((transition) => (
                  <option key={transition.id} value={transition.id}>
                    {transition.name}
                  </option>
                ))}
              </select>
              <p className='text-xs text-gray-500 mt-2'>{selectedTransition.description}</p>
            </div>
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
                          <div className='text-sm text-gray-500 mt-1'>Text: {getSceneSummaryText(scene)}</div>
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
                {!sceneEditorProps['toni-chyron'] && (
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
                )}
                <div className='space-y-4 border rounded p-4'>
                  {editableSceneComponentEntries.length === 0 && <p className='text-sm text-gray-500'>No configurable component attributes for this scene.</p>}
                  {editableSceneComponentEntries.map(([componentType, props]) => {
                    const compInfo = componentTypes.find((ct) => ct.type === componentType);
                    return (
                      <div key={componentType} className='border-b pb-4 last:border-b-0'>
                        <h4 className='font-semibold text-md mb-2 text-gray-800'>{compInfo?.name || componentType}</h4>
                        <ComponentPropsFields
                          componentType={componentType}
                          props={props}
                          updateProp={updateSceneEditorProp}
                          replaceProps={replaceSceneEditorComponentProps}
                          commitProps={commitSceneEditorComponentProps}
                        />
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
                          <ComponentPropsFields
                            componentType={componentType}
                            props={props}
                            updateProp={updateComponentProp}
                            replaceProps={replaceSceneComponentProps}
                          />
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
  updateProp,
  replaceProps,
  commitProps
}: {
  componentType: string;
  props: any;
  updateProp: (componentType: string, propName: string, value: any) => void;
  replaceProps: (componentType: string, nextProps: any) => void;
  commitProps?: (componentType: string, nextProps: any) => Promise<void> | void;
}) {
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
    case 'reloj-loop-clock':
      return (
        <div className='space-y-2'>
          <div>
            <label className='block text-xs text-gray-600 mb-1'>Starting Timezone</label>
            <select
              value={props.timezone || 'Europe/Madrid'}
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
          <p className='text-xs text-gray-500'>Loop sequence: Madrid, Sanremo, New York, Santiago. Each timezone stays active for 30 seconds.</p>
        </div>
      );
    case 'toni-chyron':
      return (
        <ToniChyronEditorFields componentType={componentType} props={props} updateProp={updateProp} replaceProps={replaceProps} commitProps={commitProps} />
      );
    case 'toni-clock':
      return <p className='text-xs text-gray-500 italic'>Cities cycle automatically: Sanremo, New York, Madrid, Montevideo, Santiago.</p>;
    case 'toni-logo':
      return <p className='text-xs text-gray-500 italic'>Logo cycles automatically between station images.</p>;
    case 'earone':
      return (
        <div className='space-y-2'>
          <div>
            <label className='block text-xs text-gray-600 mb-1'>Label</label>
            <input
              type='text'
              value={props.label || 'EARONE'}
              onChange={(e) => updateProp(componentType, 'label', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              placeholder='EARONE'
            />
          </div>
          <div className='grid grid-cols-2 gap-3'>
            <div>
              <label className='block text-xs text-gray-600 mb-1'>Rank</label>
              <input
                type='text'
                value={props.rank || ''}
                onChange={(e) => updateProp(componentType, 'rank', e.target.value)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                placeholder='Uses active sequence item'
              />
            </div>
            <div>
              <label className='block text-xs text-gray-600 mb-1'>Spins Today</label>
              <input
                type='text'
                value={props.spins || ''}
                onChange={(e) => updateProp(componentType, 'spins', e.target.value)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                placeholder='Uses active sequence item'
              />
            </div>
          </div>
          <p className='text-xs text-gray-500'>Leave rank/spins blank to follow the active Toni chyron sequence item.</p>
        </div>
      );
    default:
      return <div className='text-xs text-gray-500 italic'>Default configuration</div>;
  }
}

function ToniChyronEditorFields({
  componentType,
  props,
  updateProp,
  replaceProps,
  commitProps
}: {
  componentType: string;
  props: any;
  updateProp: (componentType: string, propName: string, value: any) => void;
  replaceProps: (componentType: string, nextProps: any) => void;
  commitProps?: (componentType: string, nextProps: any) => Promise<void> | void;
}) {
  const normalizedSequence = normalizeToniChyronSequence(props.sequence);
  const contentMode = getToniChyronContentMode(props.contentMode, normalizedSequence);

  const applyProps = (nextProps: any) => {
    replaceProps(componentType, nextProps);
  };

  const activateSequence = async (nextSequence: ToniChyronSequence) => {
    const nextProps = {
      ...props,
      contentMode: 'sequence',
      sequence: nextSequence
    };
    replaceProps(componentType, nextProps);
    if (commitProps) {
      await commitProps(componentType, nextProps);
    }
  };

  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap gap-2'>
        <button
          type='button'
          onClick={() =>
            applyProps({
              ...props,
              contentMode: 'text'
            })
          }
          className={`px-3 py-1.5 rounded text-sm font-medium border ${
            contentMode === 'text' ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
          }`}
        >
          Direct Text
        </button>
        <button
          type='button'
          onClick={() =>
            applyProps({
              ...props,
              contentMode: 'sequence',
              sequence: normalizedSequence ?? createToniChyronSequence('manual')
            })
          }
          className={`px-3 py-1.5 rounded text-sm font-medium border ${
            contentMode === 'sequence' ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
          }`}
        >
          Sequence
        </button>
      </div>

      {contentMode === 'sequence' ? (
        <div className='space-y-3'>
          <p className='text-xs text-gray-500'>Sequence mode lets you preload multiple chyron values and take them live with one tap.</p>
          <ToniChyronSequenceEditor
            sequence={normalizedSequence ?? createToniChyronSequence('manual')}
            onChange={(nextSequence) =>
              applyProps({
                ...props,
                contentMode: 'sequence',
                sequence: nextSequence
              })
            }
            onTakeSelection={activateSequence}
          />
          <details className='rounded border border-dashed border-gray-300 px-3 py-2'>
            <summary className='cursor-pointer text-xs font-medium text-gray-600'>Fallback direct text</summary>
            <div className='space-y-2 pt-3'>
              <div>
                <label className='block text-xs text-gray-600 mb-1'>Fallback Text</label>
                <input
                  type='text'
                  value={props.text || ''}
                  onChange={(e) => updateProp(componentType, 'text', e.target.value)}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                  placeholder='Used only if the sequence is empty'
                />
              </div>
              <label className='flex items-center gap-2 text-sm text-gray-700'>
                <input
                  type='checkbox'
                  checked={Boolean(props.useMarquee)}
                  onChange={(e) => updateProp(componentType, 'useMarquee', e.target.checked)}
                  className='h-4 w-4'
                />
                Fallback marquee
              </label>
            </div>
          </details>
        </div>
      ) : (
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
          <label className='flex items-center gap-2 text-sm text-gray-700'>
            <input
              type='checkbox'
              checked={Boolean(props.useMarquee)}
              onChange={(e) => updateProp(componentType, 'useMarquee', e.target.checked)}
              className='h-4 w-4'
            />
            Force marquee scrolling
          </label>
        </div>
      )}
    </div>
  );
}

function ToniChyronSequenceEditor({
  sequence,
  onChange,
  onTakeSelection,
  depth = 0
}: {
  sequence: ToniChyronSequence;
  onChange: (nextSequence: ToniChyronSequence) => void;
  onTakeSelection?: (nextSequence: ToniChyronSequence) => Promise<void> | void;
  depth?: number;
}) {
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const isNested = depth > 0;
  const effectiveActiveItemId = getToniChyronSequenceSelectedItemId(sequence, nowMs);

  useEffect(() => {
    if (sequence.mode !== 'autoplay') {
      return;
    }

    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 250);

    return () => clearInterval(timer);
  }, [sequence.mode, sequence.startedAt, sequence.intervalMs, sequence.loop, sequence.items.length]);

  const applySequence = (nextSequence: ToniChyronSequence) => {
    onChange({
      ...nextSequence,
      activeItemId:
        nextSequence.activeItemId && nextSequence.items.some((item) => item.id === nextSequence.activeItemId)
          ? nextSequence.activeItemId
          : (nextSequence.items[0]?.id ?? null)
    });
  };

  const updateItem = (index: number, nextItem: ToniChyronSequenceItem) => {
    const nextItems = sequence.items.map((item, itemIndex) => (itemIndex === index ? nextItem : item));
    applySequence({
      ...sequence,
      items: nextItems
    });
  };

  const addItem = (kind: ToniChyronSequenceItem['kind']) => {
    const nextItem = createToniChyronSequenceItem(kind);
    applySequence({
      ...sequence,
      items: [...sequence.items, nextItem],
      activeItemId: sequence.activeItemId ?? nextItem.id,
      startedAt: Date.now()
    });
  };

  const removeItem = (index: number) => {
    const removedItem = sequence.items[index];
    if (!removedItem) {
      return;
    }

    const nextItems = sequence.items.filter((_, itemIndex) => itemIndex !== index);
    applySequence({
      ...sequence,
      items: nextItems,
      activeItemId: sequence.activeItemId === removedItem.id ? (nextItems[0]?.id ?? null) : sequence.activeItemId,
      startedAt: Date.now()
    });
  };

  const activateItem = async (itemId: string) => {
    const nextSequence = {
      ...sequence,
      activeItemId: itemId,
      startedAt: Date.now()
    };
    applySequence(nextSequence);
    if (onTakeSelection) {
      await onTakeSelection(nextSequence);
    }
  };

  const reorderItems = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= sequence.items.length || toIndex >= sequence.items.length) {
      return;
    }

    const nextItems = [...sequence.items];
    const [moved] = nextItems.splice(fromIndex, 1);
    nextItems.splice(toIndex, 0, moved);

    applySequence({
      ...sequence,
      items: nextItems
    });
  };

  return (
    <div className={`space-y-3 rounded border ${isNested ? 'border-slate-200 bg-slate-50/70' : 'border-slate-300 bg-slate-50'} p-3`}>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='text-xs font-semibold uppercase tracking-wide text-slate-600'>{isNested ? 'Nested Sequence' : 'Sequence'}</span>
        <button
          type='button'
          onClick={() =>
            applySequence({
              ...sequence,
              mode: 'manual',
              activeItemId: sequence.mode === 'autoplay' ? (effectiveActiveItemId ?? sequence.activeItemId) : sequence.activeItemId,
              startedAt: Date.now()
            })
          }
          className={`px-2.5 py-1 rounded text-xs font-medium border ${
            sequence.mode === 'manual' ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
          }`}
        >
          Manual
        </button>
        <button
          type='button'
          onClick={() =>
            applySequence({
              ...sequence,
              mode: 'autoplay',
              startedAt: Date.now()
            })
          }
          className={`px-2.5 py-1 rounded text-xs font-medium border ${
            sequence.mode === 'autoplay' ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
          }`}
        >
          Autoplay
        </button>
        {sequence.mode === 'autoplay' && (
          <>
            <label className='text-xs text-slate-600'>Interval (ms)</label>
            <input
              type='number'
              min={500}
              step={500}
              value={sequence.intervalMs ?? 4000}
              onChange={(e) =>
                applySequence({
                  ...sequence,
                  intervalMs: Math.max(500, Number(e.target.value) || 4000),
                  startedAt: Date.now()
                })
              }
              className='w-28 px-2 py-1 text-xs border rounded focus:ring-2 focus:ring-green-500'
            />
            <label className='flex items-center gap-1 text-xs text-slate-600'>
              <input
                type='checkbox'
                checked={sequence.loop !== false}
                onChange={(e) =>
                  applySequence({
                    ...sequence,
                    loop: e.target.checked
                  })
                }
                className='h-3.5 w-3.5'
              />
              Loop
            </label>
          </>
        )}
      </div>

      {sequence.items.length === 0 && <p className='text-xs text-slate-500'>This sequence is empty. Add items below.</p>}

      <div className='space-y-3'>
        {sequence.items.map((item, index) => {
          const isActive = item.id === effectiveActiveItemId;

          return (
            <div
              key={item.id}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (draggingIndex !== null) {
                  reorderItems(draggingIndex, index);
                }
                setDraggingIndex(null);
              }}
              className={`rounded border p-3 ${isActive ? 'border-green-300 bg-green-50' : 'border-slate-200 bg-white'}`}
            >
              <div className='flex flex-wrap items-center gap-2'>
                <span
                  draggable
                  onDragStart={() => setDraggingIndex(index)}
                  onDragEnd={() => setDraggingIndex(null)}
                  className='cursor-grab select-none rounded border border-dashed border-slate-300 p-2 text-slate-500'
                  title='Drag to reorder'
                  aria-label='Drag to reorder'
                >
                  <GripVertical size={14} strokeWidth={2} />
                </span>
                {item.kind === 'sequence' ? (
                  <input
                    type='text'
                    value={item.label}
                    onChange={(e) => updateItem(index, { ...item, label: e.target.value })}
                    className='min-w-0 flex-1 px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                    placeholder='Sequence name'
                  />
                ) : (
                  <div className='min-w-0 flex-1 text-xs font-medium uppercase tracking-wide text-slate-500'>Preset Item</div>
                )}
                <select
                  value={item.kind}
                  onChange={(e) => {
                    const nextKind = e.target.value as ToniChyronSequenceItem['kind'];
                    if (nextKind === item.kind) {
                      return;
                    }

                    if (nextKind === 'sequence') {
                      updateItem(index, {
                        id: item.id,
                        label: item.kind === 'sequence' ? item.label : item.text.trim() || 'Nested Sequence',
                        kind: 'sequence',
                        sequence: createToniChyronSequence('manual')
                      });
                      return;
                    }

                    updateItem(index, {
                      id: item.id,
                      kind: 'preset',
                      text: item.kind === 'sequence' ? item.label : item.text,
                      useMarquee: false
                    });
                  }}
                  className='px-2 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                >
                  <option value='preset'>Preset</option>
                  <option value='sequence'>Nested</option>
                </select>
                <button
                  type='button'
                  onClick={() => {
                    void activateItem(item.id);
                  }}
                  className='px-3 py-2 text-xs font-semibold rounded bg-green-600 text-white hover:bg-green-700'
                >
                  Take
                </button>
                <button
                  type='button'
                  onClick={() => removeItem(index)}
                  className='px-3 py-2 text-xs font-semibold rounded border border-red-200 text-red-600 hover:bg-red-50'
                >
                  Remove
                </button>
              </div>

              {item.kind === 'preset' ? (
                <div className='mt-3 space-y-2'>
                  <div>
                    <label className='block text-xs text-gray-600 mb-1'>Text</label>
                    <input
                      type='text'
                      value={item.text}
                      onChange={(e) =>
                        updateItem(index, {
                          ...item,
                          text: e.target.value
                        })
                      }
                      className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                      placeholder='Chyron message'
                    />
                  </div>
                  <div className='grid grid-cols-2 gap-3'>
                    <div className='col-span-2'>
                      <label className='block text-xs text-gray-600 mb-1'>EarOne Song ID</label>
                      <input
                        type='text'
                        value={item.earoneSongId || ''}
                        onChange={(e) =>
                          updateItem(index, {
                            ...item,
                            earoneSongId: e.target.value
                          })
                        }
                        className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                        placeholder='Matches against song.earoneSongId'
                      />
                    </div>
                    <div>
                      <label className='block text-xs text-gray-600 mb-1'>Earone Rank</label>
                      <input
                        type='text'
                        value={item.earoneRank || ''}
                        onChange={(e) =>
                          updateItem(index, {
                            ...item,
                            earoneRank: e.target.value
                          })
                        }
                        className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                        placeholder='e.g. 4'
                      />
                    </div>
                    <div>
                      <label className='block text-xs text-gray-600 mb-1'>Earone Spins</label>
                      <input
                        type='text'
                        value={item.earoneSpins || ''}
                        onChange={(e) =>
                          updateItem(index, {
                            ...item,
                            earoneSpins: e.target.value
                          })
                        }
                        className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                        placeholder='e.g. 124'
                      />
                    </div>
                  </div>
                  <label className='flex items-center gap-2 text-sm text-gray-700'>
                    <input
                      type='checkbox'
                      checked={Boolean(item.useMarquee)}
                      onChange={(e) =>
                        updateItem(index, {
                          ...item,
                          useMarquee: e.target.checked
                        })
                      }
                      className='h-4 w-4'
                    />
                    Force marquee scrolling
                  </label>
                </div>
              ) : (
                <div className='mt-3'>
                  <ToniChyronSequenceEditor
                    sequence={item.sequence}
                    depth={depth + 1}
                    onChange={(nextNestedSequence) =>
                      updateItem(index, {
                        ...item,
                        sequence: nextNestedSequence
                      })
                    }
                    onTakeSelection={async (nextNestedSequence) => {
                      const nextSequence = {
                        ...sequence,
                        items: sequence.items.map((sequenceItem, sequenceIndex) =>
                          sequenceIndex === index
                            ? {
                                ...item,
                                sequence: nextNestedSequence
                              }
                            : sequenceItem
                        )
                      };
                      applySequence(nextSequence);
                      if (onTakeSelection) {
                        await onTakeSelection(nextSequence);
                      }
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className='flex flex-wrap gap-2'>
        <button
          type='button'
          onClick={() => addItem('preset')}
          className='px-3 py-2 text-xs font-semibold rounded border border-slate-300 text-slate-700 hover:bg-slate-100'
        >
          + Preset
        </button>
        <button
          type='button'
          onClick={() => addItem('sequence')}
          className='px-3 py-2 text-xs font-semibold rounded border border-slate-300 text-slate-700 hover:bg-slate-100'
        >
          + Nested Sequence
        </button>
      </div>
    </div>
  );
}
