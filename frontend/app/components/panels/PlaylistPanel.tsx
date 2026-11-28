import type { ProgramSongPlaybackState, SongCatalogItem } from '../../models/broadcast';
import type { ProgramSongSequence } from '@modoitaliano/giorgia/scenes';
import { ProgramSongSequenceEditor } from '../editors';

interface PlaylistPanelProps {
  sequence: ProgramSongSequence;
  songCatalog: SongCatalogItem[];
  programSongPlayback: ProgramSongPlaybackState | null;
  onChange: (sequence: ProgramSongSequence) => void;
  onTakeSelection?: (sequence: ProgramSongSequence) => Promise<void> | void;
  onQueueItem?: (itemId: string) => Promise<void> | void;
  programId: string;
}

export function PlaylistPanel({
  sequence,
  songCatalog,
  programSongPlayback,
  onChange,
  onTakeSelection,
  onQueueItem,
  programId,
}: PlaylistPanelProps) {
  return (
    <ProgramSongSequenceEditor
      sequence={sequence}
      songCatalog={songCatalog}
      programSongPlayback={programSongPlayback}
      view='queue'
      onChange={(nextSequence) => onChange(nextSequence)}
      onTakeSelection={onTakeSelection ? async (nextSequence) => await onTakeSelection(nextSequence) : undefined}
      onQueueItem={onQueueItem}
      undoScope={programId}
    />
  );
}
