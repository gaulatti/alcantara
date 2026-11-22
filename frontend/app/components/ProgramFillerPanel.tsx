import { Button, Checkbox, Input, Select } from '@gaulatti/bleecker';
import axios from 'axios';
import { useCallback, useEffect, useState } from 'react';
import { api, handleApiError } from '../services/api';
import type {
  FillerLegName,
  FillerVersionSummary,
  ProgramFillerState,
} from '../models/filler';

/** The fields of a media library row this panel reads. */
interface MediaAssetOption {
  id: string;
  name: string;
  mediaType: 'IMAGE' | 'AUDIO' | 'VIDEO' | null;
  enabled: boolean;
}

const LEG_TITLES: Record<FillerLegName, string> = {
  television: 'Television filler',
  radio: 'Radio filler',
};

/** A server message for the operator, or the shared fallback. */
function failureMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const message = (error.response?.data as { message?: unknown } | undefined)
      ?.message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return handleApiError(error);
}

/** A name as the search compares it: without accents, case or surrounding space. */
function foldForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .trim();
}

function shortChecksum(value: string): string {
  return value.slice(0, 12);
}

function VersionSummary({
  label,
  version,
  names,
}: {
  label: string;
  version: FillerVersionSummary | null;
  names: Map<string, string>;
}) {
  return (
    <div className="rounded-lg border border-border-subtle p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-text-secondary">
        {label}
      </p>
      {version ? (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-text-secondary">Version</dt>
          <dd className="break-all font-mono text-xs">{version.version}</dd>
          <dt className="text-text-secondary">Status</dt>
          <dd>
            {version.status}
            {version.reason ? ` (${version.reason})` : ''}
          </dd>
          <dt className="text-text-secondary">Order</dt>
          <dd>
            {version.config.mode}
            {version.config.shuffleSeed
              ? `, seed ${version.config.shuffleSeed}`
              : ''}
          </dd>
          <dt className="text-text-secondary">Sources</dt>
          <dd>
            {version.config.sources
              .map((source) => names.get(source.assetId) ?? source.assetId)
              .join(', ')}
          </dd>
          <dt className="text-text-secondary">Checksum</dt>
          <dd className="font-mono text-xs" title={version.checksum}>
            {shortChecksum(version.checksum)}
          </dd>
          <dt className="text-text-secondary">Prepared</dt>
          <dd>
            {version.preparedAt
              ? new Date(version.preparedAt).toLocaleString()
              : 'Not prepared'}
          </dd>
        </dl>
      ) : (
        <p className="mt-2 text-sm text-text-secondary">None</p>
      )}
    </div>
  );
}

/** The active and pending version of one leg, read-only. */
export function FillerLegSummary({
  leg,
  state,
  names,
}: {
  leg: FillerLegName;
  state: ProgramFillerState;
  names: Map<string, string>;
}) {
  const versions = state.legs[leg]!;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <VersionSummary
        label="Active this session"
        version={versions.active}
        names={names}
      />
      <VersionSummary
        label="Pending next session"
        version={versions.pending}
        names={names}
      />
    </div>
  );
}

/**
 * Per-program filler configuration (gaulatti/alcantara#127 over the #126
 * API). Shows each leg's active (in-session) and pending (next-session)
 * version; operators with broadcast.manage prepare new versions. Against a
 * backend without the filler API (404) it renders nothing.
 */
