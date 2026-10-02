import { Button, Checkbox } from '@gaulatti/bleecker';
import { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../utils/apiBaseUrl';
import type { SongCatalogItem } from '../models/broadcast';

interface RecoveryStatus {
  selectedSongIds: number[];
  preparedVersion: string | null;
  automation: {
    actualState: string;
    filler: { activeVersion: string | null; ready: boolean };
  } | null;
  connection: 'connected' | 'unavailable';
}

export function RecoveryPlaylistPanel({ programId }: { programId: string }) {
  const [songs, setSongs] = useState<SongCatalogItem[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [songResponse, statusResponse] = await Promise.all([
      fetch(apiUrl('/songs?page=1&limit=1000')),
      fetch(apiUrl(`/radio/${encodeURIComponent(programId)}/recovery`)),
    ]);
    if (!songResponse.ok) throw new Error('Catalog songs are unavailable.');
    const payload = await songResponse.json();
    setSongs(Array.isArray(payload.data) ? payload.data : []);
    if (!statusResponse.ok)
      throw new Error('Recovery configuration is unavailable.');
    const current = (await statusResponse.json()) as RecoveryStatus;
    setStatus(current);
    setSelected(current.selectedSongIds);
  }, [programId]);
  useEffect(() => {
    void load().catch((cause) =>
      setError(
        cause instanceof Error ? cause.message : 'Recovery status failed.',
      ),
    );
  }, [load]);

  const prepare = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        apiUrl(`/radio/${encodeURIComponent(programId)}/recovery/prepare`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ songIds: selected }),
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(
          typeof body.message === 'string'
            ? body.message
            : `Preparation failed (${response.status})`,
        );
      }
      setStatus(await response.json());
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Recovery preparation failed.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="rounded-[var(--radius-ui)] border border-sand/25 p-4 dark:border-white/10"
      aria-label="Recovery playlist"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-text-secondary">
            Output recovery
          </p>
          <h3 className="mt-1 text-lg font-semibold">
            Prepared local playlist
          </h3>
          <p className="mt-1 text-sm text-text-secondary">
            Palazzo downloads and verifies these songs before a session. It can
            play them locally if the live queue runs dry.
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-1 text-xs font-semibold ${status?.preparedVersion ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}
        >
          {status?.preparedVersion ? 'Prepared' : 'Not prepared'}
        </span>
      </div>
      {status?.connection === 'unavailable' ? (
        <p role="status" className="mt-3 text-xs text-amber-300">
          Palazzo is unavailable. The saved selection is shown; session
          readiness cannot be verified.
        </p>
      ) : status?.automation?.filler.activeVersion ? (
        <p className="mt-3 text-xs text-emerald-300">
          A recovery playlist is active in the current Palazzo session.
        </p>
      ) : null}
      <div className="mt-4 max-h-60 space-y-2 overflow-y-auto rounded-lg border border-border-subtle p-3">
        {songs.filter((song) => song.enabled).length ? (
          songs
            .filter((song) => song.enabled)
            .map((song) => (
              <Checkbox
                key={song.id}
                checked={selected.includes(song.id)}
                label={`${song.artist} — ${song.title}`}
                onChange={() =>
                  setSelected((current) =>
                    current.includes(song.id)
                      ? current.filter((id) => id !== song.id)
                      : [...current, song.id],
                  )
                }
              />
            ))
        ) : (
          <p className="text-sm text-text-secondary">
            No enabled catalog songs are available.
          </p>
        )}
      </div>
      {status?.preparedVersion &&
      JSON.stringify(selected) !== JSON.stringify(status.selectedSongIds) ? (
        <p className="mt-2 text-xs text-amber-300">
          Selection changed. Prepare it before starting a new session.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-300">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          type="button"
          onClick={() => void prepare()}
          disabled={busy || selected.length === 0 || selected.length > 100}
        >
          {busy ? 'Preparing in Palazzo…' : 'Prepare playlist'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            void load().catch((cause) =>
              setError(
                cause instanceof Error
                  ? cause.message
                  : 'Recovery status failed.',
              ),
            )
          }
          disabled={busy}
        >
          Refresh status
        </Button>
      </div>
    </section>
  );
}
