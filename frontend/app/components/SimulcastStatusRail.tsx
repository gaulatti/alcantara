import { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../utils/apiBaseUrl';
import { palazzoReasonText } from '../utils/palazzoReason';

interface StreamStatus {
  running: boolean;
}

interface PalazzoStatus {
  connection?: string;
  degraded?: boolean;
  detail?: string | null;
  reason?: string | null;
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

  const reasonText = palazzoReasonText(palazzo?.reason);
  const radioHealthy = stream?.running === true && (palazzo?.connection === 'connected' || palazzo?.connection === 'polling') && palazzo?.degraded !== true;

  // Healthy radio says nothing: the line exists only for a problem, with the one place to fix it.
  if (radioHealthy) return null;
  return (
    <section aria-label='Simulcast output status' className='mx-3 mt-3 rounded-[var(--radius-ui)] border border-accent-yellow/40 bg-accent-yellow/10 px-3 py-2 text-sm font-semibold text-accent-yellow' title={palazzo?.detail ?? undefined}>
      Radio {reasonText || 'needs attention'} ·{' '}
      <a href='/radio-settings' className='underline'>
        Setup
      </a>
    </section>
  );
}
