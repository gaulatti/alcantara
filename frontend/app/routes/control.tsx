import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Kbd, Modal, SectionHeader, Select, Switch } from '@gaulatti/bleecker';
import { GripVertical } from 'lucide-react';
import type { Route } from './+types/control';
import { apiUrl } from '../utils/apiBaseUrl';
import { uploadFileToMediaBucket } from '../services/uploads';
import { useGlobalProgramId } from '../utils/globalProgram';
import { useGlobalTransitionId } from '../utils/globalTransition';
import { getTimezonesSortedByOffset, getTimezoneOptionLabel } from '../utils/timezones';
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
  getModoItalianoSongSequenceSelectedItemId,
  getModoItalianoTextSequenceSelectedItemId,
  normalizeModoItalianoSongSequence,
  normalizeModoItalianoTextSequence,
  resolveModoItalianoSongLeaf,
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

interface InstantItem {
  id: number;
  name: string;
  audioUrl: string;
  volume: number;
  enabled: boolean;
  position: number;
}

interface InstantPlaybackState {
  startedAtMs: number;
  endsAtMs: number | null;
}

interface SongCatalogItem {
  id: number;
  artist: string;
  title: string;
  audioUrl: string;
  coverUrl: string | null;
  durationMs: number | null;
  earoneSongId: string | null;
  earoneRank: string | null;
  earoneSpins: string | null;
  enabled: boolean;
}

const INSTANT_PLAYBACK_SWEEP_ANIMATION = 'alcantaraInstantPlaybackSweep';
const INSTANT_PLAYBACK_PULSE_ANIMATION = 'alcantaraInstantPlaybackPulse';
const INSTANT_SHORTCUT_KEYS = 'qwertyuiopasdfghjklzxcvbnm';

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
    case 'slideshow':
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

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tagName = target.tagName;
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
}

function getInstantShortcutLetter(index: number): string | null {
  if (index < 0 || index >= INSTANT_SHORTCUT_KEYS.length) {
    return null;
  }

  return INSTANT_SHORTCUT_KEYS[index].toUpperCase();
}

function normalizeSlideshowImageList(value: unknown): string[] {
  const collected: string[] = [];
  const appendFromString = (raw: string) => {
    raw
      .split(/[\n,]/g)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .forEach((entry) => {
        collected.push(entry);
      });
  };

  if (Array.isArray(value)) {
    value.forEach((entry) => {
      if (typeof entry === 'string') {
        appendFromString(entry);
      }
    });
  } else if (typeof value === 'string') {
    appendFromString(value);
  }

  const seen = new Set<string>();
  return collected.filter((entry) => {
    if (seen.has(entry)) {
      return false;
    }
    seen.add(entry);
    return true;
  });
}

