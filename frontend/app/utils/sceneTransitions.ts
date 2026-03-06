export type SceneTransitionId =
  | 'cut'
  | 'crescendo-prism'
  | 'velvet-eclipse'
  | 'breaking-radar'
  | 'anchor-desk'
  | 'election-wall'
  | 'market-pulse'
  | 'world-desk'
  | 'festival-runway'
  | 'hit-parade';

export interface SceneTransitionPreset {
  id: SceneTransitionId;
  name: string;
  description: string;
  durationMs: number;
  cutPointMs: number;
}

const SCENE_TRANSITION_REGISTRY: Record<SceneTransitionId, SceneTransitionPreset> = {
  cut: {
    id: 'cut',
    name: 'Cut',
    description: 'Immediate hard cut with no animated stinger.',
    durationMs: 0,
    cutPointMs: 0
  },
  'crescendo-prism': {
    id: 'crescendo-prism',
    name: 'Crescendo Prism',
    description: 'Layered glass prisms, gold flash spine, and stage-light glints for premium music-broadcast scene takes.',
    durationMs: 1450,
    cutPointMs: 760
  },
  'velvet-eclipse': {
    id: 'velvet-eclipse',
    name: 'Velvet Eclipse',
    description: 'A high-drama iris eclipse with champagne rings, satin shadows, and concert-light sweeps for richer scene handoffs.',
    durationMs: 1680,
    cutPointMs: 880
  },
  'breaking-radar': {
    id: 'breaking-radar',
    name: 'Breaking Radar',
    description: 'High-urgency newsroom take with sweeping radar arcs, scanlines, red alert panels, and a hard white flash cut.',
    durationMs: 1320,
    cutPointMs: 640
  },
  'anchor-desk': {
    id: 'anchor-desk',
    name: 'Anchor Desk',
    description: 'Cold studio glass transition with blue-white bands, lens flares, and precision panel wipes for main newscast scene changes.',
    durationMs: 1540,
    cutPointMs: 780
  },
  'election-wall': {
    id: 'election-wall',
    name: 'Election Wall',
    description: 'Layered result columns, illuminated data grids, and crisp slate shutters for editorial or election-night style scene changes.',
    durationMs: 1480,
    cutPointMs: 730
  },
  'market-pulse': {
    id: 'market-pulse',
    name: 'Market Pulse',
    description: 'Financial desk transition with ticker ribbons, chart spikes, and a bright center pulse for business-news scene takes.',
    durationMs: 1380,
    cutPointMs: 690
  },
  'world-desk': {
    id: 'world-desk',
    name: 'World Desk',
    description: 'Orbital rings, meridian scans, and deep blue data panels for global-news or international coverage handoffs.',
    durationMs: 1600,
    cutPointMs: 810
  },
  'festival-runway': {
    id: 'festival-runway',
    name: 'Festival Runway',
    description: 'High-gloss LED lane transition with paparazzi flashes and magenta-amber light blades for Italian pop show scene takes.',
    durationMs: 1500,
    cutPointMs: 760
  },
  'hit-parade': {
    id: 'hit-parade',
    name: 'Hit Parade',
    description: 'Chrome marquee bars, electric color blocks, and stage-flash reveals for chart-show and entertainment segments.',
    durationMs: 1420,
    cutPointMs: 710
  }
};

export const SCENE_TRANSITIONS = Object.values(SCENE_TRANSITION_REGISTRY);

export function getSceneTransitionPreset(id?: string | null): SceneTransitionPreset {
  if (!id) {
    return SCENE_TRANSITION_REGISTRY.cut;
  }

  const normalized = id.trim() as SceneTransitionId;
  if (normalized in SCENE_TRANSITION_REGISTRY) {
    return SCENE_TRANSITION_REGISTRY[normalized];
  }

  return SCENE_TRANSITION_REGISTRY.cut;
}
