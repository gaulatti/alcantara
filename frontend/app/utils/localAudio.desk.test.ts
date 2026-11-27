import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// gaulatti/alcantara#879: every place on the radio desk that sounds something on this device hands its element to
// localAudio, which mutes it while the host microphone is open without headphones.
const read = (name: string) => readFileSync(join(__dirname, '..', 'components', name), 'utf8');

it.each(['radio-desk/usePreListen.ts', 'radio-desk/ChannelPreListen.tsx', 'radio-desk/guestPreListenCore.ts', 'editors/ProgramSongSequenceEditor.tsx', 'WaitingGuest.tsx'])(
  '%s holds what it plays',
  (name) => {
    const source = read(name);
    const sounds = source.match(/new Audio\(|\.attach\(\)|remote\.attach\(element\)/g)?.length ?? 0;
    expect(sounds).toBeGreaterThan(0);
    expect(source.match(/holdLocalAudio\(/g)?.length).toBe(sounds);
  }
);
