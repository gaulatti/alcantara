import type { ProgramSongPlaybackState, SongCatalogItem } from '../../models/broadcast';
import type { ProgramSongSequence } from '../../utils/programSequence';
import { ProgramSongSequenceEditor } from '../editors';

interface PlaylistPanelProps {
  sequence: ProgramSongSequence;
  songCatalog: SongCatalogItem[];
  programSongPlayback: ProgramSongPlaybackState | null;
  onChange: (sequence: ProgramSongSequence) => void;
  onTakeSelection?: (sequence: ProgramSongSequence) => Promise<void> | void;
}

export function PlaylistPanel({
  sequence,
  songCatalog,
  programSongPlayback,
  onChange,
  onTakeSelection,
}: PlaylistPanelProps) {
  return (
    <ProgramSongSequenceEditor
      sequence={sequence}
      songCatalog={songCatalog}
      programSongPlayback={programSongPlayback}
      view='queue'
      onChange={(nextSequence) => onChange(nextSequence)}
      onTakeSelection={onTakeSelection ? async (nextSequence) => await onTakeSelection(nextSequence) : undefined}
    />
  );
}
