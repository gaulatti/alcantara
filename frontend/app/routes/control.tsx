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
import {
  createModoItalianoSongSequence,
  createModoItalianoSongSequenceItem,
  createModoItalianoTextSequence,
  createModoItalianoTextSequenceItem,
  getModoItalianoSongContentMode,
  getModoItalianoSongSequenceSelectedItemId,
  getModoItalianoTextContentMode,
  getModoItalianoTextSequenceSelectedItemId,
  normalizeModoItalianoSongSequence,
  normalizeModoItalianoTextSequence,
  type ModoItalianoSongSequence,
  type ModoItalianoSongSequenceItem,
  type ModoItalianoTextSequence,
  type ModoItalianoTextSequenceItem
} from '../utils/modoItalianoSequence';

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

type ComponentPropsMap = Record<string, any>;
const FIFTHBELL_AVAILABLE_WEATHER_CITIES = [
  'New York',
  'San Juan',
  'Los Angeles',
  'Honolulu',
  'Mexico City',
  'Havana',
  'London',
  'Paris',
  'Berlin',
  'Rome',
  'Madrid',
  'Athens',
  'Santiago',
  'Buenos Aires',
  'Rio',
  'Lima',
  'Caracas',
  'Bogotá',
  'Tokyo',
  'Seoul',
  'Shanghai',
  'Hong Kong',
  'Bangkok',
  'Jakarta'
] as const;

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
    case 'toni-clock':
    case 'modoitaliano-clock':
    case 'modoitaliano-chyron':
    case 'modoitaliano-disclaimer':
    case 'earone':
    case 'fifthbell-content':
    case 'fifthbell-marquee':
    case 'fifthbell-corner':
    case 'fifthbell':
      return true;
    default:
      return false;
  }
};

function parseSceneMetadata(metadata: string | null): ComponentPropsMap {
  try {
    const parsed = metadata ? JSON.parse(metadata) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // no-op, fallback below
  }

  return {};
}

