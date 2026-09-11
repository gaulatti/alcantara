import { Button, StatusBadge } from '@gaulatti/bleecker';
import { Radio, Settings2, Tv, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../utils/apiBaseUrl';

interface StreamStatus {
  running: boolean;
}

interface PalazzoStatus {
  connection?: string;
  degraded?: boolean;
  detail?: string | null;
}

interface SimulcastStatusRailProps {
  programId: string;
}

export function SimulcastStatusRail({ programId }: SimulcastStatusRailProps) {
  const [stream, setStream] = useState<StreamStatus | null>(null);
  const [palazzo, setPalazzo] = useState<PalazzoStatus | null>(null);

  const refresh = useCallback(async () => {
    const [streamResult, palazzoResult] = await Promise.allSettled([
      fetch(apiUrl(`/radio/${encodeURIComponent(programId)}/status`)),
      fetch(apiUrl(`/radio/${encodeURIComponent(programId)}/palazzo-status`))
    ]);

    if (streamResult.status === 'fulfilled' && streamResult.value.ok) {
      setStream(await streamResult.value.json());
    } else {
      setStream(null);
    }

    if (palazzoResult.status === 'fulfilled' && palazzoResult.value.ok) {
      setPalazzo(await palazzoResult.value.json());
    } else {
      setPalazzo(null);
    }
  }, [programId]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 8_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const radioHealthy = stream?.running === true && (palazzo?.connection === 'connected' || palazzo?.connection === 'polling') && palazzo?.degraded !== true;

  return (
    <section aria-label='Simulcast output status' className='flex flex-wrap items-center gap-3 border-b border-border-subtle bg-surface-elevated px-3 py-2 text-xs'>
      <StatusBadge label='SIMULCAST' variant='info' />
      <span className='flex items-center gap-1.5 font-semibold text-text-primary'>
        <Tv className='h-3.5 w-3.5' aria-hidden='true' />
        TV scene controls
      </span>
      <span className='text-text-tertiary' aria-hidden='true'>
        +
      </span>
      <span className={`flex items-center gap-1.5 font-semibold ${radioHealthy ? 'text-success' : 'text-warning'}`} title={palazzo?.detail ?? undefined}>
        {radioHealthy ? <Radio className='h-3.5 w-3.5' aria-hidden='true' /> : <WifiOff className='h-3.5 w-3.5' aria-hidden='true' />}
        Radio {radioHealthy ? 'ready' : 'needs attention'}
      </span>
      <span className='min-w-[14rem] flex-1 text-text-secondary'>Scene actions affect TV. Songs and audio clips feed the shared program mix.</span>
      <Button as='a' href='/radio-settings' size='xs' variant='secondary'>
        <Settings2 className='h-3.5 w-3.5' aria-hidden='true' />
        Radio setup
      </Button>
    </section>
  );
}
