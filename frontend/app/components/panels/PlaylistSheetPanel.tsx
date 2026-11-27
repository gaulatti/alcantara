import type { ReactNode } from 'react';
import { Sheet } from '@gaulatti/bleecker';
import type { ProgramSongPlaybackState } from '../../models/broadcast';
import type { SongCatalogItem } from '../../models/broadcast';
import type { ProgramSongSequence } from '../../utils/programSequence';
import { ProgramSongSequenceEditor } from '../editors';

interface PlaylistSheetPanelProps {
  /** Shown above the editor (the rotation-not-loaded notice); the editor is inert while it is set. */
  notice?: ReactNode;
  isOpen: boolean;
  onClose: () => void;
  programId: string;
  sequence: ProgramSongSequence;
  songCatalog: SongCatalogItem[];
  programSongPlayback: ProgramSongPlaybackState | null;
  isSaving: boolean;
  /** Why the last save of the rotation was refused. */
  error?: string | null;
  onChange: (sequence: ProgramSongSequence) => void;
  onTakeSelection?: (sequence: ProgramSongSequence) => Promise<void> | void;
}

export function PlaylistSheetPanel({
  programId,
  isOpen,
  onClose,
  sequence,
  songCatalog,
  programSongPlayback,
  isSaving,
  error,
  notice,
  onChange,
  onTakeSelection,
}: PlaylistSheetPanelProps) {
  return (
    <Sheet
      isOpen={isOpen}
      onClose={onClose}
      side='right'
      className='w-full max-w-4xl'
      scrollContent={false}
    >
      <div className='h-full min-h-0'>
        <div className='mb-2 text-xs text-text-secondary dark:text-text-secondary'>
          {isSaving ? 'Saving…' : ''}
        </div>
        {error && (
          <p role='alert' className='mb-2 text-sm text-terracotta'>
            {error}
          </p>
        )}
        {notice ? <div className='mb-2'>{notice}</div> : null}
        <div inert={notice ? true : undefined}>
        <ProgramSongSequenceEditor
          sequence={sequence}
          songCatalog={songCatalog}
          programSongPlayback={programSongPlayback}
          view='catalog'
          onChange={(nextSequence) => onChange(nextSequence)}
          onTakeSelection={onTakeSelection}
          undoScope={programId}
        />
        </div>
      </div>
    </Sheet>
  );
}
