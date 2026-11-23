import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { AccessPanel } from '../components/access/AccessPanel';
import { memoryAccessClient } from '../components/access/accessFixtures';

const states = new Set(['manager', 'member', 'unavailable']);

// The Access panel with fictional data, one state per ?state=: a manager (all
// four sections), a member (My tokens and History only), and Pompeii's access
// service not available yet.
export default function AccessFixture() {
  const [params] = useSearchParams();
  const requested = params.get('state') ?? '';
  const state = states.has(requested) ? requested : 'manager';
  const client = useMemo(() => memoryAccessClient({ manager: state === 'manager', unavailable: state === 'unavailable' }), [state]);
  return (
    <main className='min-h-screen broadcast-console bg-dark-sand p-6 text-text-primary' data-visual-fixture={state}>
      <h1 className='mb-3 text-lg font-semibold'>Access</h1>
      <AccessPanel key={state} client={client} application={{ key: 'alcantara', name: 'Alcántara' }} />
    </main>
  );
}
