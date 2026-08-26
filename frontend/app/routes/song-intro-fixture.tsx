import { Card, SectionHeader } from '@gaulatti/bleecker';
import { SongIntroField } from '../components/editors/SongIntroField';
import type { InstantItem } from '../models/broadcast';

const available: InstantItem = {
  id: 1,
  name: 'Morning voice segue',
  audioUrl: '/fifthbell/audio/pipes.ogg',
  volume: 0.72,
  enabled: true,
  position: 1,
  availableForSongIntro: true,
  assignedSongId: null
};
const assigned: InstantItem = {
  ...available,
  id: 2,
  name: 'Assigned voice segue',
  position: 2,
  availableForSongIntro: false,
  assignedSongId: 42
};

export default function SongIntroFixture() {
  const noop = () => undefined;
  const states = [
    { label: 'Unassigned', selected: '' },
    { label: 'Assigned', selected: '2', current: 2 },
    { label: 'Previewing', selected: '1', previewing: true },
    {
      label: 'Validation error',
      selected: '1',
      error: 'Instant is already assigned as a song intro'
    },
    { label: 'Removal', selected: '', current: 2 }
  ];

  return (
    <main className="min-h-screen space-y-5 bg-light-sand p-8 dark:bg-deep-sea">
      <SectionHeader title="Song intro editor fixtures" description="Unassigned, assigned, previewing, validation-error, and removal states." />
      <div className="grid gap-4 lg:grid-cols-2">
        {states.map((state) => (
          <Card key={state.label} className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-widest text-text-secondary">{state.label}</p>
            <SongIntroField
              instants={[available, assigned]}
              songId={42}
              selectedInstantId={state.selected}
              currentIntroInstantId={state.current}
              previewing={state.previewing}
              validationError={state.error}
              onChange={noop}
              onPreview={noop}
            />
          </Card>
        ))}
      </div>
    </main>
  );
}