function getSceneSummaryText(scene: Scene): string {
  try {
    const metadata = parseSceneMetadata(scene.metadata);
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

    const chyronProps = metadata?.chyron;
    if (chyronProps && typeof chyronProps === 'object' && typeof chyronProps.text === 'string' && chyronProps.text.trim()) {
      return chyronProps.text;
    }

    const broadcastProps = metadata?.['broadcast-layout'];
    if (
      broadcastProps &&
      typeof broadcastProps === 'object' &&
      typeof broadcastProps.chyronText === 'string' &&
      broadcastProps.chyronText.trim()
    ) {
      return broadcastProps.chyronText;
    }
  } catch (err) {
    console.error('Failed to parse scene metadata for summary:', err);
  }

  return '(none)';
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
  const [selectedTransitionId, setSelectedTransitionId] = useState('crescendo-prism');
  const selectedTransition = getSceneTransitionPreset(selectedTransitionId);

  useEffect(() => {
    fetchScenes();
    fetchLayouts();
    fetchComponentTypes();
    fetchPrograms();
    fetchBroadcastSettings();
  }, []);

  useEffect(() => {
    void fetchProgramState(activeProgramId);
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
    const metadata = parseSceneMetadata(scene.metadata);
    const legacyFifthBell =
      metadata?.fifthbell && typeof metadata.fifthbell === 'object' && !Array.isArray(metadata.fifthbell) ? metadata.fifthbell : {};

    const components = scene.layout.componentType.split(',').filter(Boolean);
    const combined: Record<string, any> = {};

    for (const componentType of components) {
      const compatibleMetadata =
        componentType === 'fifthbell-content' || componentType === 'fifthbell-marquee'
          ? { ...legacyFifthBell, ...(metadata[componentType] || {}) }
          : componentType === 'toni-clock' || componentType === 'fifthbell-corner'
            ? { ...legacyFifthBell, ...(metadata['fifthbell-corner'] || {}), ...(metadata['toni-clock'] || {}), ...(metadata[componentType] || {}) }
          : metadata[componentType] || {};

      combined[componentType] = {
        ...getDefaultPropsForComponent(componentType),
        ...compatibleMetadata
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
      setSceneEditorProps({});
      return;
    }

    const scene = scenes.find((s) => s.id === selectedScene);
    if (!scene) {
      return;
    }

    const nextProps = buildComponentPropsForScene(scene);
    setSceneEditorProps(nextProps);
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
      const selectedSceneData = scenes.find((scene) => scene.id === selectedScene);
      const existingMetadata = selectedSceneData ? parseSceneMetadata(selectedSceneData.metadata) : {};
      const nextMetadata: ComponentPropsMap = {
        ...existingMetadata,
        ...nextSceneProps
      };

      const response = await fetch(apiUrl(`/scenes/${selectedScene}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
    setEditingScene(scene);
    setNewSceneName(scene.name);
    setSelectedLayoutId(scene.layoutId);

    try {
      const metadata = parseSceneMetadata(scene.metadata);
      if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
        setSceneComponentProps(buildComponentPropsForScene(scene));
      } else {
        handleLayoutSelect(scene.layoutId);
      }
    } catch (err) {
      console.error('Failed to parse scene metadata:', err);
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
          clockTimezone: 'America/Argentina/Buenos_Aires',
          showChyron: false,
          chyronText: ''
        };
      case 'reloj-clock':
        return { timezone: 'America/Argentina/Buenos_Aires' };
      case 'reloj-loop-clock':
        return { timezone: 'Europe/Madrid' };
      case 'toni-chyron':
        return { text: '', useMarquee: false };
      case 'toni-clock':
        return {
          showWorldClocks: true,
          showBellIcon: false,
          worldClockRotateIntervalMs: 5000,
          worldClockTransitionMs: 300,
          worldClockShuffle: false,
          worldClockWidthPx: 200,
          worldClockCities: [
            { city: 'SANREMO', timezone: 'Europe/Rome' },
            { city: 'NEW YORK', timezone: 'America/New_York' },
            { city: 'MADRID', timezone: 'Europe/Madrid' },
            { city: 'MONTEVIDEO', timezone: 'America/Montevideo' },
            { city: 'SANTIAGO', timezone: 'America/Santiago' }
          ]
        };
      case 'modoitaliano-clock':
        return {
          songContentMode: 'direct',
          songArtist: '',
          songTitle: '',
          songCoverUrl: '',
          songEaroneSongId: '',
          songEaroneRank: '',
          songEaroneSpins: '',
          songs: []
        };
      case 'modoitaliano-chyron':
        return {
          cta: '',
          text: '',
          show: true,
          useMarquee: false,
          textContentMode: 'text',
          ctaContentMode: 'text'
        };
      case 'modoitaliano-disclaimer':
        return {
          text: 'Contenuti a scopo informativo.',
          show: true,
          align: 'right',
          bottomPx: 24,
          fontSizePx: 20,
          opacity: 0.82
        };
      case 'toni-logo':
        return {};
      case 'earone':
        return { label: 'EARONE', rank: '', spins: '' };
      case 'fifthbell-content':
        return {
          showArticles: true,
          showWeather: true,
          showEarthquakes: true,
          showMarkets: true,
          showCallsignTake: true,
          weatherCities: [...FIFTHBELL_AVAILABLE_WEATHER_CITIES],
          languageRotation: ['en', 'es', 'en', 'it'],
          dataLoadTimeoutMs: 15000,
          playlistDefaultDurationMs: 10000,
          playlistUpdateIntervalMs: 100,
          articlesDurationMs: 10000,
          weatherDurationMs: 5000,
          earthquakesDurationMs: 10000,
          marketsDurationMs: 10000,
          audioCueEnabled: true,
          audioCueMinute: 59,
          audioCueSecond: 55,
          callsignPrelaunchUntilNyc: '2026-01-02T21:30:00',
          callsignWindowStartSecond: 50,
          callsignWindowEndSecond: 3
        };
      case 'fifthbell-marquee':
        return {
          showMarquee: false,
          marqueeMinPostsCount: 4,
          marqueeMinAverageRelevance: 0,
          marqueeMinMedianRelevance: 0,
          marqueePixelsPerSecond: 150,
          marqueeMinDurationSeconds: 10,
          marqueeHeightPx: 72
        };
      case 'fifthbell-corner':
        return {
          showWorldClocks: true,
          showBellIcon: true,
          worldClockRotateIntervalMs: 7000,
          worldClockTransitionMs: 300,
          worldClockShuffle: true,
          worldClockWidthPx: 200
        };
      case 'fifthbell':
        return {
          ...getDefaultPropsForComponent('fifthbell-content'),
          ...getDefaultPropsForComponent('fifthbell-marquee'),
          ...getDefaultPropsForComponent('toni-clock')
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
      const existingMetadata = editingScene ? parseSceneMetadata(editingScene.metadata) : {};
      const payload = {
        name: newSceneName,
        layoutId: selectedLayoutId,
        metadata: {
          ...existingMetadata,
          ...sceneComponentProps
        }
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
                {activeProgramId === 'fifthbell' && (
                  <p className='text-xs text-gray-600'>
                    FifthBell runtime settings are stored per component metadata (`fifthbell-content`, `fifthbell-marquee`, `toni-clock`).
                  </p>
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
  const toBoolean = (value: unknown, fallback: boolean): boolean => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
    }
    return fallback;
  };

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
            <label className='block text-xs text-gray-600 mb-1'>Chyron Text</label>
            <input
              type='text'
              value={props.chyronText || ''}
              onChange={(e) => updateProp(componentType, 'chyronText', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              placeholder='Optional lower chyron text'
            />
          </div>
          <div className='col-span-2'>
            <label className='flex items-center gap-2 text-sm text-gray-700'>
              <input
                type='checkbox'
                checked={toBoolean(props.showChyron, false)}
                onChange={(e) => updateProp(componentType, 'showChyron', e.target.checked)}
                className='h-4 w-4'
              />
              Show Chyron
            </label>
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
    case 'modoitaliano-chyron':
      return (
        <ModoItalianoChyronEditorFields
          componentType={componentType}
          props={props}
          updateProp={updateProp}
          replaceProps={replaceProps}
          commitProps={commitProps}
        />
      );
    case 'modoitaliano-clock':
      return (
        <ModoItalianoClockEditorFields
          componentType={componentType}
          props={props}
          updateProp={updateProp}
          replaceProps={replaceProps}
          commitProps={commitProps}
        />
      );
    case 'toni-clock':
    {
      const worldClockCitiesDefaultValue = JSON.stringify(Array.isArray(props.worldClockCities) ? props.worldClockCities : [], null, 2);

      return (
        <div className='space-y-4'>
          <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3'>
            <label className='flex items-center gap-2 text-sm text-gray-700'>
              <input
                type='checkbox'
                checked={toBoolean(props.showWorldClocks, true)}
                onChange={(e) => updateProp(componentType, 'showWorldClocks', e.target.checked)}
                className='h-4 w-4'
              />
              Show World Clocks
            </label>
            <label className='flex items-center gap-2 text-sm text-gray-700'>
              <input
                type='checkbox'
                checked={toBoolean(props.showBellIcon, false)}
                onChange={(e) => updateProp(componentType, 'showBellIcon', e.target.checked)}
                className='h-4 w-4'
              />
              Show Bell Icon
            </label>
            <label className='flex items-center gap-2 text-sm text-gray-700'>
              <input
                type='checkbox'
                checked={toBoolean(props.worldClockShuffle, false)}
                onChange={(e) => updateProp(componentType, 'worldClockShuffle', e.target.checked)}
                className='h-4 w-4'
              />
              Shuffle world clocks
            </label>
          </div>

          <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3'>
            <label className='text-sm text-gray-700'>
              <span className='block text-xs text-gray-500 mb-1'>World clock rotate (ms)</span>
              <input
                type='number'
                min={500}
                value={props.worldClockRotateIntervalMs ?? 5000}
                onChange={(e) => updateProp(componentType, 'worldClockRotateIntervalMs', Number(e.target.value))}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              />
            </label>
            <label className='text-sm text-gray-700'>
              <span className='block text-xs text-gray-500 mb-1'>World clock transition (ms)</span>
              <input
                type='number'
                min={0}
                value={props.worldClockTransitionMs ?? 300}
                onChange={(e) => updateProp(componentType, 'worldClockTransitionMs', Number(e.target.value))}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              />
            </label>
            <label className='text-sm text-gray-700'>
              <span className='block text-xs text-gray-500 mb-1'>World clock width (px)</span>
              <input
                type='number'
                min={120}
                value={props.worldClockWidthPx ?? 200}
                onChange={(e) => updateProp(componentType, 'worldClockWidthPx', Number(e.target.value))}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              />
            </label>
          </div>

          <div className='space-y-2'>
            <label className='block text-xs text-gray-600'>World Clock Cities JSON</label>
            <textarea
              defaultValue={worldClockCitiesDefaultValue}
              onBlur={(e) => {
                if (!e.target.value.trim()) {
                  updateProp(componentType, 'worldClockCities', []);
                  return;
                }

                try {
                  const parsed = JSON.parse(e.target.value);
                  if (!Array.isArray(parsed)) {
                    return;
                  }

                  const normalized = parsed
                    .map((item) => {
                      if (!item || typeof item !== 'object' || Array.isArray(item)) {
                        return null;
                      }
                      const city = typeof item.city === 'string' ? item.city.trim() : '';
                      const timezone = typeof item.timezone === 'string' ? item.timezone.trim() : '';
                      if (!city || !timezone) {
                        return null;
                      }
                      return { city, timezone };
                    })
                    .filter((item): item is { city: string; timezone: string } => item !== null);

                  updateProp(componentType, 'worldClockCities', normalized);
                } catch (error) {
                  console.error('Invalid ToniClock worldClockCities JSON:', error);
                }
              }}
              rows={6}
              className='w-full px-3 py-2 text-sm border rounded font-mono focus:ring-2 focus:ring-green-500'
            />
            <p className='text-xs text-gray-500'>Each item must be {'{ \"city\": \"SANREMO\", \"timezone\": \"Europe/Rome\" }'}.</p>
          </div>
        </div>
      );
    }
    case 'modoitaliano-disclaimer':
      return (
        <div className='space-y-3'>
          <p className='text-xs text-gray-500'>Shown only when ModoItaliano chyron is hidden/empty.</p>
          <div>
            <label className='block text-xs text-gray-600 mb-1'>Text</label>
            <input
              type='text'
              value={props.text || ''}
              onChange={(e) => updateProp(componentType, 'text', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              placeholder='Disclaimer text'
            />
          </div>
          <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3'>
            <label className='flex items-center gap-2 text-sm text-gray-700'>
              <input
                type='checkbox'
                checked={toBoolean(props.show, true)}
                onChange={(e) => updateProp(componentType, 'show', e.target.checked)}
                className='h-4 w-4'
              />
              Show Disclaimer
            </label>
            <label className='text-sm text-gray-700'>
              <span className='block text-xs text-gray-500 mb-1'>Alignment</span>
              <select
                value={props.align || 'right'}
                onChange={(e) => updateProp(componentType, 'align', e.target.value)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              >
                <option value='left'>Left</option>
                <option value='center'>Center</option>
                <option value='right'>Right</option>
              </select>
            </label>
            <label className='text-sm text-gray-700'>
              <span className='block text-xs text-gray-500 mb-1'>Bottom (px)</span>
              <input
                type='number'
                min={0}
                value={props.bottomPx ?? 24}
                onChange={(e) => updateProp(componentType, 'bottomPx', Number(e.target.value))}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              />
            </label>
            <label className='text-sm text-gray-700'>
              <span className='block text-xs text-gray-500 mb-1'>Font Size (px)</span>
              <input
                type='number'
                min={10}
                value={props.fontSizePx ?? 20}
                onChange={(e) => updateProp(componentType, 'fontSizePx', Number(e.target.value))}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              />
            </label>
          </div>
          <label className='text-sm text-gray-700 block max-w-xs'>
            <span className='block text-xs text-gray-500 mb-1'>Opacity (0-1)</span>
            <input
              type='number'
              min={0}
              max={1}
              step={0.05}
              value={props.opacity ?? 0.82}
              onChange={(e) => updateProp(componentType, 'opacity', Number(e.target.value))}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
            />
          </label>
        </div>
      );
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
    case 'fifthbell':
    case 'fifthbell-content':
    case 'fifthbell-marquee':
    case 'fifthbell-corner': {
      const supportsContent = componentType === 'fifthbell' || componentType === 'fifthbell-content';
      const supportsMarquee = componentType === 'fifthbell' || componentType === 'fifthbell-marquee';
      const supportsCorner = componentType === 'fifthbell' || componentType === 'fifthbell-corner';
      const selectedWeatherCities = Array.isArray(props.weatherCities)
        ? props.weatherCities.filter((city: unknown): city is string => typeof city === 'string')
        : [];
      const selectedCitySet = new Set(selectedWeatherCities);
      const languageRotation = Array.isArray(props.languageRotation)
        ? props.languageRotation.filter((lang: unknown): lang is string => typeof lang === 'string')
        : ['en', 'es', 'en', 'it'];
      const worldClockCitiesDefaultValue = JSON.stringify(Array.isArray(props.worldClockCities) ? props.worldClockCities : [], null, 2);

      return (
        <div className='space-y-4'>
          <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3'>
            {supportsContent && (
              <label className='flex items-center gap-2 text-sm text-gray-700'>
                <input
                  type='checkbox'
                  checked={toBoolean(props.showArticles, true)}
                  onChange={(e) => updateProp(componentType, 'showArticles', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Articles
              </label>
            )}
            {supportsContent && (
              <label className='flex items-center gap-2 text-sm text-gray-700'>
                <input
                  type='checkbox'
                  checked={toBoolean(props.showWeather, true)}
                  onChange={(e) => updateProp(componentType, 'showWeather', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Weather
              </label>
            )}
            {supportsContent && (
              <label className='flex items-center gap-2 text-sm text-gray-700'>
                <input
                  type='checkbox'
                  checked={toBoolean(props.showEarthquakes, true)}
                  onChange={(e) => updateProp(componentType, 'showEarthquakes', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Earthquakes
              </label>
            )}
            {supportsContent && (
              <label className='flex items-center gap-2 text-sm text-gray-700'>
                <input
                  type='checkbox'
                  checked={toBoolean(props.showMarkets, true)}
                  onChange={(e) => updateProp(componentType, 'showMarkets', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Markets
              </label>
            )}
            {supportsMarquee && (
              <label className='flex items-center gap-2 text-sm text-gray-700'>
                <input
                  type='checkbox'
                  checked={toBoolean(props.showMarquee, false)}
                  onChange={(e) => updateProp(componentType, 'showMarquee', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Bottom Marquee
              </label>
            )}
            {supportsContent && (
              <label className='flex items-center gap-2 text-sm text-gray-700'>
                <input
                  type='checkbox'
                  checked={toBoolean(props.showCallsignTake, true)}
                  onChange={(e) => updateProp(componentType, 'showCallsignTake', e.target.checked)}
                  className='h-4 w-4'
                />
                Enable Callsign Take
              </label>
            )}
            {supportsCorner && (
              <label className='flex items-center gap-2 text-sm text-gray-700'>
                <input
                  type='checkbox'
                  checked={toBoolean(props.showWorldClocks, true)}
                  onChange={(e) => updateProp(componentType, 'showWorldClocks', e.target.checked)}
                  className='h-4 w-4'
                />
                Show World Clocks
              </label>
            )}
            {supportsCorner && (
              <label className='flex items-center gap-2 text-sm text-gray-700'>
                <input
                  type='checkbox'
                  checked={toBoolean(props.showBellIcon, true)}
                  onChange={(e) => updateProp(componentType, 'showBellIcon', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Bell Icon
              </label>
            )}
            {supportsContent && (
              <label className='flex items-center gap-2 text-sm text-gray-700'>
                <input
                  type='checkbox'
                  checked={toBoolean(props.audioCueEnabled, true)}
                  onChange={(e) => updateProp(componentType, 'audioCueEnabled', e.target.checked)}
                  className='h-4 w-4'
                />
                Enable Audio Cue
              </label>
            )}
            {supportsCorner && (
              <label className='flex items-center gap-2 text-sm text-gray-700'>
                <input
                  type='checkbox'
                  checked={toBoolean(props.worldClockShuffle, true)}
                  onChange={(e) => updateProp(componentType, 'worldClockShuffle', e.target.checked)}
                  className='h-4 w-4'
                />
                Shuffle world clocks
              </label>
            )}
          </div>

          <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3'>
            {supportsContent && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Data load timeout (ms)</span>
                <input
                  type='number'
                  min={1000}
                  value={props.dataLoadTimeoutMs ?? 15000}
                  onChange={(e) => updateProp(componentType, 'dataLoadTimeoutMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Playlist default duration (ms)</span>
                <input
                  type='number'
                  min={1000}
                  value={props.playlistDefaultDurationMs ?? 10000}
                  onChange={(e) => updateProp(componentType, 'playlistDefaultDurationMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Playlist update interval (ms)</span>
                <input
                  type='number'
                  min={16}
                  value={props.playlistUpdateIntervalMs ?? 100}
                  onChange={(e) => updateProp(componentType, 'playlistUpdateIntervalMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Articles duration (ms)</span>
                <input
                  type='number'
                  min={1000}
                  value={props.articlesDurationMs ?? 10000}
                  onChange={(e) => updateProp(componentType, 'articlesDurationMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Weather duration (ms)</span>
                <input
                  type='number'
                  min={1000}
                  value={props.weatherDurationMs ?? 5000}
                  onChange={(e) => updateProp(componentType, 'weatherDurationMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Earthquakes duration (ms)</span>
                <input
                  type='number'
                  min={1000}
                  value={props.earthquakesDurationMs ?? 10000}
                  onChange={(e) => updateProp(componentType, 'earthquakesDurationMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Markets duration (ms)</span>
                <input
                  type='number'
                  min={1000}
                  value={props.marketsDurationMs ?? 10000}
                  onChange={(e) => updateProp(componentType, 'marketsDurationMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsCorner && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>World clock rotate (ms)</span>
                <input
                  type='number'
                  min={500}
                  value={props.worldClockRotateIntervalMs ?? 7000}
                  onChange={(e) => updateProp(componentType, 'worldClockRotateIntervalMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsCorner && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>World clock transition (ms)</span>
                <input
                  type='number'
                  min={0}
                  value={props.worldClockTransitionMs ?? 300}
                  onChange={(e) => updateProp(componentType, 'worldClockTransitionMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsCorner && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>World clock width (px)</span>
                <input
                  type='number'
                  min={120}
                  value={props.worldClockWidthPx ?? 200}
                  onChange={(e) => updateProp(componentType, 'worldClockWidthPx', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Audio cue minute</span>
                <input
                  type='number'
                  min={0}
                  max={59}
                  value={props.audioCueMinute ?? 59}
                  onChange={(e) => updateProp(componentType, 'audioCueMinute', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Audio cue second</span>
                <input
                  type='number'
                  min={0}
                  max={59}
                  value={props.audioCueSecond ?? 55}
                  onChange={(e) => updateProp(componentType, 'audioCueSecond', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Callsign prelaunch until (NYC ISO)</span>
                <input
                  type='text'
                  value={props.callsignPrelaunchUntilNyc ?? '2026-01-02T21:30:00'}
                  onChange={(e) => updateProp(componentType, 'callsignPrelaunchUntilNyc', e.target.value)}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                  placeholder='2026-01-02T21:30:00'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Callsign window start sec (:59)</span>
                <input
                  type='number'
                  min={0}
                  max={59}
                  value={props.callsignWindowStartSecond ?? 50}
                  onChange={(e) => updateProp(componentType, 'callsignWindowStartSecond', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Callsign window end sec (:00)</span>
                <input
                  type='number'
                  min={0}
                  max={59}
                  value={props.callsignWindowEndSecond ?? 3}
                  onChange={(e) => updateProp(componentType, 'callsignWindowEndSecond', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsMarquee && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Marquee min posts</span>
                <input
                  type='number'
                  min={0}
                  value={props.marqueeMinPostsCount ?? 4}
                  onChange={(e) => updateProp(componentType, 'marqueeMinPostsCount', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsMarquee && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Marquee min average relevance</span>
                <input
                  type='number'
                  min={0}
                  value={props.marqueeMinAverageRelevance ?? 0}
                  onChange={(e) => updateProp(componentType, 'marqueeMinAverageRelevance', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsMarquee && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Marquee min median relevance</span>
                <input
                  type='number'
                  min={0}
                  value={props.marqueeMinMedianRelevance ?? 0}
                  onChange={(e) => updateProp(componentType, 'marqueeMinMedianRelevance', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsMarquee && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Marquee px/sec</span>
                <input
                  type='number'
                  min={10}
                  value={props.marqueePixelsPerSecond ?? 150}
                  onChange={(e) => updateProp(componentType, 'marqueePixelsPerSecond', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsMarquee && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Marquee min duration (sec)</span>
                <input
                  type='number'
                  min={1}
                  value={props.marqueeMinDurationSeconds ?? 10}
                  onChange={(e) => updateProp(componentType, 'marqueeMinDurationSeconds', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
            {supportsMarquee && (
              <label className='text-sm text-gray-700'>
                <span className='block text-xs text-gray-500 mb-1'>Marquee height (px)</span>
                <input
                  type='number'
                  min={72}
                  value={props.marqueeHeightPx ?? 72}
                  onChange={(e) => updateProp(componentType, 'marqueeHeightPx', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                />
              </label>
            )}
          </div>
          {supportsMarquee && (
            <p className='text-xs text-gray-500'>Marquee thresholds are minimums. Set any of them to `0` to disable that specific filter.</p>
          )}

          {supportsContent && (
            <div className='space-y-2'>
              <label className='block text-xs text-gray-600'>Language Rotation (comma-separated: en, es, it)</label>
              <input
                type='text'
                defaultValue={languageRotation.join(', ')}
                onBlur={(e) => {
                  const next = e.target.value
                    .split(',')
                    .map((lang) => lang.trim().toLowerCase())
                    .filter((lang) => ['en', 'es', 'it'].includes(lang));
                  updateProp(componentType, 'languageRotation', next.length > 0 ? next : ['en']);
                }}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              />
            </div>
          )}

          {supportsContent && (
            <div>
              <h3 className='text-sm font-semibold text-gray-800 mb-2'>Weather Cities</h3>
              <p className='text-xs text-gray-500 mb-2'>If none are selected, all cities are shown in the weather segment.</p>
              <div className='grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 max-h-64 overflow-auto border rounded p-3 bg-gray-50'>
                {FIFTHBELL_AVAILABLE_WEATHER_CITIES.map((city) => (
                  <label key={city} className='flex items-center gap-2 text-sm text-gray-700'>
                    <input
                      type='checkbox'
                      checked={selectedCitySet.has(city)}
                      onChange={(e) => {
                        const next = new Set(selectedWeatherCities);
                        if (e.target.checked) {
                          next.add(city);
                        } else {
                          next.delete(city);
                        }
                        updateProp(componentType, 'weatherCities', [...next]);
                      }}
                      className='h-4 w-4'
                    />
                    {city}
                  </label>
                ))}
              </div>
            </div>
          )}

          {supportsCorner && (
            <div className='space-y-2'>
              <label className='block text-xs text-gray-600'>World Clock Cities JSON (optional override)</label>
              <textarea
                defaultValue={worldClockCitiesDefaultValue}
                onBlur={(e) => {
                  if (!e.target.value.trim()) {
                    updateProp(componentType, 'worldClockCities', []);
                    return;
                  }

                  try {
                    const parsed = JSON.parse(e.target.value);
                    if (!Array.isArray(parsed)) {
                      return;
                    }

                    const normalized = parsed
                      .map((item) => {
                        if (!item || typeof item !== 'object' || Array.isArray(item)) {
                          return null;
                        }
                        const city = typeof item.city === 'string' ? item.city.trim() : '';
                        const timezone = typeof item.timezone === 'string' ? item.timezone.trim() : '';
                        if (!city || !timezone) {
                          return null;
                        }
                        return { city, timezone };
                      })
                      .filter((item): item is { city: string; timezone: string } => item !== null);

                    updateProp(componentType, 'worldClockCities', normalized);
                  } catch (error) {
                    console.error('Invalid FifthBell worldClockCities JSON:', error);
                  }
                }}
                rows={6}
                className='w-full px-3 py-2 text-sm border rounded font-mono focus:ring-2 focus:ring-green-500'
              />
              <p className='text-xs text-gray-500'>Each item must be {'{ \"city\": \"NEW YORK\", \"timezone\": \"America/New_York\" }'}.</p>
            </div>
          )}
        </div>
      );
    }
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

interface ModoItalianoSongDraft {
  artist: string;
  title: string;
  coverUrl: string;
  earoneSongId: string;
  earoneRank: string;
  earoneSpins: string;
}

function normalizeModoItalianoSongDraft(value: unknown): ModoItalianoSongDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const artist = typeof record.artist === 'string' ? record.artist.trim() : '';
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const coverUrl = typeof record.coverUrl === 'string' ? record.coverUrl.trim() : '';
  const earoneSongId =
    typeof record.earoneSongId === 'string'
      ? record.earoneSongId.trim()
      : typeof record.earoneSongId === 'number' && Number.isFinite(record.earoneSongId)
        ? String(record.earoneSongId)
        : '';
  const earoneRank = typeof record.earoneRank === 'string' ? record.earoneRank.trim() : '';
  const earoneSpins =
    typeof record.earoneSpins === 'string'
      ? record.earoneSpins.trim()
      : typeof record.earoneSpins === 'number' && Number.isFinite(record.earoneSpins)
        ? String(record.earoneSpins)
        : '';

  if (!artist && !title && !coverUrl && !earoneSongId && !earoneRank && !earoneSpins) {
    return null;
  }

  return {
    artist,
    title,
    coverUrl,
    earoneSongId,
    earoneRank,
    earoneSpins
  };
}

function ModoItalianoClockEditorFields({
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
  const normalizedSequence = normalizeModoItalianoSongSequence(props.songSequence);
  const songContentMode = getModoItalianoSongContentMode(props.songContentMode, normalizedSequence);
  const directSongFromFields = normalizeModoItalianoSongDraft({
    artist: props.songArtist,
    title: props.songTitle,
    coverUrl: props.songCoverUrl,
    earoneSongId: props.songEaroneSongId,
    earoneRank: props.songEaroneRank,
    earoneSpins: props.songEaroneSpins
  });
  const directSongFromLegacyList = Array.isArray(props.songs)
    ? props.songs
        .map((song: unknown) => normalizeModoItalianoSongDraft(song))
        .find((song: ModoItalianoSongDraft | null): song is ModoItalianoSongDraft => song !== null) ?? null
    : null;
  const directSong = directSongFromFields ?? directSongFromLegacyList ?? {
    artist: '',
    title: '',
    coverUrl: '',
    earoneSongId: '',
    earoneRank: '',
    earoneSpins: ''
  };

  const applyProps = (nextProps: any) => {
    replaceProps(componentType, nextProps);
  };

  const activateSequence = async (nextSequence: ModoItalianoSongSequence) => {
    const nextProps = {
      ...props,
      songContentMode: 'sequence',
      songSequence: nextSequence
    };
    replaceProps(componentType, nextProps);
    if (commitProps) {
      await commitProps(componentType, nextProps);
    }
  };

  const updateDirectSongField = (propName: string, value: string) => {
    updateProp(componentType, propName, value);
    if (Array.isArray(props.songs) && props.songs.length > 0) {
      updateProp(componentType, 'songs', []);
    }
  };

  const currentSongArtist = directSong.artist;
  const currentSongTitle = directSong.title;
  const currentSongCoverUrl = directSong.coverUrl;
  const currentSongEaroneSongId = directSong.earoneSongId;
  const currentSongEaroneRank = directSong.earoneRank;
  const currentSongEaroneSpins = directSong.earoneSpins;

  const renderDirectSongFields = () => (
    <div className='space-y-3'>
      <div className='grid grid-cols-1 sm:grid-cols-3 gap-3'>
        <label className='text-sm text-gray-700'>
          <span className='block text-xs text-gray-500 mb-1'>Artist</span>
          <input
            type='text'
            value={currentSongArtist}
            onChange={(e) => updateDirectSongField('songArtist', e.target.value)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
            placeholder='Artist'
          />
        </label>
        <label className='text-sm text-gray-700'>
          <span className='block text-xs text-gray-500 mb-1'>Title</span>
          <input
            type='text'
            value={currentSongTitle}
            onChange={(e) => updateDirectSongField('songTitle', e.target.value)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
            placeholder='Song title'
          />
        </label>
        <label className='text-sm text-gray-700'>
          <span className='block text-xs text-gray-500 mb-1'>Cover URL</span>
          <input
            type='text'
            value={currentSongCoverUrl}
            onChange={(e) => updateDirectSongField('songCoverUrl', e.target.value)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
            placeholder='/cover.jpg'
          />
        </label>
      </div>
      <div className='grid grid-cols-1 sm:grid-cols-3 gap-3'>
        <label className='text-sm text-gray-700'>
          <span className='block text-xs text-gray-500 mb-1'>EarOne Song ID</span>
          <input
            type='text'
            value={currentSongEaroneSongId}
            onChange={(e) => updateDirectSongField('songEaroneSongId', e.target.value)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
            placeholder='Matches song.earoneSongId'
          />
        </label>
        <label className='text-sm text-gray-700'>
          <span className='block text-xs text-gray-500 mb-1'>EarOne Rank</span>
          <input
            type='text'
            value={currentSongEaroneRank}
            onChange={(e) => updateDirectSongField('songEaroneRank', e.target.value)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
            placeholder='Optional fallback'
          />
        </label>
        <label className='text-sm text-gray-700'>
          <span className='block text-xs text-gray-500 mb-1'>EarOne Spins</span>
          <input
            type='text'
            value={currentSongEaroneSpins}
            onChange={(e) => updateDirectSongField('songEaroneSpins', e.target.value)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
            placeholder='Optional fallback'
          />
        </label>
      </div>
      <p className='text-xs text-gray-500'>Legacy `songs[]` metadata is still read for older scenes. These direct fields are now the primary source.</p>
    </div>
  );

  return (
    <div className='space-y-4'>
      <div className='space-y-2'>
        <div className='flex flex-wrap gap-2'>
          <button
            type='button'
            onClick={() =>
              applyProps({
                ...props,
                songContentMode: 'direct'
              })
            }
            className={`px-3 py-1.5 rounded text-sm font-medium border ${
              songContentMode === 'direct' ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
            }`}
          >
            Direct Song
          </button>
          <button
            type='button'
            onClick={() =>
              applyProps({
                ...props,
                songContentMode: 'sequence',
                songSequence: normalizedSequence ?? createModoItalianoSongSequence('manual')
              })
            }
            className={`px-3 py-1.5 rounded text-sm font-medium border ${
              songContentMode === 'sequence' ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
            }`}
          >
            Sequence
          </button>
        </div>

        {songContentMode === 'sequence' ? (
          <div className='space-y-3'>
            <p className='text-xs text-gray-500'>Sequence mode lets you preload songs and take/remove entries live with manual or autoplay behavior.</p>
            <ModoItalianoSongSequenceEditor
              sequence={normalizedSequence ?? createModoItalianoSongSequence('manual')}
              onChange={(nextSequence) =>
                applyProps({
                  ...props,
                  songContentMode: 'sequence',
                  songSequence: nextSequence
                })
              }
              onTakeSelection={activateSequence}
            />
            <details className='rounded border border-dashed border-gray-300 px-3 py-2'>
              <summary className='cursor-pointer text-xs font-medium text-gray-600'>Fallback direct song</summary>
              <div className='pt-3'>{renderDirectSongFields()}</div>
            </details>
          </div>
        ) : (
          renderDirectSongFields()
        )}
      </div>

      <p className='text-xs text-gray-500'>World clock cities/timezones are fixed for ModoItaliano 2026 and are no longer configurable here.</p>
    </div>
  );
}

function ModoItalianoChyronEditorFields({
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
  const normalizedTextSequence = normalizeModoItalianoTextSequence(props.textSequence, 0, { includeMarquee: true });
  const normalizedCtaSequence = normalizeModoItalianoTextSequence(props.ctaSequence);
  const textContentMode = getModoItalianoTextContentMode(props.textContentMode, normalizedTextSequence);
  const ctaContentMode = getModoItalianoTextContentMode(props.ctaContentMode, normalizedCtaSequence);
  const showValue =
    typeof props.show === 'boolean'
      ? props.show
      : typeof props.show === 'string'
        ? props.show.trim().toLowerCase() !== 'false'
        : true;

  const applyProps = (nextProps: any) => {
    replaceProps(componentType, nextProps);
  };

  const activateTextSequence = async (nextSequence: ModoItalianoTextSequence) => {
    const nextProps = {
      ...props,
      textContentMode: 'sequence',
      textSequence: nextSequence
    };
    replaceProps(componentType, nextProps);
    if (commitProps) {
      await commitProps(componentType, nextProps);
    }
  };

  const activateCtaSequence = async (nextSequence: ModoItalianoTextSequence) => {
    const nextProps = {
      ...props,
      ctaContentMode: 'sequence',
      ctaSequence: nextSequence
    };
    replaceProps(componentType, nextProps);
    if (commitProps) {
      await commitProps(componentType, nextProps);
    }
  };

  return (
    <div className='space-y-4'>
      <p className='text-xs text-gray-500'>ModoItaliano row rule: if chyron and disclaimer are both enabled, chyron is shown.</p>
      <label className='flex items-center gap-2 text-sm text-gray-700'>
        <input
          type='checkbox'
          checked={showValue}
          onChange={(e) => updateProp(componentType, 'show', e.target.checked)}
          className='h-4 w-4'
        />
        Show Chyron
      </label>

      <div className='space-y-2 rounded border border-slate-200 p-3'>
        <div className='flex items-center justify-between'>
          <span className='text-xs font-semibold uppercase tracking-wide text-slate-600'>Main Chyron</span>
          <div className='flex gap-2'>
            <button
              type='button'
              onClick={() =>
                applyProps({
                  ...props,
                  textContentMode: 'text'
                })
              }
              className={`px-3 py-1.5 rounded text-sm font-medium border ${
                textContentMode === 'text' ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
              }`}
            >
              Direct
            </button>
            <button
              type='button'
              onClick={() =>
                applyProps({
                  ...props,
                  textContentMode: 'sequence',
                  textSequence: normalizedTextSequence ?? createModoItalianoTextSequence('manual', { includeMarquee: true })
                })
              }
              className={`px-3 py-1.5 rounded text-sm font-medium border ${
                textContentMode === 'sequence' ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
              }`}
            >
              Sequence
            </button>
          </div>
        </div>

        {textContentMode === 'sequence' ? (
          <div className='space-y-3'>
            <p className='text-xs text-gray-500'>Preload multiple chyron lines, then take/remove manually or let autoplay run.</p>
            <ModoItalianoTextSequenceEditor
              sequence={normalizedTextSequence ?? createModoItalianoTextSequence('manual', { includeMarquee: true })}
              includeMarquee
              textLabel='Text'
              textPlaceholder='Main chyron text'
              onChange={(nextSequence) =>
                applyProps({
                  ...props,
                  textContentMode: 'sequence',
                  textSequence: nextSequence
                })
              }
              onTakeSelection={activateTextSequence}
            />
            <details className='rounded border border-dashed border-gray-300 px-3 py-2'>
              <summary className='cursor-pointer text-xs font-medium text-gray-600'>Fallback direct text</summary>
              <div className='space-y-2 pt-3'>
                <label className='text-sm text-gray-700 block'>
                  <span className='block text-xs text-gray-500 mb-1'>Text</span>
                  <input
                    type='text'
                    value={typeof props.text === 'string' ? props.text : ''}
                    onChange={(e) => updateProp(componentType, 'text', e.target.value)}
                    className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                    placeholder='Main chyron text'
                  />
                </label>
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
            <label className='text-sm text-gray-700 block'>
              <span className='block text-xs text-gray-500 mb-1'>Text</span>
              <input
                type='text'
                value={typeof props.text === 'string' ? props.text : ''}
                onChange={(e) => updateProp(componentType, 'text', e.target.value)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                placeholder='Main chyron text'
              />
            </label>
            <label className='flex items-center gap-2 text-sm text-gray-700'>
              <input
                type='checkbox'
                checked={Boolean(props.useMarquee)}
                onChange={(e) => updateProp(componentType, 'useMarquee', e.target.checked)}
                className='h-4 w-4'
              />
              Marquee Mode
            </label>
          </div>
        )}
      </div>

      <div className='space-y-2 rounded border border-slate-200 p-3'>
        <div className='flex items-center justify-between'>
          <span className='text-xs font-semibold uppercase tracking-wide text-slate-600'>CTA</span>
          <div className='flex gap-2'>
            <button
              type='button'
              onClick={() =>
                applyProps({
                  ...props,
                  ctaContentMode: 'text'
                })
              }
              className={`px-3 py-1.5 rounded text-sm font-medium border ${
                ctaContentMode === 'text' ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
              }`}
            >
              Direct
            </button>
            <button
              type='button'
              onClick={() =>
                applyProps({
                  ...props,
                  ctaContentMode: 'sequence',
                  ctaSequence: normalizedCtaSequence ?? createModoItalianoTextSequence('manual')
                })
              }
              className={`px-3 py-1.5 rounded text-sm font-medium border ${
                ctaContentMode === 'sequence' ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
              }`}
            >
              Sequence
            </button>
          </div>
        </div>

        {ctaContentMode === 'sequence' ? (
          <div className='space-y-3'>
            <p className='text-xs text-gray-500'>Preload CTA messages separately and take/remove them independently.</p>
            <ModoItalianoTextSequenceEditor
              sequence={normalizedCtaSequence ?? createModoItalianoTextSequence('manual')}
              textLabel='CTA'
              textPlaceholder='Call to action (shown above chyron)'
              onChange={(nextSequence) =>
                applyProps({
                  ...props,
                  ctaContentMode: 'sequence',
                  ctaSequence: nextSequence
                })
              }
              onTakeSelection={activateCtaSequence}
            />
            <details className='rounded border border-dashed border-gray-300 px-3 py-2'>
              <summary className='cursor-pointer text-xs font-medium text-gray-600'>Fallback direct CTA</summary>
              <div className='pt-3'>
                <label className='text-sm text-gray-700 block'>
                  <span className='block text-xs text-gray-500 mb-1'>CTA</span>
                  <input
                    type='text'
                    value={typeof props.cta === 'string' ? props.cta : ''}
                    onChange={(e) => updateProp(componentType, 'cta', e.target.value)}
                    className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                    placeholder='Call to action (shown above chyron)'
                  />
                </label>
              </div>
            </details>
          </div>
        ) : (
          <label className='text-sm text-gray-700 block'>
            <span className='block text-xs text-gray-500 mb-1'>CTA</span>
            <input
              type='text'
              value={typeof props.cta === 'string' ? props.cta : ''}
              onChange={(e) => updateProp(componentType, 'cta', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
              placeholder='Call to action (shown above chyron)'
            />
          </label>
        )}
      </div>
    </div>
  );
}

function ModoItalianoTextSequenceEditor({
  sequence,
  onChange,
  onTakeSelection,
  depth = 0,
  includeMarquee = false,
  textLabel = 'Text',
  textPlaceholder = 'Text'
}: {
  sequence: ModoItalianoTextSequence;
  onChange: (nextSequence: ModoItalianoTextSequence) => void;
  onTakeSelection?: (nextSequence: ModoItalianoTextSequence) => Promise<void> | void;
  depth?: number;
  includeMarquee?: boolean;
  textLabel?: string;
  textPlaceholder?: string;
}) {
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const isNested = depth > 0;
  const effectiveActiveItemId = getModoItalianoTextSequenceSelectedItemId(sequence, nowMs);

  useEffect(() => {
    if (sequence.mode !== 'autoplay') {
      return;
    }

    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 250);

    return () => clearInterval(timer);
  }, [sequence.mode, sequence.startedAt, sequence.intervalMs, sequence.loop, sequence.items.length]);

  const applySequence = (nextSequence: ModoItalianoTextSequence) => {
    onChange({
      ...nextSequence,
      activeItemId:
        nextSequence.activeItemId && nextSequence.items.some((item) => item.id === nextSequence.activeItemId)
          ? nextSequence.activeItemId
          : (nextSequence.items[0]?.id ?? null)
    });
  };

  const updateItem = (index: number, nextItem: ModoItalianoTextSequenceItem) => {
    const nextItems = sequence.items.map((item, itemIndex) => (itemIndex === index ? nextItem : item));
    applySequence({
      ...sequence,
      items: nextItems
    });
  };

  const addItem = (kind: ModoItalianoTextSequenceItem['kind']) => {
    const nextItem = createModoItalianoTextSequenceItem(kind, { includeMarquee });
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
                    const nextKind = e.target.value as ModoItalianoTextSequenceItem['kind'];
                    if (nextKind === item.kind) {
                      return;
                    }

                    if (nextKind === 'sequence') {
                      updateItem(index, {
                        id: item.id,
                        label: item.kind === 'sequence' ? item.label : item.text.trim() || 'Nested Sequence',
                        kind: 'sequence',
                        sequence: createModoItalianoTextSequence('manual', { includeMarquee })
                      });
                      return;
                    }

                    updateItem(index, {
                      id: item.id,
                      kind: 'preset',
                      text: item.kind === 'sequence' ? item.label : item.text,
                      useMarquee: includeMarquee ? false : undefined
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
                  <label className='text-sm text-gray-700 block'>
                    <span className='block text-xs text-gray-500 mb-1'>{textLabel}</span>
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
                      placeholder={textPlaceholder}
                    />
                  </label>
                  {includeMarquee && (
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
                  )}
                </div>
              ) : (
                <div className='mt-3'>
                  <ModoItalianoTextSequenceEditor
                    sequence={item.sequence}
                    depth={depth + 1}
                    includeMarquee={includeMarquee}
                    textLabel={textLabel}
                    textPlaceholder={textPlaceholder}
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

function ModoItalianoSongSequenceEditor({
  sequence,
  onChange,
  onTakeSelection,
  depth = 0
}: {
  sequence: ModoItalianoSongSequence;
  onChange: (nextSequence: ModoItalianoSongSequence) => void;
  onTakeSelection?: (nextSequence: ModoItalianoSongSequence) => Promise<void> | void;
  depth?: number;
}) {
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const isNested = depth > 0;
  const effectiveActiveItemId = getModoItalianoSongSequenceSelectedItemId(sequence, nowMs);

  useEffect(() => {
    if (sequence.mode !== 'autoplay') {
      return;
    }

    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 250);

    return () => clearInterval(timer);
  }, [sequence.mode, sequence.startedAt, sequence.intervalMs, sequence.loop, sequence.items.length]);

  const applySequence = (nextSequence: ModoItalianoSongSequence) => {
    onChange({
      ...nextSequence,
      activeItemId:
        nextSequence.activeItemId && nextSequence.items.some((item) => item.id === nextSequence.activeItemId)
          ? nextSequence.activeItemId
          : (nextSequence.items[0]?.id ?? null)
    });
  };

  const updateItem = (index: number, nextItem: ModoItalianoSongSequenceItem) => {
    const nextItems = sequence.items.map((item, itemIndex) => (itemIndex === index ? nextItem : item));
    applySequence({
      ...sequence,
      items: nextItems
    });
  };

  const addItem = (kind: ModoItalianoSongSequenceItem['kind']) => {
    const nextItem = createModoItalianoSongSequenceItem(kind);
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
                  <div className='min-w-0 flex-1 text-xs font-medium uppercase tracking-wide text-slate-500'>Song Preset</div>
                )}
                <select
                  value={item.kind}
                  onChange={(e) => {
                    const nextKind = e.target.value as ModoItalianoSongSequenceItem['kind'];
                    if (nextKind === item.kind) {
                      return;
                    }

                    if (nextKind === 'sequence') {
                      const nextLabel =
                        item.kind === 'sequence'
                          ? item.label
                          : [item.artist, item.title].filter(Boolean).join(' - ') || 'Nested Sequence';
                      updateItem(index, {
                        id: item.id,
                        label: nextLabel,
                        kind: 'sequence',
                        sequence: createModoItalianoSongSequence('manual')
                      });
                      return;
                    }

                    updateItem(index, {
                      id: item.id,
                      kind: 'preset',
                      artist: item.kind === 'sequence' ? item.label : item.artist,
                      title: item.kind === 'sequence' ? '' : item.title,
                      coverUrl: item.kind === 'sequence' ? '' : item.coverUrl,
                      earoneSongId: item.kind === 'sequence' ? '' : item.earoneSongId,
                      earoneRank: item.kind === 'sequence' ? '' : item.earoneRank,
                      earoneSpins: item.kind === 'sequence' ? '' : item.earoneSpins
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
                  <div className='grid grid-cols-1 sm:grid-cols-3 gap-3'>
                    <label className='text-sm text-gray-700'>
                      <span className='block text-xs text-gray-500 mb-1'>Artist</span>
                      <input
                        type='text'
                        value={item.artist}
                        onChange={(e) =>
                          updateItem(index, {
                            ...item,
                            artist: e.target.value
                          })
                        }
                        className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                      />
                    </label>
                    <label className='text-sm text-gray-700'>
                      <span className='block text-xs text-gray-500 mb-1'>Title</span>
                      <input
                        type='text'
                        value={item.title}
                        onChange={(e) =>
                          updateItem(index, {
                            ...item,
                            title: e.target.value
                          })
                        }
                        className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                      />
                    </label>
                    <label className='text-sm text-gray-700'>
                      <span className='block text-xs text-gray-500 mb-1'>Cover URL</span>
                      <input
                        type='text'
                        value={item.coverUrl}
                        onChange={(e) =>
                          updateItem(index, {
                            ...item,
                            coverUrl: e.target.value
                          })
                        }
                        className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
                        placeholder='/cover.jpg'
                      />
                    </label>
                  </div>
                  <div className='grid grid-cols-1 sm:grid-cols-3 gap-3'>
                    <label className='text-sm text-gray-700'>
                      <span className='block text-xs text-gray-500 mb-1'>EarOne Song ID</span>
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
                        placeholder='Matches song.earoneSongId'
                      />
                    </label>
                    <label className='text-sm text-gray-700'>
                      <span className='block text-xs text-gray-500 mb-1'>EarOne Rank</span>
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
                        placeholder='Optional fallback'
                      />
                    </label>
                    <label className='text-sm text-gray-700'>
                      <span className='block text-xs text-gray-500 mb-1'>EarOne Spins</span>
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
                        placeholder='Optional fallback'
                      />
                    </label>
                  </div>
                </div>
              ) : (
                <div className='mt-3'>
                  <ModoItalianoSongSequenceEditor
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
