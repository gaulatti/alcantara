import { SectionHeader } from '@gaulatti/bleecker';
import { SongSimilarityPanel, type SongSimilarityFixtureData } from '../components/SongSimilarityPanel';

const coverage = {
  model: { name: 'discogs-effnet-bs64-1', version: '1', license: 'CC BY-NC-SA 4.0' },
  windowSeconds: 30,
  enabledSongs: 120,
  embeddedSongs: 96,
  missingSongs: 24
};
const decisions: SongSimilarityFixtureData['decisions'] = [
  {
    id: 2,
    mode: 'shadow',
    outcome: 'selected',
    createdAt: '2026-10-29T20:15:00Z',
    score: 0.912,
    current: { songId: 1, artist: 'Pino Daniele', title: 'Napule è' },
    proposed: { songId: 7, artist: 'Fabrizio De André', title: 'Creuza de mä' },
    played: { songId: 3, artist: 'Mina', title: 'Se telefonando' }
  },
  {
    id: 1,
    mode: 'shadow',
    outcome: 'fallback-no-embedding',
    createdAt: '2026-10-29T20:11:00Z',
    score: null,
    current: null,
    proposed: null,
    played: { songId: 1, artist: 'Pino Daniele', title: 'Napule è' }
  }
];
const settings = { similarityMode: 'shadow', similarityThreshold: 0.8, similarityWindowSeconds: 30, similarityPool: 'sequence' } as const;

const states: { label: string; data: SongSimilarityFixtureData }[] = [
  { label: 'Off, nothing analyzed', data: { settings: { ...settings, similarityMode: 'off' }, coverage: { ...coverage, embeddedSongs: 0, missingSongs: 120 }, decisions: [] } },
  { label: 'Shadow with decisions', data: { settings, coverage, decisions } },
  { label: 'On, whole-catalog fallback', data: { settings: { ...settings, similarityMode: 'on', similarityPool: 'catalog' }, coverage: { ...coverage, missingSongs: 0, embeddedSongs: 120 }, decisions, uploadSummary: '10 stored, 0 rejected.' } },
  { label: 'Upload rejected', data: { settings, coverage, decisions: [], error: 'opening: vector must have 1280 dimensions' } }
];

export default function SimilarityFixture() {
  return (
    <main className="min-h-screen space-y-5 bg-light-sand p-8 dark:bg-deep-sea">
      <SectionHeader title="Song similarity fixtures" description="Off, shadow with decisions, on with catalog fallback, and upload error states." />
      {states.map((state) => (
        <div key={state.label} className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-widest text-text-secondary">{state.label}</p>
          <SongSimilarityPanel programId="fixture" fixtureData={state.data} />
        </div>
      ))}
    </main>
  );
}
