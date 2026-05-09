import { Sheet } from '@gaulatti/bleecker';
import type { ProgramSongPlaybackState } from '../../models/broadcast';
import type { SongCatalogItem } from '../../models/broadcast';
import type { ProgramSongSequence } from '../../utils/programSequence';
import { ProgramSongSequenceEditor } from '../editors';

interface PlaylistSheetPanelProps {
  isOpen: boolean;
  onClose: () => void;
  sequence: ProgramSongSequence;
  songCatalog: SongCatalogItem[];
  programSongPlayback: ProgramSongPlaybackState | null;
  isSaving: boolean;
  onChange: (sequence: ProgramSongSequence) => void;
  onTakeSelection?: (sequence: ProgramSongSequence) => Promise<void> | void;
}

export function PlaylistSheetPanel({
  isOpen,
  onClose,
  sequence,
  songCatalog,
  programSongPlayback,
  isSaving,
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
        <ProgramSongSequenceEditor
          sequence={sequence}
          songCatalog={songCatalog}
          programSongPlayback={programSongPlayback}
          view='catalog'
          onChange={(nextSequence) => onChange(nextSequence)}
          onTakeSelection={onTakeSelection ? async (nextSequence) => await onTakeSelection(nextSequence) : undefined}
        />
      </div>
    </Sheet>
  );
}