export function ProgramFillerPanel({
  programId,
  canManage,
}: {
  programId: string;
  canManage: boolean;
}) {
  const [state, setState] = useState<ProgramFillerState | null>(null);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assets, setAssets] = useState<MediaAssetOption[]>([]);
  const [televisionAsset, setTelevisionAsset] = useState('');
  const [radioAssets, setRadioAssets] = useState<string[]>([]);
  const [mode, setMode] = useState<'ordered' | 'shuffle'>('ordered');
  const [shuffleSeed, setShuffleSeed] = useState('');
  const [busy, setBusy] = useState<FillerLegName | null>(null);
  const [radioSearch, setRadioSearch] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await api.get<ProgramFillerState>(
        `/broadcast/programs/${encodeURIComponent(programId)}/fillers`,
      );
      setState(response.data);
      setSupported(true);
      setError(null);
    } catch (cause) {
      if (axios.isAxiosError(cause) && cause.response?.status === 404) {
        // A backend without the filler API, or an unknown program.
        setSupported(false);
        return;
      }
      setError(failureMessage(cause));
    }
  }, [programId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!canManage || !state) return;
    const types = [
      ...(state.legs.television ? ['IMAGE', 'VIDEO'] : []),
      ...(state.legs.radio ? ['AUDIO'] : []),
    ];
    void Promise.all(
      types.map((mediaType) =>
        api.get<{ data: MediaAssetOption[] }>('/media-assets', {
          params: { mediaType, limit: 200 },
        }),
      ),
    )
      .then((responses) =>
        setAssets(
          responses
            .flatMap((response) => response.data.data)
            .filter((asset) => asset.enabled),
        ),
      )
      .catch((cause) => setError(failureMessage(cause)));
  }, [canManage, state]);

  const prepare = async (leg: FillerLegName) => {
    setBusy(leg);
    setError(null);
    try {
      const body =
        leg === 'television'
          ? { assetId: televisionAsset }
          : {
              assetIds: radioAssets,
              mode,
              ...(mode === 'shuffle' ? { shuffleSeed } : {}),
            };
      const response = await api.put<ProgramFillerState>(
        `/broadcast/programs/${encodeURIComponent(programId)}/fillers/${leg}`,
        body,
      );
      setState(response.data);
    } catch (cause) {
      // The selection stays as it was, so the operator can retry.
      setError(failureMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  if (!supported) return null;
  const names = new Map(assets.map((asset) => [asset.id, asset.name]));
  const audioAssets = assets.filter((asset) => asset.mediaType === 'AUDIO');
  const radioQuery = foldForSearch(radioSearch);
  const visibleAudioAssets = radioQuery
    ? audioAssets.filter((asset) => foldForSearch(asset.name).includes(radioQuery))
    : audioAssets;
  const legs = (['television', 'radio'] as const).filter(
    (leg) => state?.legs[leg],
  );

  return (
    <section
      className="space-y-4 rounded-[var(--radius-ui)] border border-sand/25 p-4 dark:border-white/10"
      aria-label="Program filler"
    >
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-text-secondary">
          Continuity
        </p>
        <h3 className="mt-1 text-lg font-semibold">Program filler</h3>
        <p className="mt-1 text-sm text-text-secondary">
          What each leg plays when nothing is live. A session keeps its active
          version; a newly prepared version applies from the next Start.
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      ) : null}
      {legs.map((leg) => (
        <div key={leg} className="space-y-3" aria-label={LEG_TITLES[leg]}>
          <h4 className="text-sm font-semibold">{LEG_TITLES[leg]}</h4>
          <FillerLegSummary leg={leg} state={state!} names={names} />
          {canManage && leg === 'television' ? (
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-64 text-sm">
                Image or video
                <Select
                  aria-label="Television filler source"
                  value={televisionAsset}
                  onChange={setTelevisionAsset}
                  options={[
                    { value: '', label: 'Choose a source' },
                    ...assets
                      .filter(
                        (asset) =>
                          asset.mediaType === 'IMAGE' ||
                          asset.mediaType === 'VIDEO',
                      )
                      .map((asset) => ({ value: asset.id, label: asset.name })),
                  ]}
                />
              </label>
              <Button
                type="button"
                onClick={() => void prepare('television')}
                disabled={busy !== null || !televisionAsset}
              >
                {busy === 'television'
                  ? 'Preparing in Alana…'
                  : 'Prepare television filler'}
              </Button>
            </div>
          ) : null}
          {canManage && leg === 'radio' ? (
            <div className="space-y-2">
              <Input
                type="search"
                aria-label="Search radio filler songs"
                placeholder="Search songs…"
                value={radioSearch}
                onChange={(event) => setRadioSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && radioSearch) {
                    event.preventDefault();
                    setRadioSearch('');
                  }
                }}
              />
              <p role="status" className="text-xs text-text-secondary">
                {radioAssets.length} selected
                {radioQuery
                  ? ` · ${visibleAudioAssets.length} of ${audioAssets.length} match`
                  : ` · ${audioAssets.length} songs`}
              </p>
              <div
                className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-border-subtle p-3"
                aria-label="Radio filler sources"
              >
                {radioQuery && visibleAudioAssets.length === 0 ? (
                  <p className="text-sm text-text-secondary">
                    No songs match “{radioSearch.trim()}”.
                  </p>
                ) : null}
                {visibleAudioAssets
                  .map((asset) => (
                    <Checkbox
                      key={asset.id}
                      label={asset.name}
                      checked={radioAssets.includes(asset.id)}
                      onChange={() =>
                        setRadioAssets((current) =>
                          current.includes(asset.id)
                            ? current.filter((id) => id !== asset.id)
                            : [...current, asset.id],
                        )
                      }
                    />
                  ))}
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-sm">
                  Order
                  <Select
                    aria-label="Radio filler order"
                    value={mode}
                    onChange={(value: string) =>
                      setMode(value === 'shuffle' ? 'shuffle' : 'ordered')
                    }
                    options={[
                      { value: 'ordered', label: 'In order' },
                      { value: 'shuffle', label: 'Shuffled' },
                    ]}
                  />
                </label>
                {mode === 'shuffle' ? (
                  <label className="text-sm">
                    Shuffle seed
                    <Input
                      aria-label="Shuffle seed"
                      value={shuffleSeed}
                      onChange={(event) => setShuffleSeed(event.target.value)}
                    />
                  </label>
                ) : null}
                <Button
                  type="button"
                  onClick={() => void prepare('radio')}
                  disabled={
                    busy !== null ||
                    radioAssets.length === 0 ||
                    radioAssets.length > 100 ||
                    (mode === 'shuffle' && !shuffleSeed.trim())
                  }
                >
                  {busy === 'radio'
                    ? 'Preparing in Palazzo…'
                    : 'Prepare radio filler'}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}