function SlideshowEditorFields({
  componentType,
  props,
  updateProp
}: {
  componentType: string;
  props: any;
  updateProp: (componentType: string, propName: string, value: any) => void;
}) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const images = normalizeSlideshowImageList(props.images);
  const asBoolean = (value: unknown, fallback: boolean) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
    }
    return fallback;
  };
  const setImages = (nextImages: string[]) => {
    updateProp(componentType, 'images', nextImages);
  };

  const uploadImages = async (files: File[]) => {
    if (!files.length) {
      return;
    }

    setUploadError('');
    setIsUploading(true);
    const nextImages = [...images];
    let failedUploads = 0;

    try {
      for (const file of files) {
        try {
          const upload = await uploadFileToMediaBucket('artwork', file);
          nextImages.push(upload.url);
        } catch (error) {
          failedUploads += 1;
          console.error('Failed to upload slideshow image:', error);
        }
      }

      setImages(nextImages);
      if (failedUploads > 0) {
        setUploadError(
          failedUploads === files.length
            ? 'Failed to upload selected image files.'
            : `Uploaded ${files.length - failedUploads} of ${files.length} images.`,
        );
      }
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className='space-y-3'>
      <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3'>
        <label className='text-sm text-gray-700'>
          <span className='block text-xs text-gray-500 mb-1'>Interval (ms)</span>
          <input
            type='number'
            min={1000}
            step={100}
            value={typeof props.intervalMs === 'number' ? props.intervalMs : 5000}
            onChange={(event) => updateProp(componentType, 'intervalMs', Math.max(1000, Number(event.target.value) || 5000))}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
          />
        </label>
        <label className='text-sm text-gray-700'>
          <span className='block text-xs text-gray-500 mb-1'>Transition (ms)</span>
          <input
            type='number'
            min={100}
            step={50}
            value={typeof props.transitionMs === 'number' ? props.transitionMs : 900}
            onChange={(event) => updateProp(componentType, 'transitionMs', Math.max(100, Number(event.target.value) || 900))}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
          />
        </label>
        <label className='text-sm text-gray-700'>
          <span className='block text-xs text-gray-500 mb-1'>Fit Mode</span>
          <select
            value={props.fitMode === 'contain' ? 'contain' : 'cover'}
            onChange={(event) => updateProp(componentType, 'fitMode', event.target.value)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-green-500'
          >
            <option value='cover'>Cover</option>
            <option value='contain'>Contain</option>
          </select>
        </label>
        <div className='flex flex-col justify-end gap-2 pb-1'>
          <label className='flex items-center gap-2 text-sm text-gray-700'>
            <input
              type='checkbox'
              checked={asBoolean(props.shuffle, false)}
              onChange={(event) => updateProp(componentType, 'shuffle', event.target.checked)}
              className='h-4 w-4'
            />
            Shuffle
          </label>
          <label className='flex items-center gap-2 text-sm text-gray-700'>
            <input
              type='checkbox'
              checked={asBoolean(props.kenBurns, true)}
              onChange={(event) => updateProp(componentType, 'kenBurns', event.target.checked)}
              className='h-4 w-4'
            />
            Ken Burns Motion
          </label>
        </div>
      </div>

      <div className='space-y-2'>
        <label className='block text-xs text-gray-600'>Upload images</label>
        <input
          type='file'
          accept='image/*'
          multiple
          disabled={isUploading}
          onChange={(event) => {
            const files = event.target.files ? Array.from(event.target.files) : [];
            event.target.value = '';
            void uploadImages(files);
          }}
          className='block w-full text-xs text-gray-500 file:mr-3 file:rounded file:border file:border-slate-300 file:bg-white file:px-2 file:py-1 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-100'
        />
        <p className='text-xs text-gray-500 mt-1'>1920x1080 images are recommended. Upload one or many files.</p>
        {isUploading ? <p className='text-xs text-gray-500'>Uploading image...</p> : null}
        {uploadError ? <p className='text-xs text-red-500'>{uploadError}</p> : null}
      </div>

      {images.length > 0 ? (
        <div className='grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2'>
          {images.map((url, index) => (
            <div key={`${url}_${index}`} className='rounded border border-slate-200 bg-white p-2 space-y-2'>
              <img src={url} alt={`Slideshow ${index + 1}`} className='h-20 w-full rounded object-cover bg-slate-100' />
              <button
                type='button'
                onClick={() => {
                  setImages(images.filter((_, imageIndex) => imageIndex !== index));
                }}
                className='w-full rounded border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50'
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

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
  const [activeProgramId] = useGlobalProgramId();
  const [programState, setProgramState] = useState<ProgramState | null>(null);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [instants, setInstants] = useState<InstantItem[]>([]);
  const [isLoadingInstants, setIsLoadingInstants] = useState(false);
  const [songCatalog, setSongCatalog] = useState<SongCatalogItem[]>([]);
  const [instantDurationsMs, setInstantDurationsMs] = useState<Record<number, number | null>>({});
  const [instantPlayback, setInstantPlayback] = useState<Record<number, InstantPlaybackState>>({});
  const instantDurationByUrlRef = useRef<Record<string, number | null>>({});
  const instantPlaybackTimeoutsRef = useRef<Record<number, number>>({});
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
  const [selectedTransitionId] = useGlobalTransitionId();

  useEffect(() => {
    fetchScenes();
    fetchLayouts();
    fetchComponentTypes();
    fetchSongCatalog();
  }, []);

  useEffect(() => {
    void fetchProgramState(activeProgramId);
    void fetchInstants();
    Object.values(instantPlaybackTimeoutsRef.current).forEach((timeoutId) => {
      window.clearTimeout(timeoutId);
    });
    instantPlaybackTimeoutsRef.current = {};
    setInstantPlayback({});
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

  const fetchInstants = async () => {
    try {
      setIsLoadingInstants(true);
      const res = await fetch(apiUrl('/instants'));
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as InstantItem[];
      setInstants(data);
    } catch (err) {
      console.error('Failed to fetch instants:', err);
      setInstants([]);
    } finally {
      setIsLoadingInstants(false);
    }
  };

  const fetchSongCatalog = async () => {
    try {
      const res = await fetch(apiUrl('/songs'));
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as SongCatalogItem[];
      setSongCatalog(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to fetch songs catalog:', err);
      setSongCatalog([]);
    }
  };

  const fetchProgramState = async (targetProgramId: string) => {
    try {
      const res = await fetch(apiUrl(`/program/${encodeURIComponent(targetProgramId)}/state`));
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = (await res.json()) as Partial<ProgramState> | null;
      const normalizedProgramState: ProgramState | null = data
        ? ({
            ...data,
            scenes: Array.isArray(data.scenes) ? data.scenes : [],
            activeSceneId: typeof data.activeSceneId === 'number' ? data.activeSceneId : null,
          } as ProgramState)
        : null;

      setProgramState(normalizedProgramState);
      setSelectedScene(normalizedProgramState?.activeSceneId ?? null);
    } catch (err) {
      console.error('Failed to fetch program state:', err);
      setProgramState(null);
      setSelectedScene(null);
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

  const assignedSceneEntries = useMemo(() => {
    if (!programState || !Array.isArray(programState.scenes)) {
      return [] as ProgramSceneEntry[];
    }
    return programState.scenes;
  }, [programState]);

  const assignedScenes = useMemo(() => {
    if (assignedSceneEntries.length === 0) {
      return [] as Scene[];
    }
    return assignedSceneEntries.map((entry) => entry.scene);
  }, [assignedSceneEntries]);

  const isSceneAssigned = (sceneId: number) => assignedSceneEntries.some((programScene) => programScene.sceneId === sceneId);

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

  const triggerInstant = async (instantId: number) => {
    try {
      const res = await fetch(apiUrl(`/instants/${instantId}/play`), {
        method: 'POST',
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const startedAtMs = Date.now();
      const durationMs = instantDurationsMs[instantId];
      const existingTimeoutId = instantPlaybackTimeoutsRef.current[instantId];
      if (existingTimeoutId !== undefined) {
        window.clearTimeout(existingTimeoutId);
        delete instantPlaybackTimeoutsRef.current[instantId];
      }
      setInstantPlayback((prev) => ({
        ...prev,
        [instantId]: {
          startedAtMs,
          endsAtMs: typeof durationMs === 'number' && durationMs > 0 ? startedAtMs + durationMs : null,
        },
      }));

      if (typeof durationMs === 'number' && durationMs > 0) {
        const timeoutId = window.setTimeout(() => {
          delete instantPlaybackTimeoutsRef.current[instantId];
          setInstantPlayback((prev) => {
            if (!prev[instantId]) {
              return prev;
            }
            const next = { ...prev };
            delete next[instantId];
            return next;
          });
        }, durationMs);
        instantPlaybackTimeoutsRef.current[instantId] = timeoutId;
      }
    } catch (err) {
      console.error('Failed to trigger instant:', err);
    }
  };

  const stopAllInstants = async () => {
    try {
      const res = await fetch(apiUrl('/instants/stop-all'), {
        method: 'POST',
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      Object.values(instantPlaybackTimeoutsRef.current).forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      instantPlaybackTimeoutsRef.current = {};
      setInstantPlayback({});
    } catch (err) {
      console.error('Failed to stop all instants:', err);
    }
  };

  useEffect(() => {
    const instantIds = new Set(instants.map((instant) => instant.id));
    setInstantDurationsMs((prev) => {
      let changed = false;
      const next: Record<number, number | null> = {};

      for (const [key, value] of Object.entries(prev)) {
        const id = Number(key);
        if (instantIds.has(id)) {
          next[id] = value;
        } else {
          changed = true;
        }
      }

      return changed ? next : prev;
    });

    setInstantPlayback((prev) => {
      let changed = false;
      const next: Record<number, InstantPlaybackState> = {};

      for (const [key, value] of Object.entries(prev)) {
        const id = Number(key);
        if (instantIds.has(id)) {
          next[id] = value;
        } else {
          changed = true;
        }
      }

      return changed ? next : prev;
    });

    const currentTimeouts = instantPlaybackTimeoutsRef.current;
    for (const key of Object.keys(currentTimeouts)) {
      const id = Number(key);
      if (!instantIds.has(id)) {
        window.clearTimeout(currentTimeouts[id]);
        delete currentTimeouts[id];
      }
    }
  }, [instants]);

  useEffect(() => {
    let cancelled = false;

    const loadDurationForInstant = (instant: InstantItem) => {
      if (!instant.audioUrl) {
        return;
      }

      const cachedDuration = instantDurationByUrlRef.current[instant.audioUrl];
      if (cachedDuration !== undefined) {
        setInstantDurationsMs((prev) =>
          prev[instant.id] === cachedDuration ? prev : { ...prev, [instant.id]: cachedDuration },
        );
        return;
      }

      const audio = new Audio();
      const cleanup = () => {
        audio.onloadedmetadata = null;
        audio.onerror = null;
        audio.src = '';
      };

      audio.preload = 'metadata';
      audio.onloadedmetadata = () => {
        const seconds = Number(audio.duration);
        const durationMs = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
        instantDurationByUrlRef.current[instant.audioUrl] = durationMs;

        if (!cancelled) {
          setInstantDurationsMs((prev) => ({
            ...prev,
            [instant.id]: durationMs,
          }));
        }

        cleanup();
      };

      audio.onerror = () => {
        instantDurationByUrlRef.current[instant.audioUrl] = null;
        if (!cancelled) {
          setInstantDurationsMs((prev) => ({
            ...prev,
            [instant.id]: null,
          }));
        }
        cleanup();
      };

      audio.src = instant.audioUrl;
      audio.load();
    };

    for (const instant of instants) {
      loadDurationForInstant(instant);
    }

    return () => {
      cancelled = true;
    };
  }, [instants]);

  useEffect(() => {
    return () => {
      Object.values(instantPlaybackTimeoutsRef.current).forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      instantPlaybackTimeoutsRef.current = {};
    };
  }, []);

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
      case 'slideshow':
        return {
          images: [],
          intervalMs: 5000,
          transitionMs: 900,
          shuffle: false,
          fitMode: 'cover',
          kenBurns: true
        };
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
          songSequence: createModoItalianoSongSequence('manual')
        };
      case 'modoitaliano-chyron':
        return {
          show: true,
          textSequence: createModoItalianoTextSequence('manual', { includeMarquee: true }),
          ctaSequence: createModoItalianoTextSequence('manual')
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

  const deleteScene = async (id: number) => {
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

  useEffect(() => {
    let sceneHotkeyArmedUntil = 0;

    const handleSceneHotkey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();

      if (event.ctrlKey && key === 's') {
        event.preventDefault();
        sceneHotkeyArmedUntil = Date.now() + 1500;
        return;
      }

      if (isEditableTarget(event.target)) {
        return;
      }

      if (!event.ctrlKey) {
        return;
      }

      const match = event.code.match(/^Digit(\d)$/);
      if (match && Date.now() <= sceneHotkeyArmedUntil) {
        const pressedDigit = Number(match[1]);
        const shortcutIndex = pressedDigit === 0 ? 9 : pressedDigit - 1;
        const shortcutScene = assignedScenes[shortcutIndex];
        if (!shortcutScene) {
          return;
        }

        event.preventDefault();
        sceneHotkeyArmedUntil = 0;
        void activateScene(shortcutScene.id);
        return;
      }

      if (event.metaKey || event.altKey || event.shiftKey) {
        return;
      }

      if (!/^[a-z]$/.test(key)) {
        return;
      }

      const shortcutIndex = INSTANT_SHORTCUT_KEYS.indexOf(key);
      if (shortcutIndex === -1) {
        return;
      }
      const shortcutInstant = instants[shortcutIndex];
      if (!shortcutInstant || !shortcutInstant.enabled) {
        return;
      }

      event.preventDefault();
      void triggerInstant(shortcutInstant.id);
    };

    window.addEventListener('keydown', handleSceneHotkey);
    return () => {
      window.removeEventListener('keydown', handleSceneHotkey);
    };
  }, [assignedScenes, instants, activateScene, triggerInstant]);

  const editableSceneComponentEntries = Object.entries(sceneEditorProps).filter(
    ([componentType]) => componentType !== 'chyron' && hasConfigurableSceneAttributes(componentType)
  );
  const selectedSceneData = selectedScene ? assignedScenes.find((scene) => scene.id === selectedScene) ?? null : null;
  return (
    <div className='min-h-screen bg-light-sand p-6 dark:bg-deep-sea md:p-8'>
      <style>
        {`
          @keyframes ${INSTANT_PLAYBACK_SWEEP_ANIMATION} {
            0% { transform: scaleX(1); opacity: 0.26; }
            100% { transform: scaleX(0); opacity: 0.08; }
          }

          @keyframes ${INSTANT_PLAYBACK_PULSE_ANIMATION} {
            0% { opacity: 0.12; }
            50% { opacity: 0.22; }
            100% { opacity: 0.12; }
          }
        `}
      </style>
      <div className='mx-auto max-w-7xl space-y-6'>
        <SectionHeader title='Control' description='Take scenes live and edit scene attributes for the selected global program.' />

        <div className='space-y-6'>
          {/* Scenes Panel */}
          <Card className='space-y-4'>
            <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
              <h2 className='text-2xl font-semibold text-text-primary dark:text-text-primary'>Scenes</h2>
              <div className='flex flex-wrap items-center gap-2'>
                <Button size='sm' variant='secondary' onClick={() => window.location.assign('/scenes')}>
                  Manage Scenes
                </Button>
              </div>
            </div>
            <p className='flex items-center gap-2 text-xs text-text-secondary dark:text-text-secondary'>
              Hotkeys:
              <Kbd keys={['Ctrl', 'S']} />
              then
              <span>1-9 (0 for #10)</span>
            </p>
            {assignedScenes.length === 0 ? (
              <div className='py-8 text-center text-text-secondary dark:text-text-secondary'>No scenes assigned to this program.</div>
            ) : (
              <>
                <div className='overflow-x-auto'>
                  <div className='grid grid-flow-col auto-cols-[120px] grid-rows-1 gap-3 pb-1'>
                    {assignedScenes.map((scene, index) => {
                      const isActive = selectedScene === scene.id;

                      return (
                        <button
                          key={scene.id}
                          type='button'
                          onClick={() => {
                            void activateScene(scene.id);
                          }}
                          className={`relative aspect-square min-h-[120px] rounded-xl border p-3 text-left transition-colors ${
                            isActive
                              ? 'border-sea bg-sea/10 ring-2 ring-sea/20 dark:border-accent-blue dark:bg-accent-blue/10 dark:ring-accent-blue/20'
                              : 'border-sand/20 bg-white/80 hover:border-sea/40 dark:border-sand/40 dark:bg-dark-sand/60 dark:hover:border-accent-blue/50'
                          }`}
                          title={scene.name}
                        >
                          <span className='absolute left-2 top-2 inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-sea px-1 text-xs font-bold text-white dark:bg-accent-blue'>
                            {index + 1}
                          </span>
                          <div className='mt-6'>
                            <div className='line-clamp-2 text-sm font-semibold leading-tight text-text-primary dark:text-text-primary'>{scene.name}</div>
                            <div className='mt-1 line-clamp-1 text-xs text-text-secondary dark:text-text-secondary'>{scene.layout.name}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
                {selectedSceneData ? (
                  <p className='text-xs text-text-secondary dark:text-text-secondary'>
                    Active: <span className='font-semibold text-text-primary dark:text-text-primary'>{selectedSceneData.name}</span> · Text:{' '}
                    {getSceneSummaryText(selectedSceneData)}
                  </p>
                ) : null}
              </>
            )}
          </Card>

          {/* Scene Attributes Panel */}
          <Card className='space-y-4'>
            <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
              <h2 className='text-2xl font-semibold text-text-primary dark:text-text-primary'>Instants</h2>
              <div className='flex flex-wrap items-center gap-2'>
                <Button size='sm' variant='secondary' onClick={() => window.location.assign('/instants')}>
                  Manage Instants
                </Button>
                <Button size='sm' variant='secondary' onClick={() => void stopAllInstants()}>
                  Stop All
                </Button>
              </div>
            </div>
            <p className='flex items-center gap-2 text-xs text-text-secondary dark:text-text-secondary'>
              Hotkeys:
              <Kbd keys={['Ctrl', 'Q..M']} />
              <span>(QWERTY order, first 26 instants)</span>
            </p>
            {isLoadingInstants ? (
              <p className='text-sm text-text-secondary dark:text-text-secondary'>Loading instants...</p>
            ) : instants.length === 0 ? (
              <p className='text-sm text-text-secondary dark:text-text-secondary'>No instants in catalog. Create some in Instants.</p>
            ) : (
                <div className='overflow-x-auto'>
                  <div className='grid grid-flow-col auto-cols-[120px] grid-rows-1 gap-3 pb-1'>
                  {instants.map((instant, index) => {
                    const playbackState = instantPlayback[instant.id] ?? null;
                    const isPlaying = playbackState !== null;
                    const durationMs = instantDurationsMs[instant.id] ?? null;
                    const shortcutLetter = getInstantShortcutLetter(index);

                    return (
                      <button
                        key={instant.id}
                        type='button'
                        onClick={() => {
                          void triggerInstant(instant.id);
                        }}
                        disabled={!instant.enabled}
                        className={`relative aspect-square min-h-[120px] rounded-xl border p-3 text-left transition-colors ${
                          !instant.enabled
                            ? 'cursor-not-allowed border-sand/20 bg-sand/10 opacity-60 dark:border-sand/40 dark:bg-sand/10'
                            : isPlaying
                              ? 'border-sea bg-sea/10 ring-2 ring-sea/20 dark:border-accent-blue dark:bg-accent-blue/10 dark:ring-accent-blue/20'
                              : 'border-sand/20 bg-white/80 hover:border-sea/40 dark:border-sand/40 dark:bg-dark-sand/60 dark:hover:border-accent-blue/50'
                        }`}
                        title={instant.name}
                      >
                        <span className='absolute left-2 top-2 inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-sea px-1 text-xs font-bold text-white dark:bg-accent-blue'>
                          {shortcutLetter || index + 1}
                        </span>
                        <div className='mt-6'>
                          <div className='line-clamp-2 text-sm font-semibold leading-tight text-text-primary dark:text-text-primary'>{instant.name}</div>
                          <div className='mt-1 line-clamp-1 text-xs text-text-secondary dark:text-text-secondary'>Vol {instant.volume}</div>
                          {isPlaying ? (
                            <div className='mt-1 line-clamp-1 text-[11px] font-semibold text-sea dark:text-accent-blue'>
                              Playing
                            </div>
                          ) : durationMs !== null ? (
                            <div className='mt-1 line-clamp-1 text-[11px] text-text-secondary dark:text-text-secondary'>
                              {`Length ${Math.max(0.1, durationMs / 1000).toFixed(1)}s`}
                            </div>
                          ) : null}
                        </div>
                        {isPlaying ? (
                          <div className='pointer-events-none absolute inset-0 overflow-hidden rounded-xl'>
                            {playbackState && playbackState.endsAtMs !== null ? (
                              <div
                                key={`${instant.id}-${playbackState.startedAtMs}`}
                                className='absolute inset-0 origin-left bg-sea dark:bg-accent-blue'
                                style={{
                                  animation: `${INSTANT_PLAYBACK_SWEEP_ANIMATION} ${Math.max(200, playbackState.endsAtMs - playbackState.startedAtMs)}ms linear forwards`,
                                }}
                              />
                            ) : (
                              <div
                                className='absolute inset-0 bg-sea dark:bg-accent-blue'
                                style={{
                                  animation: `${INSTANT_PLAYBACK_PULSE_ANIMATION} 1400ms ease-in-out infinite`,
                                }}
                              />
                            )}
                          </div>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </Card>

          {/* Scene Attributes Panel */}
          <Card className='space-y-4'>
            <h2 className='text-2xl font-semibold text-text-primary dark:text-text-primary'>Edit Live Scene Attributes</h2>
            {!selectedScene ? (
              <p className='text-sm text-text-secondary dark:text-text-secondary'>Take a scene live above, then edit the attributes for that live scene.</p>
            ) : (
              <div className='space-y-4'>
                <p className='text-sm text-sea dark:text-accent-blue'>Editing scene: {scenes.find((s) => s.id === selectedScene)?.name}</p>
                {activeProgramId === 'fifthbell' && (
                  <p className='text-xs text-text-secondary dark:text-text-secondary'>
                    FifthBell runtime settings are stored per component metadata (`fifthbell-content`, `fifthbell-marquee`, `toni-clock`).
                  </p>
                )}
                <div className='space-y-4 rounded-xl border border-sand/20 p-4 dark:border-sand/40'>
                  {editableSceneComponentEntries.length === 0 && (
                    <p className='text-sm text-text-secondary dark:text-text-secondary'>No configurable component attributes for this scene.</p>
                  )}
                  {editableSceneComponentEntries.map(([componentType, props]) => {
                    const compInfo = componentTypes.find((ct) => ct.type === componentType);
                    return (
                      <div key={componentType} className='border-b border-sand/20 pb-4 last:border-b-0 dark:border-sand/40'>
                        <h4 className='mb-2 text-md font-semibold text-text-primary dark:text-text-primary'>{compInfo?.name || componentType}</h4>
                        <ComponentPropsFields
                          componentType={componentType}
                          props={props}
                          updateProp={updateSceneEditorProp}
                          replaceProps={replaceSceneEditorComponentProps}
                          commitProps={commitSceneEditorComponentProps}
                          songCatalog={songCatalog}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className='flex justify-end'>
                  <Button onClick={saveSceneAttributes} disabled={isSavingSceneAttributes}>
                    {isSavingSceneAttributes ? 'Saving...' : 'Save Scene Attributes'}
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function ComponentPropsFields({
  componentType,
  props,
  updateProp,
  replaceProps,
  commitProps,
  songCatalog
}: {
  componentType: string;
  props: any;
  updateProp: (componentType: string, propName: string, value: any) => void;
  replaceProps: (componentType: string, nextProps: any) => void;
  commitProps?: (componentType: string, nextProps: any) => Promise<void> | void;
  songCatalog: SongCatalogItem[];
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
    case 'slideshow':
      return <SlideshowEditorFields componentType={componentType} props={props} updateProp={updateProp} />;
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
          songCatalog={songCatalog}
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

  const toSequenceItem = (item: ToniChyronSequenceItem): Extract<ToniChyronSequenceItem, { kind: 'sequence' }> => {
    if (item.kind === 'sequence') {
      return item;
    }

    const nextItem = createToniChyronSequenceItem('sequence');
    if (nextItem.kind !== 'sequence') {
      return {
        id: item.id,
        label: item.text.trim() || 'Sequence',
        kind: 'sequence',
        sequence: createToniChyronSequence('manual')
      };
    }

    const nestedFirstItem = nextItem.sequence.items[0];
    const nextLeaf =
      nestedFirstItem && nestedFirstItem.kind === 'preset'
        ? {
            ...nestedFirstItem,
            text: item.text,
            useMarquee: item.useMarquee,
            earoneSongId: item.earoneSongId,
            earoneRank: item.earoneRank,
            earoneSpins: item.earoneSpins
          }
        : createToniChyronSequenceItem('preset');

    return {
      ...nextItem,
      id: item.id,
      label: item.text.trim() || 'Sequence',
      sequence: {
        ...nextItem.sequence,
        items: [nextLeaf],
        activeItemId: nextLeaf.id
      }
    };
  };

  const addItem = () => {
    const nextItem = createToniChyronSequenceItem('sequence');
    if (nextItem.kind !== 'sequence') {
      return;
    }

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

  const applySequenceAndTakeSelection = async (nextSequence: ModoItalianoTextSequence) => {
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
          onClick={() => {
            void applySequenceAndTakeSelection({
              ...sequence,
              mode: 'manual',
              activeItemId: sequence.mode === 'autoplay' ? (effectiveActiveItemId ?? sequence.activeItemId) : sequence.activeItemId,
              startedAt: Date.now()
            });
          }}
          className={`px-2.5 py-1 rounded text-xs font-medium border ${
            sequence.mode === 'manual' ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
          }`}
        >
          Manual
        </button>
        <button
          type='button'
          onClick={() => {
            void applySequenceAndTakeSelection({
              ...sequence,
              mode: 'autoplay',
              startedAt: Date.now()
            });
          }}
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
              onChange={(e) => {
                void applySequenceAndTakeSelection({
                  ...sequence,
                  intervalMs: Math.max(500, Number(e.target.value) || 4000),
                  startedAt: Date.now()
                });
              }}
              className='w-28 px-2 py-1 text-xs border rounded focus:ring-2 focus:ring-green-500'
            />
            <label className='flex items-center gap-1 text-xs text-slate-600'>
              <input
                type='checkbox'
                checked={sequence.loop !== false}
                onChange={(e) => {
                  void applySequenceAndTakeSelection({
                    ...sequence,
                    loop: e.target.checked
                  });
                }}
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
          const displayItem = depth === 0 && item.kind === 'preset' ? toSequenceItem(item) : item;
          const isActive = displayItem.id === effectiveActiveItemId;
          return (
            <div
              key={displayItem.id}
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
                <div className='min-w-0 flex-1 text-xs font-medium uppercase tracking-wide text-slate-500'>
                  {displayItem.kind === 'sequence' ? 'Nested Sequence' : 'Sequence Item'}
                </div>
                <button
                  type='button'
                  onClick={() => {
                    void activateItem(displayItem.id);
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

              {displayItem.kind === 'preset' ? (
                <div className='mt-3 space-y-2'>
                  <div>
                    <label className='block text-xs text-gray-600 mb-1'>Text</label>
                    <input
                      type='text'
                      value={displayItem.text}
                      onChange={(e) =>
                        updateItem(index, {
                          ...displayItem,
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
                        value={displayItem.earoneSongId || ''}
                        onChange={(e) =>
                          updateItem(index, {
                            ...displayItem,
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
                        value={displayItem.earoneRank || ''}
                        onChange={(e) =>
                          updateItem(index, {
                            ...displayItem,
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
                        value={displayItem.earoneSpins || ''}
                        onChange={(e) =>
                          updateItem(index, {
                            ...displayItem,
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
                      checked={Boolean(displayItem.useMarquee)}
                      onChange={(e) =>
                        updateItem(index, {
                          ...displayItem,
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
                    sequence={displayItem.sequence}
                    depth={depth + 1}
                    onChange={(nextNestedSequence) =>
                      updateItem(index, {
                        ...displayItem,
                        sequence: nextNestedSequence
                      })
                    }
                    onTakeSelection={async (nextNestedSequence) => {
                      const nextSequence = {
                        ...sequence,
                        items: sequence.items.map((entry, sequenceIndex) =>
                          sequenceIndex === index
                            ? {
                                ...displayItem,
                                sequence: nextNestedSequence
                              }
                            : entry
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
          onClick={addItem}
          className='px-3 py-2 text-xs font-semibold rounded border border-slate-300 text-slate-700 hover:bg-slate-100'
        >
          + Sequence
        </button>
      </div>
    </div>
  );
}

interface ModoItalianoSongDraft {
  artist: string;
  title: string;
  coverUrl: string;
  audioUrl: string;
  durationMs?: number;
  earoneSongId: string;
  earoneRank: string;
  earoneSpins: string;
}

interface ModoItalianoSongBulkImportDraft {
  artist: string;
  title: string;
  coverUrl: string;
}

function normalizeModoItalianoSongDraft(value: unknown): ModoItalianoSongDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const artist = typeof record.artist === 'string' ? record.artist.trim() : '';
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const coverUrl = typeof record.coverUrl === 'string' ? record.coverUrl.trim() : '';
  const audioUrl = typeof record.audioUrl === 'string' ? record.audioUrl.trim() : '';
  const durationMs =
    typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) && record.durationMs > 0
      ? Math.round(record.durationMs)
      : undefined;
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

  if (!artist && !title && !coverUrl && !audioUrl && !durationMs && !earoneSongId && !earoneRank && !earoneSpins) {
    return null;
  }

  return {
    artist,
    title,
    coverUrl,
    audioUrl,
    durationMs,
    earoneSongId,
    earoneRank,
    earoneSpins
  };
}

function normalizeModoItalianoSongBulkImportDraft(value: unknown): ModoItalianoSongBulkImportDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const artist = typeof record.artist === 'string' ? record.artist.trim() : '';
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const coverUrlRaw = typeof record.coverUrl === 'string' ? record.coverUrl : typeof record.cover_url === 'string' ? record.cover_url : '';
  const coverUrl = coverUrlRaw.trim();

  if (!artist && !title && !coverUrl) {
    return null;
  }

  return {
    artist,
    title,
    coverUrl
  };
}

function parseModoItalianoSongBulkImportJson(rawJson: string): ModoItalianoSongBulkImportDraft[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('Invalid JSON. Paste a valid JSON array of songs.');
  }

  const candidates = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).songs)
      ? ((parsed as Record<string, unknown>).songs as unknown[])
      : null;

  if (!candidates) {
    throw new Error('JSON must be an array or an object with a `songs` array.');
  }

  if (candidates.length === 0) {
    return [];
  }

  const importedSongs = candidates
    .map((entry) => normalizeModoItalianoSongBulkImportDraft(entry))
    .filter((entry): entry is ModoItalianoSongBulkImportDraft => entry !== null);

  if (importedSongs.length === 0) {
    throw new Error('No valid songs found. Each entry should include `artist`, `title`, and `coverUrl` or `cover_url`.');
  }

  return importedSongs;
}

function ModoItalianoClockEditorFields({
  componentType,
  props,
  updateProp,
  replaceProps,
  commitProps,
  songCatalog
}: {
  componentType: string;
  props: any;
  updateProp: (componentType: string, propName: string, value: any) => void;
  replaceProps: (componentType: string, nextProps: any) => void;
  commitProps?: (componentType: string, nextProps: any) => Promise<void> | void;
  songCatalog: SongCatalogItem[];
}) {
  const normalizedSequence = normalizeModoItalianoSongSequence(props.songSequence);
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

  const sequenceHasSongContent = (sequence: ModoItalianoSongSequence): boolean =>
    sequence.items.some((item) =>
      item.kind === 'sequence'
        ? sequenceHasSongContent(item.sequence)
        : Boolean(
            item.artist.trim() ||
              item.title.trim() ||
              item.coverUrl.trim() ||
              item.audioUrl?.trim() ||
              item.durationMs ||
              item.earoneSongId?.trim() ||
              item.earoneRank?.trim() ||
              item.earoneSpins?.trim(),
          ),
    );

  const sequenceForEditor = useMemo<ModoItalianoSongSequence>(() => {
    const baseSequence = normalizedSequence ?? createModoItalianoSongSequence('manual');
    if (!directSongFromFields && !directSongFromLegacyList) {
      return baseSequence;
    }
    if (sequenceHasSongContent(baseSequence)) {
      return baseSequence;
    }

    const legacySong = directSongFromFields ?? directSongFromLegacyList;
    if (!legacySong) {
      return baseSequence;
    }

    const firstItem = baseSequence.items[0];
    const fallbackItem = createModoItalianoSongSequenceItem('preset');
    const seededItem =
      firstItem && firstItem.kind === 'preset'
        ? {
            ...firstItem,
            artist: legacySong.artist,
            title: legacySong.title,
            coverUrl: legacySong.coverUrl,
            audioUrl: legacySong.audioUrl,
            durationMs: legacySong.durationMs,
            earoneSongId: legacySong.earoneSongId || '',
            earoneRank: legacySong.earoneRank || '',
            earoneSpins: legacySong.earoneSpins || '',
          }
        : {
            ...(fallbackItem.kind === 'preset' ? fallbackItem : createModoItalianoSongSequenceItem('preset')),
            artist: legacySong.artist,
            title: legacySong.title,
            coverUrl: legacySong.coverUrl,
            audioUrl: legacySong.audioUrl,
            durationMs: legacySong.durationMs,
            earoneSongId: legacySong.earoneSongId || '',
            earoneRank: legacySong.earoneRank || '',
            earoneSpins: legacySong.earoneSpins || '',
          };

    const nextItems = [...baseSequence.items];
    nextItems[0] = seededItem;

    return {
      ...baseSequence,
      items: nextItems,
      activeItemId: baseSequence.activeItemId ?? seededItem.id,
      startedAt: baseSequence.startedAt ?? Date.now(),
    };
  }, [normalizedSequence, directSongFromFields, directSongFromLegacyList]);

  const buildSequenceProps = (nextSequence: ModoItalianoSongSequence) => ({
    ...props,
    songSequence: nextSequence,
    songs: [],
    songArtist: '',
    songTitle: '',
    songCoverUrl: '',
    songEaroneSongId: '',
    songEaroneRank: '',
    songEaroneSpins: '',
  });

  const applyProps = (nextProps: any) => {
    replaceProps(componentType, nextProps);
  };

  const activateSequence = async (nextSequence: ModoItalianoSongSequence) => {
    const nextProps = buildSequenceProps(nextSequence);
    replaceProps(componentType, nextProps);
    if (commitProps) {
      await commitProps(componentType, nextProps);
    }
  };

  return (
    <div className='space-y-4'>
      <div className='space-y-2'>
        <p className='text-xs text-gray-500'>Songs are sequence-only. A single song is just a sequence with one item, selected from the global catalog.</p>
        <ModoItalianoSongSequenceEditor
          sequence={sequenceForEditor}
          songCatalog={songCatalog}
          onChange={(nextSequence) => applyProps(buildSequenceProps(nextSequence))}
          onTakeSelection={activateSequence}
        />
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
  const showValue =
    typeof props.show === 'boolean'
      ? props.show
      : typeof props.show === 'string'
        ? props.show.trim().toLowerCase() !== 'false'
        : true;
  const legacyMainText = typeof props.text === 'string' ? props.text : '';
  const legacyUseMarquee = Boolean(props.useMarquee);
  const legacyCtaText = typeof props.cta === 'string' ? props.cta : '';

  const sequenceHasText = (sequence: ModoItalianoTextSequence): boolean =>
    sequence.items.some((item) => (item.kind === 'sequence' ? sequenceHasText(item.sequence) : Boolean(item.text.trim())));

  const textSequenceForEditor = useMemo<ModoItalianoTextSequence>(() => {
    const baseSequence = normalizedTextSequence ?? createModoItalianoTextSequence('manual', { includeMarquee: true });
    if (!legacyMainText.trim() && !legacyUseMarquee) {
      return baseSequence;
    }
    if (sequenceHasText(baseSequence)) {
      return baseSequence;
    }

    const firstItem = baseSequence.items[0];
    const fallbackItem = createModoItalianoTextSequenceItem('preset', { includeMarquee: true });
    const seededItem =
      firstItem && firstItem.kind === 'preset'
        ? {
            ...firstItem,
            text: legacyMainText,
            useMarquee: legacyUseMarquee
          }
        : {
            ...(fallbackItem.kind === 'preset' ? fallbackItem : createModoItalianoTextSequenceItem('preset', { includeMarquee: true })),
            text: legacyMainText,
            useMarquee: legacyUseMarquee
          };

    const nextItems = [...baseSequence.items];
    nextItems[0] = seededItem;

    return {
      ...baseSequence,
      items: nextItems,
      activeItemId: baseSequence.activeItemId ?? seededItem.id,
      startedAt: baseSequence.startedAt ?? Date.now()
    };
  }, [normalizedTextSequence, legacyMainText, legacyUseMarquee]);

  const ctaSequenceForEditor = useMemo<ModoItalianoTextSequence>(() => {
    const baseSequence = normalizedCtaSequence ?? createModoItalianoTextSequence('manual');
    if (!legacyCtaText.trim()) {
      return baseSequence;
    }
    if (sequenceHasText(baseSequence)) {
      return baseSequence;
    }

    const firstItem = baseSequence.items[0];
    const fallbackItem = createModoItalianoTextSequenceItem('preset');
    const seededItem =
      firstItem && firstItem.kind === 'preset'
        ? {
            ...firstItem,
            text: legacyCtaText
          }
        : {
            ...(fallbackItem.kind === 'preset' ? fallbackItem : createModoItalianoTextSequenceItem('preset')),
            text: legacyCtaText
          };

    const nextItems = [...baseSequence.items];
    nextItems[0] = seededItem;

    return {
      ...baseSequence,
      items: nextItems,
      activeItemId: baseSequence.activeItemId ?? seededItem.id,
      startedAt: baseSequence.startedAt ?? Date.now()
    };
  }, [normalizedCtaSequence, legacyCtaText]);

  const buildSequenceProps = (nextTextSequence: ModoItalianoTextSequence, nextCtaSequence: ModoItalianoTextSequence) => ({
    ...props,
    textSequence: nextTextSequence,
    ctaSequence: nextCtaSequence,
    text: '',
    useMarquee: false,
    cta: ''
  });

  const applyProps = (nextProps: any) => {
    replaceProps(componentType, nextProps);
  };

  const activateTextSequence = async (nextSequence: ModoItalianoTextSequence) => {
    const nextProps = buildSequenceProps(nextSequence, ctaSequenceForEditor);
    replaceProps(componentType, nextProps);
    if (commitProps) {
      await commitProps(componentType, nextProps);
    }
  };

  const activateCtaSequence = async (nextSequence: ModoItalianoTextSequence) => {
    const nextProps = buildSequenceProps(textSequenceForEditor, nextSequence);
    replaceProps(componentType, nextProps);
    if (commitProps) {
      await commitProps(componentType, nextProps);
    }
  };

  return (
    <div className='space-y-4'>
      <p className='text-xs text-gray-500'>ModoItaliano row rule: if chyron and disclaimer are both enabled, chyron is shown.</p>
      <Switch checked={showValue} onCheckedChange={(checked) => updateProp(componentType, 'show', checked)} label='Show Chyron' />

      <div className='space-y-2 rounded border border-slate-200 p-3'>
        <span className='text-xs font-semibold uppercase tracking-wide text-slate-600'>Main Chyron</span>
        <div className='space-y-3'>
          <p className='text-xs text-gray-500'>Sequence-only. If no text item is selected, the chyron is hidden.</p>
          <ModoItalianoTextSequenceEditor
            sequence={textSequenceForEditor}
            includeMarquee
            textLabel='Text'
            textPlaceholder='Main chyron text'
            onChange={(nextSequence) => applyProps(buildSequenceProps(nextSequence, ctaSequenceForEditor))}
            onTakeSelection={activateTextSequence}
          />
        </div>
      </div>

      <div className='space-y-2 rounded border border-slate-200 p-3'>
        <span className='text-xs font-semibold uppercase tracking-wide text-slate-600'>CTA</span>
        <div className='space-y-3'>
          <p className='text-xs text-gray-500'>CTA is sequence-only as well.</p>
          <ModoItalianoTextSequenceEditor
            sequence={ctaSequenceForEditor}
            textLabel='CTA'
            textPlaceholder='Call to action (shown above chyron)'
            onChange={(nextSequence) => applyProps(buildSequenceProps(textSequenceForEditor, nextSequence))}
            onTakeSelection={activateCtaSequence}
          />
        </div>
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

  const toSequenceItem = (
    item: ModoItalianoTextSequenceItem
  ): Extract<ModoItalianoTextSequenceItem, { kind: 'sequence' }> => {
    if (item.kind === 'sequence') {
      return item;
    }

    const nextItem = createModoItalianoTextSequenceItem('sequence', { includeMarquee });
    if (nextItem.kind !== 'sequence') {
      return {
        id: item.id,
        label: item.text.trim() || 'Sequence',
        kind: 'sequence',
        sequence: createModoItalianoTextSequence('manual', { includeMarquee })
      };
    }

    const nestedFirstItem = nextItem.sequence.items[0];
    const nextLeaf =
      nestedFirstItem && nestedFirstItem.kind === 'preset'
        ? {
            ...nestedFirstItem,
            text: item.text,
            useMarquee: includeMarquee ? item.useMarquee : undefined
          }
        : createModoItalianoTextSequenceItem('preset', { includeMarquee });

    return {
      ...nextItem,
      id: item.id,
      label: item.text.trim() || 'Sequence',
      sequence: {
        ...nextItem.sequence,
        items: [nextLeaf],
        activeItemId: nextLeaf.id
      }
    };
  };

  const addItem = () => {
    const nextItem = createModoItalianoTextSequenceItem('sequence', { includeMarquee });
    if (nextItem.kind !== 'sequence') {
      return;
    }

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
          const displayItem = depth === 0 && item.kind === 'preset' ? toSequenceItem(item) : item;
          const isActive = displayItem.id === effectiveActiveItemId;
          return (
            <div
              key={displayItem.id}
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
                <div className='min-w-0 flex-1 text-xs font-medium uppercase tracking-wide text-slate-500'>
                  {displayItem.kind === 'sequence' ? 'Nested Sequence' : 'Sequence Item'}
                </div>
                <button
                  type='button'
                  onClick={() => {
                    void activateItem(displayItem.id);
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

              {displayItem.kind === 'preset' ? (
                <div className='mt-3 space-y-2'>
                  <label className='text-sm text-gray-700 block'>
                    <span className='block text-xs text-gray-500 mb-1'>{textLabel}</span>
                    <input
                      type='text'
                      value={displayItem.text}
                      onChange={(e) =>
                        updateItem(index, {
                          ...displayItem,
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
                        checked={Boolean(displayItem.useMarquee)}
                        onChange={(e) =>
                          updateItem(index, {
                            ...displayItem,
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
                    sequence={displayItem.sequence}
                    depth={depth + 1}
                    includeMarquee={includeMarquee}
                    textLabel={textLabel}
                    textPlaceholder={textPlaceholder}
                    onChange={(nextNestedSequence) =>
                      updateItem(index, {
                        ...displayItem,
                        sequence: nextNestedSequence
                      })
                    }
                    onTakeSelection={async (nextNestedSequence) => {
                      const nextSequence = {
                        ...sequence,
                        items: sequence.items.map((entry, sequenceIndex) =>
                          sequenceIndex === index
                            ? {
                                ...displayItem,
                                sequence: nextNestedSequence
                              }
                            : entry
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
          onClick={addItem}
          className='px-3 py-2 text-xs font-semibold rounded border border-slate-300 text-slate-700 hover:bg-slate-100'
        >
          + Sequence
        </button>
      </div>
    </div>
  );
}

function ModoItalianoSongSequenceEditor({
  sequence,
  songCatalog = [],
  onChange,
  onTakeSelection,
  depth = 0
}: {
  sequence: ModoItalianoSongSequence;
  songCatalog?: SongCatalogItem[];
  onChange: (nextSequence: ModoItalianoSongSequence) => void;
  onTakeSelection?: (nextSequence: ModoItalianoSongSequence) => Promise<void> | void;
  depth?: number;
}) {
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [bulkImportJson, setBulkImportJson] = useState('');
  const [bulkImportError, setBulkImportError] = useState('');
  const [bulkImportStatus, setBulkImportStatus] = useState('');
  const [showBulkImportModal, setShowBulkImportModal] = useState(false);
  const [bulkImportFileMode, setBulkImportFileMode] = useState<'append' | 'replace'>('append');
  const songDurationByUrlRef = useRef<Record<string, number | null>>({});
  const autoTakeOffTimerRef = useRef<number | null>(null);
  const sequenceRef = useRef(sequence);
  const bulkImportFileInputRef = useRef<HTMLInputElement>(null);
  const isNested = depth > 0;
  const effectiveActiveItemId = getModoItalianoSongSequenceSelectedItemId(sequence, nowMs);
  const availableSongCatalog = useMemo(
    () =>
      songCatalog
        .filter((song) => song.enabled && typeof song.audioUrl === 'string' && song.audioUrl.trim().length > 0)
        .sort((a, b) => {
          const aTitle = [a.artist, a.title].filter(Boolean).join(' - ').toLowerCase();
          const bTitle = [b.artist, b.title].filter(Boolean).join(' - ').toLowerCase();
          return aTitle.localeCompare(bTitle);
        }),
    [songCatalog],
  );
  const catalogOptions = useMemo(
    () =>
      availableSongCatalog.map((song) => ({
        value: String(song.id),
        label: [song.artist, song.title].filter(Boolean).join(' - ') || `Song #${song.id}`,
      })),
    [availableSongCatalog],
  );

  useEffect(() => {
    sequenceRef.current = sequence;
  }, [sequence]);

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
        nextSequence.activeItemId === null
          ? null
          : nextSequence.activeItemId && nextSequence.items.some((item) => item.id === nextSequence.activeItemId)
          ? nextSequence.activeItemId
          : (nextSequence.items[0]?.id ?? null)
    });
  };

  const clearAutoTakeOffTimer = () => {
    if (autoTakeOffTimerRef.current !== null) {
      window.clearTimeout(autoTakeOffTimerRef.current);
      autoTakeOffTimerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      clearAutoTakeOffTimer();
    };
  }, []);

  useEffect(() => {
    if (sequence.mode !== 'manual' || sequence.activeItemId === null) {
      clearAutoTakeOffTimer();
    }
  }, [sequence.mode, sequence.activeItemId]);

  const updateItem = (index: number, nextItem: ModoItalianoSongSequenceItem) => {
    const nextItems = sequence.items.map((item, itemIndex) => (itemIndex === index ? nextItem : item));
    applySequence({
      ...sequence,
      items: nextItems
    });
  };

  const toSequenceItem = (
    item: ModoItalianoSongSequenceItem
  ): Extract<ModoItalianoSongSequenceItem, { kind: 'sequence' }> => {
    if (item.kind === 'sequence') {
      return item;
    }

    const nextItem = createModoItalianoSongSequenceItem('sequence');
    if (nextItem.kind !== 'sequence') {
      return {
        id: item.id,
        label: [item.artist, item.title].filter(Boolean).join(' - ') || 'Sequence',
        kind: 'sequence',
        sequence: createModoItalianoSongSequence('manual')
      };
    }

    const nestedFirstItem = nextItem.sequence.items[0];
    const nextLeaf =
      nestedFirstItem && nestedFirstItem.kind === 'preset'
        ? {
            ...nestedFirstItem,
            artist: item.artist,
            title: item.title,
            coverUrl: item.coverUrl,
            audioUrl: item.audioUrl,
            durationMs: item.durationMs,
            earoneSongId: item.earoneSongId,
            earoneRank: item.earoneRank,
            earoneSpins: item.earoneSpins
          }
        : createModoItalianoSongSequenceItem('preset');

    return {
      ...nextItem,
      id: item.id,
      label: [item.artist, item.title].filter(Boolean).join(' - ') || 'Sequence',
      sequence: {
        ...nextItem.sequence,
        items: [nextLeaf],
        activeItemId: nextLeaf.id
      }
    };
  };

  const addItem = () => {
    const nextItem = createModoItalianoSongSequenceItem('sequence');
    if (nextItem.kind !== 'sequence') {
      return;
    }

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

  const scheduleAutoTakeOffForSequence = (nextSequence: ModoItalianoSongSequence) => {
    clearAutoTakeOffTimer();

    if (isNested || nextSequence.mode !== 'manual') {
      return;
    }

    const resolvedLeaf = resolveModoItalianoSongLeaf(
      { sequence: nextSequence },
      Date.now(),
    );
    const durationMs = resolvedLeaf?.durationMs;

    if (
      typeof durationMs !== 'number' ||
      !Number.isFinite(durationMs) ||
      durationMs <= 0
    ) {
      const fallbackAudioUrl = resolvedLeaf?.audioUrl?.trim();
      if (!fallbackAudioUrl) {
        return;
      }

      const cachedDuration = songDurationByUrlRef.current[fallbackAudioUrl];
      if (typeof cachedDuration === 'number' && Number.isFinite(cachedDuration) && cachedDuration > 0) {
        const fallbackSequenceWithDuration = {
          ...nextSequence,
          items: nextSequence.items,
        };
        const expectedActiveItemId = fallbackSequenceWithDuration.activeItemId ?? null;
        const expectedStartedAt =
          typeof fallbackSequenceWithDuration.startedAt === 'number' &&
          Number.isFinite(fallbackSequenceWithDuration.startedAt)
            ? fallbackSequenceWithDuration.startedAt
            : null;

        autoTakeOffTimerRef.current = window.setTimeout(() => {
          const currentSequence = sequenceRef.current;
          const currentStartedAt =
            typeof currentSequence.startedAt === 'number' &&
            Number.isFinite(currentSequence.startedAt)
              ? currentSequence.startedAt
              : null;
          if (currentSequence.activeItemId !== expectedActiveItemId) {
            return;
          }
          if (currentStartedAt !== expectedStartedAt) {
            return;
          }
          void clearActiveItem();
        }, Math.max(200, Math.round(cachedDuration)));
        return;
      }

      const audio = new Audio();
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => {
        const seconds = Number(audio.duration);
        audio.onloadedmetadata = null;
        audio.onerror = null;
        audio.src = '';
        const derivedDuration =
          Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.round(seconds * 1000)) : null;
        songDurationByUrlRef.current[fallbackAudioUrl] = derivedDuration;
        if (!derivedDuration) {
          return;
        }

        const expectedActiveItemId = nextSequence.activeItemId ?? null;
        const expectedStartedAt =
          typeof nextSequence.startedAt === 'number' && Number.isFinite(nextSequence.startedAt)
            ? nextSequence.startedAt
            : null;

        clearAutoTakeOffTimer();
        autoTakeOffTimerRef.current = window.setTimeout(() => {
          const currentSequence = sequenceRef.current;
          const currentStartedAt =
            typeof currentSequence.startedAt === 'number' && Number.isFinite(currentSequence.startedAt)
              ? currentSequence.startedAt
              : null;
          if (currentSequence.activeItemId !== expectedActiveItemId) {
            return;
          }
          if (currentStartedAt !== expectedStartedAt) {
            return;
          }
          void clearActiveItem();
        }, Math.max(200, derivedDuration));
      };
      audio.onerror = () => {
        audio.onloadedmetadata = null;
        audio.onerror = null;
        audio.src = '';
        songDurationByUrlRef.current[fallbackAudioUrl] = null;
      };
      audio.src = fallbackAudioUrl;
      audio.load();
      return;
    }

    const expectedActiveItemId = nextSequence.activeItemId ?? null;
    const expectedStartedAt =
      typeof nextSequence.startedAt === 'number' &&
      Number.isFinite(nextSequence.startedAt)
        ? nextSequence.startedAt
        : null;

    autoTakeOffTimerRef.current = window.setTimeout(() => {
      const currentSequence = sequenceRef.current;
      const currentStartedAt =
        typeof currentSequence.startedAt === 'number' &&
        Number.isFinite(currentSequence.startedAt)
          ? currentSequence.startedAt
          : null;

      if (currentSequence.activeItemId !== expectedActiveItemId) {
        return;
      }
      if (currentStartedAt !== expectedStartedAt) {
        return;
      }

      void clearActiveItem();
    }, Math.max(200, Math.round(durationMs)));
  };

  const activateItem = async (itemId: string) => {
    clearAutoTakeOffTimer();

    const nextSequence = {
      ...sequence,
      activeItemId: itemId,
      startedAt: Date.now()
    };
    applySequence(nextSequence);
    if (onTakeSelection) {
      await onTakeSelection(nextSequence);
    }
    scheduleAutoTakeOffForSequence(nextSequence);
  };

  const clearActiveItem = async () => {
    clearAutoTakeOffTimer();

    const nextSequence = {
      ...sequence,
      activeItemId: null,
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

  const importSongsFromPayload = (rawPayload: string, mode: 'append' | 'replace'): boolean => {
    const payload = rawPayload.trim();
    if (!payload) {
      setBulkImportStatus('');
      setBulkImportError('Paste a JSON payload first.');
      return false;
    }

    try {
      const importedSongs = parseModoItalianoSongBulkImportJson(payload);
      const importedItems = importedSongs.map((song) => {
        const nextItem = createModoItalianoSongSequenceItem('sequence');
        if (nextItem.kind !== 'sequence') {
          return {
            id: `song_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            label: [song.artist, song.title].filter(Boolean).join(' - ') || 'Sequence',
            kind: 'sequence' as const,
            sequence: createModoItalianoSongSequence('manual')
          };
        }

        const nestedFirstItem = nextItem.sequence.items[0];
        const nextLeaf =
          nestedFirstItem && nestedFirstItem.kind === 'preset'
            ? {
                ...nestedFirstItem,
                artist: song.artist,
                title: song.title,
                coverUrl: song.coverUrl
              }
            : createModoItalianoSongSequenceItem('preset');

        return {
          ...nextItem,
          label: [song.artist, song.title].filter(Boolean).join(' - ') || nextItem.label,
          sequence: {
            ...nextItem.sequence,
            items: [nextLeaf],
            activeItemId: nextLeaf.id
          }
        };
      });

      if (importedItems.length === 0) {
        if (mode === 'replace') {
          applySequence({
            ...sequence,
            items: [],
            activeItemId: null,
            startedAt: Date.now()
          });
          setBulkImportError('');
          setBulkImportStatus('Sequence cleared (import payload was empty).');
          return true;
        }

        setBulkImportError('');
        setBulkImportStatus('No songs found in payload. Nothing appended.');
        return true;
      }

      const nextItems = mode === 'replace' ? importedItems : [...sequence.items, ...importedItems];
      const nextActiveItemId =
        mode === 'replace'
          ? null
          : sequence.activeItemId && nextItems.some((item) => item.id === sequence.activeItemId)
            ? sequence.activeItemId
            : (nextItems[0]?.id ?? null);

      applySequence({
        ...sequence,
        items: nextItems,
        activeItemId: nextActiveItemId,
        startedAt: Date.now()
      });

      setBulkImportError('');
      setBulkImportStatus(
        `Imported ${importedItems.length} song${importedItems.length === 1 ? '' : 's'} (${mode === 'replace' ? 'replaced sequence and left off-air' : 'appended'}).`
      );
      return true;
    } catch (error) {
      setBulkImportStatus('');
      setBulkImportError(error instanceof Error ? error.message : 'Unable to import songs.');
      return false;
    }
  };

  const importSongsFromJson = (mode: 'append' | 'replace') => {
    const didImport = importSongsFromPayload(bulkImportJson, mode);
    if (didImport) {
      setShowBulkImportModal(false);
    }
  };

  const triggerFileImport = (mode: 'append' | 'replace') => {
    setBulkImportFileMode(mode);
    bulkImportFileInputRef.current?.click();
  };

  const applyCatalogSongToItem = (
    index: number,
    item: Extract<ModoItalianoSongSequenceItem, { kind: 'preset' }>,
    selectedSong: SongCatalogItem,
  ) => {
    updateItem(index, {
      ...item,
      artist: selectedSong.artist || item.artist,
      title: selectedSong.title || item.title,
      coverUrl: selectedSong.coverUrl || item.coverUrl,
      audioUrl: selectedSong.audioUrl || item.audioUrl,
      durationMs:
        typeof selectedSong.durationMs === 'number' && Number.isFinite(selectedSong.durationMs) && selectedSong.durationMs > 0
          ? Math.round(selectedSong.durationMs)
          : item.durationMs,
      earoneSongId: selectedSong.earoneSongId || item.earoneSongId,
      earoneRank: selectedSong.earoneRank || item.earoneRank,
      earoneSpins: selectedSong.earoneSpins || item.earoneSpins
    });
  };

  const formatDurationFromMs = (value: number | undefined): string => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return 'Unknown';
    }

    const totalSeconds = Math.max(1, Math.round(value / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
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
        <button
          type='button'
          onClick={() => {
            void clearActiveItem();
          }}
          className='px-2.5 py-1 rounded text-xs font-medium border bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
        >
          Take Off Air
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

      {!isNested && (
        <div className='rounded border border-dashed border-slate-300 bg-white/80 p-3 space-y-2'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <span className='text-xs font-semibold uppercase tracking-wide text-slate-600'>Bulk Songs</span>
            <span className='text-xs text-slate-500'>Fields: `artist`, `title`, `coverUrl` or `cover_url`</span>
          </div>
          <div className='flex flex-wrap gap-2'>
            <button
              type='button'
              onClick={() => setShowBulkImportModal(true)}
              className='px-3 py-2 text-xs font-semibold rounded border border-slate-300 text-slate-700 hover:bg-slate-100'
            >
              Paste JSON (Modal)
            </button>
            <button
              type='button'
              onClick={() => triggerFileImport('append')}
              className='px-3 py-2 text-xs font-semibold rounded border border-slate-300 text-slate-700 hover:bg-slate-100'
            >
              Import File + Append
            </button>
            <button
              type='button'
              onClick={() => triggerFileImport('replace')}
              className='px-3 py-2 text-xs font-semibold rounded border border-slate-300 text-slate-700 hover:bg-slate-100'
            >
              Import File + Replace
            </button>
          </div>
          <input
            ref={bulkImportFileInputRef}
            type='file'
            accept='.json,application/json,text/plain'
            className='hidden'
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) {
                return;
              }

              void file
                .text()
                .then((text) => {
                  setBulkImportJson(text);
                  const didImport = importSongsFromPayload(text, bulkImportFileMode);
                  if (!didImport) {
                    setShowBulkImportModal(true);
                  }
                })
                .catch((error) => {
                  console.error('Failed to read song import file:', error);
                  setBulkImportStatus('');
                  setBulkImportError('Unable to read file contents.');
                });
            }}
          />
          {bulkImportError && <p className='text-xs text-red-600'>{bulkImportError}</p>}
          {bulkImportStatus && <p className='text-xs text-green-700'>{bulkImportStatus}</p>}
        </div>
      )}

      {!isNested && (
        <Modal isOpen={showBulkImportModal} onClose={() => setShowBulkImportModal(false)} title='Bulk Songs JSON'>
          <div className='space-y-3'>
            <p className='text-xs text-slate-600'>Paste a JSON array (or an object with a songs array) with artist, title, and coverUrl/cover_url.</p>
            <textarea
              value={bulkImportJson}
              onChange={(e) => {
                setBulkImportJson(e.target.value);
                if (bulkImportError) {
                  setBulkImportError('');
                }
                if (bulkImportStatus) {
                  setBulkImportStatus('');
                }
              }}
              rows={10}
              className='w-full rounded border border-slate-300 px-3 py-2 text-xs font-mono focus:ring-2 focus:ring-green-500'
              placeholder={`[\n  { "artist": "Artist Name", "title": "Song Title", "coverUrl": "https://..." }\n]`}
            />
            <div className='flex flex-wrap justify-end gap-2'>
              <button
                type='button'
                onClick={() => setShowBulkImportModal(false)}
                className='px-3 py-2 text-xs font-semibold rounded border border-slate-300 text-slate-700 hover:bg-slate-100'
              >
                Cancel
              </button>
              <button
                type='button'
                onClick={() => importSongsFromJson('append')}
                className='px-3 py-2 text-xs font-semibold rounded border border-slate-300 text-slate-700 hover:bg-slate-100'
              >
                Import + Append
              </button>
              <button
                type='button'
                onClick={() => importSongsFromJson('replace')}
                className='px-3 py-2 text-xs font-semibold rounded border border-slate-300 text-slate-700 hover:bg-slate-100'
              >
                Import + Replace
              </button>
            </div>
            {bulkImportError && <p className='text-xs text-red-600'>{bulkImportError}</p>}
            {bulkImportStatus && <p className='text-xs text-green-700'>{bulkImportStatus}</p>}
          </div>
        </Modal>
      )}

      {sequence.items.length === 0 && <p className='text-xs text-slate-500'>This sequence is empty. Add items below.</p>}

      <div className='space-y-3'>
        {sequence.items.map((item, index) => {
          const displayItem = depth === 0 && item.kind === 'preset' ? toSequenceItem(item) : item;
          const isActive = displayItem.id === effectiveActiveItemId;

          return (
            <div
              key={displayItem.id}
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
                <div className='min-w-0 flex-1 text-xs font-medium uppercase tracking-wide text-slate-500'>
                  {displayItem.kind === 'sequence' ? 'Nested Sequence' : 'Song Item'}
                </div>
                <button
                  type='button'
                  onClick={() => {
                    void activateItem(displayItem.id);
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

              {displayItem.kind === 'preset' ? (() => {
                const selectedCatalogSong = availableSongCatalog.find((song) => {
                  if (displayItem.audioUrl && song.audioUrl === displayItem.audioUrl) {
                    return true;
                  }

                  const sameArtist = (song.artist || '').trim() === displayItem.artist.trim();
                  const sameTitle = (song.title || '').trim() === displayItem.title.trim();
                  const sameCover = (song.coverUrl || '').trim() === displayItem.coverUrl.trim();
                  return sameArtist && sameTitle && sameCover;
                });
                const selectedCatalogSongValue = selectedCatalogSong ? String(selectedCatalogSong.id) : '';

                return (
                <div className='mt-3 space-y-2'>
                  <div className='rounded border border-slate-200 bg-slate-50 p-3'>
                    <div className='mb-2 flex flex-wrap items-center justify-between gap-2'>
                      <span className='text-xs font-semibold uppercase tracking-wide text-slate-600'>Catalog</span>
                      <a
                        href='/songs'
                        className='text-xs font-medium text-blue-700 hover:underline'
                        target='_blank'
                        rel='noreferrer'
                      >
                        Manage Songs
                      </a>
                    </div>
                    <Select
                      className='mt-2'
                      value={selectedCatalogSongValue}
                      options={catalogOptions}
                      placeholder='Select song from global catalog...'
                      onChange={(value) => {
                        const songId = Number(value);
                        if (!Number.isFinite(songId) || songId <= 0) {
                          return;
                        }

                        const selectedSong = availableSongCatalog.find((song) => song.id === songId);
                        if (!selectedSong) {
                          return;
                        }

                        applyCatalogSongToItem(index, displayItem, selectedSong);
                      }}
                    />
                    <div className='mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4'>
                      <div className='rounded border border-slate-200 bg-white p-2'>
                        <span className='block text-[11px] uppercase tracking-wide text-slate-500'>Artist</span>
                        <span className='block truncate text-sm text-slate-800'>{displayItem.artist || '—'}</span>
                      </div>
                      <div className='rounded border border-slate-200 bg-white p-2'>
                        <span className='block text-[11px] uppercase tracking-wide text-slate-500'>Title</span>
                        <span className='block truncate text-sm text-slate-800'>{displayItem.title || '—'}</span>
                      </div>
                      <div className='rounded border border-slate-200 bg-white p-2'>
                        <span className='block text-[11px] uppercase tracking-wide text-slate-500'>Duration</span>
                        <span className='block truncate text-sm text-slate-800'>{formatDurationFromMs(displayItem.durationMs)}</span>
                      </div>
                      <div className='rounded border border-slate-200 bg-white p-2'>
                        <span className='block text-[11px] uppercase tracking-wide text-slate-500'>EarOne</span>
                        <span className='block truncate text-sm text-slate-800'>{displayItem.earoneSongId || '—'}</span>
                      </div>
                    </div>
                    {displayItem.audioUrl ? (
                      <p className='mt-2 truncate text-xs text-slate-600'>Audio URL: {displayItem.audioUrl}</p>
                    ) : (
                      <p className='mt-2 text-xs text-slate-500'>Select a song from catalog to assign audio and runtime.</p>
                    )}
                    {displayItem.coverUrl ? (
                      <p className='truncate text-xs text-slate-600'>Cover URL: {displayItem.coverUrl}</p>
                    ) : null}
                  </div>
                </div>
              );
              })() : (
                <div className='mt-3'>
                  <ModoItalianoSongSequenceEditor
                    sequence={displayItem.sequence}
                    songCatalog={songCatalog}
                    depth={depth + 1}
                    onChange={(nextNestedSequence) =>
                      updateItem(index, {
                        ...displayItem,
                        sequence: nextNestedSequence
                      })
                    }
                    onTakeSelection={async (nextNestedSequence) => {
                      const nextSequence = {
                        ...sequence,
                        items: sequence.items.map((entry, sequenceIndex) =>
                          sequenceIndex === index
                            ? {
                                ...displayItem,
                                sequence: nextNestedSequence
                              }
                            : entry
                        )
                      };
                      applySequence(nextSequence);
                      if (onTakeSelection) {
                        await onTakeSelection(nextSequence);
                      }
                      scheduleAutoTakeOffForSequence(nextSequence);
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
          onClick={addItem}
          className='px-3 py-2 text-xs font-semibold rounded border border-slate-300 text-slate-700 hover:bg-slate-100'
        >
          + Sequence
        </button>
      </div>
    </div>
  );
}
