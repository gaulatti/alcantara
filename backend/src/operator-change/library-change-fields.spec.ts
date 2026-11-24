import {
  INSTANT_CHANGE_FIELDS,
  MEDIA_CHANGE_FIELDS,
  MEDIA_GROUP_CHANGE_FIELDS,
  MEDIA_LABEL_ASSETS_CHANGE_FIELDS,
  MEDIA_LABEL_CHANGE_FIELDS,
  SONG_CHANGE_FIELDS,
  STINGER_CHANGE_FIELDS,
} from './library-change-fields';
import { summarizeChange } from './operator-change-recorder';

// gaulatti/alcantara#236 slice 3: a library change names its text, URL and description fields and never copies
// them; only numbers and booleans (and the size of a replaced list) keep their value.

describe('library change fields', () => {
  it('never values a name, URL, description or list of ids', () => {
    const text = new Set([
      'name',
      'audioUrl',
      'videoUrl',
      'imageUrl',
      'coverUrl',
      'description',
      'artist',
      'title',
    ]);
    for (const fields of [
      INSTANT_CHANGE_FIELDS,
      STINGER_CHANGE_FIELDS,
      SONG_CHANGE_FIELDS,
      MEDIA_CHANGE_FIELDS,
      MEDIA_LABEL_CHANGE_FIELDS,
      MEDIA_LABEL_ASSETS_CHANGE_FIELDS,
      MEDIA_GROUP_CHANGE_FIELDS,
    ]) {
      expect(fields.valued.filter((field) => text.has(field))).toEqual([]);
    }
  });

  it('summarizes an instant change with the volume before and after, naming the address only', () => {
    expect(
      summarizeChange(
        INSTANT_CHANGE_FIELDS,
        { audioUrl: 'https://media.example.test/a.mp3', volume: 0.4 },
        { volume: 0.8 },
        { volume: 0.4, audioUrl: 'https://media.example.test/a.mp3' },
      ),
    ).toEqual({
      changed: ['audioUrl', 'volume'],
      before: { volume: 0.8 },
      after: { volume: 0.4 },
    });
  });

  it('summarizes a song change with its enabled flag, naming the title only', () => {
    expect(
      summarizeChange(
        SONG_CHANGE_FIELDS,
        { title: 'Fictional title', enabled: false },
        { enabled: true, title: 'Old' },
        { enabled: false, title: 'Fictional title' },
      ),
    ).toEqual({
      changed: ['title', 'enabled'],
      before: { enabled: true },
      after: { enabled: false },
    });
  });
});
