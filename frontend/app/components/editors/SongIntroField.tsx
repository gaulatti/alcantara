import { Button } from '@gaulatti/bleecker';
import { Volume2 } from 'lucide-react';
import type { InstantItem } from '../../models/broadcast';

interface SongIntroFieldProps {
  instants: InstantItem[];
  songId?: number;
  currentIntroInstantId?: number | null;
  selectedInstantId: string;
  previewing?: boolean;
  validationError?: string;
  onChange: (instantId: string) => void;
  onPreview: (instant: InstantItem) => void;
}

export function SongIntroField({
  instants,
  songId,
  currentIntroInstantId,
  selectedInstantId,
  previewing = false,
  validationError,
  onChange,
  onPreview
}: SongIntroFieldProps) {
  const selectedInstant = instants.find((candidate) => candidate.id === Number(selectedInstantId));

  return (
    <div className="space-y-3 rounded-xl border border-sand/30 bg-sand/5 p-3 dark:border-sand/45 dark:bg-dark-sand/40">
      <div>
        <p className="text-sm font-semibold text-text-primary dark:text-text-primary">Song intro</p>
        <p className="text-xs text-text-secondary dark:text-text-secondary">
          A recorded voice segue that plays over this song&apos;s opening. Station bumper/ID audio remains sequential in Radio settings; Manual instants remain
          independent operator overlays.
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <select
          value={selectedInstantId}
          onChange={(event) => onChange(event.target.value)}
          className="min-h-10 flex-1 rounded-lg border border-sand/40 bg-white px-3 text-sm text-text-primary dark:border-sand/50 dark:bg-deep-sea dark:text-text-primary"
          aria-label="Assigned song intro"
        >
          <option value="">No song intro</option>
          {instants.map((instant) => {
            const selectable = instant.enabled && (instant.availableForSongIntro !== false || instant.assignedSongId === songId);
            return (
              <option key={instant.id} value={instant.id} disabled={!selectable}>
                {instant.name}
                {selectable ? '' : ' — unavailable'}
              </option>
            );
          })}
        </select>
        <Button type="button" variant="secondary" disabled={!selectedInstant || previewing} onClick={() => selectedInstant && onPreview(selectedInstant)}>
          <Volume2 size={15} /> {previewing ? 'Previewing…' : 'Preview intro'}
        </Button>
      </div>
      {currentIntroInstantId && !selectedInstantId ? <p className="text-xs text-terracotta">Saving removes the current song intro assignment.</p> : null}
      {validationError ? <p className="text-xs text-terracotta">{validationError}</p> : null}
    </div>
  );
}
