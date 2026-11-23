import { Button, SectionHeader } from '@gaulatti/bleecker';
import type { ColumnDef, SortState } from '@gaulatti/bleecker';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { EnabledPill, LibraryList, LibraryRowActions, VolumeCell } from '../components/library/LibraryList';
import type { LibraryStatus } from '../components/library/LibraryList';

interface Clip {
  id: number;
  position: number;
  name: string;
  volume: number;
  enabled: boolean;
}

const clips: Clip[] = [
  { id: 1, position: 1, name: 'Station ident', volume: 1, enabled: true },
  { id: 2, position: 2, name: 'Applause', volume: 0.8, enabled: false },
  { id: 3, position: 3, name: 'News sting', volume: 0.65, enabled: true }
];

const states = new Set<LibraryStatus | 'empty'>(['ready', 'loading', 'error', 'empty']);

// The shared library list with fictional audio clips, one state per ?state=:
// ready (default), loading, error and empty.
export default function LibraryFixture() {
  const [params] = useSearchParams();
  const requested = (params.get('state') ?? '') as LibraryStatus | 'empty';
  const state = states.has(requested) ? requested : 'ready';
  const [sort, setSort] = useState<SortState>({ field: 'position', order: 'asc' });
  const columns: ColumnDef<Clip>[] = [
    { key: 'position', header: '#', className: 'w-12 text-text-secondary' },
    { key: 'name', header: 'Name', className: 'font-medium text-text-primary' },
    { key: 'volume', header: 'Volume', align: 'right', cell: (clip) => <VolumeCell volume={clip.volume} /> },
    { key: 'enabled', header: 'Status', cell: (clip) => <EnabledPill enabled={clip.enabled} /> },
    {
      key: 'actions',
      header: '',
      sortable: false,
      cell: (clip) => (
        <LibraryRowActions
          name={clip.name}
          primary={{ label: 'Play', onSelect: () => undefined }}
          more={[{ label: 'Edit', onSelect: () => undefined }]}
          onDelete={() => undefined}
          deleteTitle={`Delete audio clip "${clip.name}"?`}
        />
      )
    }
  ];
  return (
    <main className='min-h-screen broadcast-console bg-dark-sand p-6 text-text-primary' data-visual-fixture={state}>
      <div className='mx-auto max-w-6xl space-y-6'>
        <SectionHeader title='Audio clips' description='Reusable sounders, bumpers, and instant audio for every broadcast mode.' />
        <LibraryList
          caption='Audio clips'
          columns={columns}
          data={state === 'empty' ? [] : clips}
          getRowKey={(clip) => String(clip.id)}
          status={state === 'empty' ? 'ready' : state}
          onRetry={() => undefined}
          errorTitle='Failed to load audio clips'
          empty={{ title: 'No audio clips yet', description: 'Create your first reusable sounder or bumper.', action: <Button>Create audio clip</Button> }}
          sort={sort}
          onSortChange={setSort}
          toolbar={
            <div className='flex items-center justify-between gap-3 border-b border-sand/20 pb-3 dark:border-white/10'>
              <p className='text-xs text-text-secondary'>Playback on the active program</p>
              <Button variant='destructive' size='sm'>
                Stop all
              </Button>
            </div>
          }
        />
      </div>
    </main>
  );
}
