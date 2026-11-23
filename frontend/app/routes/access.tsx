import { SectionHeader } from '@gaulatti/bleecker';
import { useMemo } from 'react';
import { AccessPanel } from '../components/access/AccessPanel';
import { AppPage } from '../components/AppPage';
import { createAccessClient } from '../services/access';
import type { Route } from './+types/access';

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Access - Alcántara' }, { name: 'description', content: 'Manage who can use Alcántara and with which tokens' }];
}

// Pompeii's application slug for Alcántara; its manage key is alcantara:access:manage.
const APPLICATION = { key: 'alcantara', name: 'Alcántara' } as const;

export default function AccessRoute() {
  const client = useMemo(() => createAccessClient(), []);
  return (
    <AppPage>
      <SectionHeader eyebrow='Account' title='Access' description='Your tokens, and who can use Alcántara. Pompeii keeps everything and makes every decision.' />
      <AccessPanel client={client} application={APPLICATION} />
    </AppPage>
  );
}
