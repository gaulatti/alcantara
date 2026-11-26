import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { REQUIRED_PERMISSION_KEY } from '../../auth/require-permission.decorator';
import { MediaAssetsController } from '../../media-assets/media-assets.controller';
import { MediaController } from '../../media/media.controller';
import { RadioController } from '../../radio/radio.controller';
import { SongsController } from '../../songs/songs.controller';
import { UNTRUSTED_NOTE } from '../contract';
import { MediaAssetsMcpTools } from './media-assets';
import { MediaMcpTools } from './media';
import { SimilarityMcpTools } from './similarity';
import { SongsMcpTools } from './songs';

// The rows of gaulatti/alcantara#210 appendix A that belong to ticket #218,
// copied from backend/src/mcp/appendix-a.tsv: songs (5), media (5), media
// assets and media labels (11) and the four radio similarity routes (25 in all). Names and
// tiers are binding; a row that looks wrong against the code is reported, never
// adjusted here.
// area, method, path, permission, handler, capability, tier
const ROWS = `
songs	GET	/songs	song.read	findAll	song_find_all	R
songs	GET	/songs/:id	song.read	findOne	song_find_one	R
songs	POST	/songs	song.manage	create	song_create	W
songs	PUT	/songs/:id	song.manage	update	song_update	W
songs	DELETE	/songs/:id	song.manage	remove	song_remove	D
media	GET	/media	media.read	findAll	media_find_all	R
media	GET	/media/:id	media.read	findOne	media_find_one	R
media	POST	/media	media.manage	create	media_create	W
media	PUT	/media/:id	media.manage	update	media_update	W
media	DELETE	/media/:id	media.manage	remove	media_remove	D
media-assets	GET	/media-assets	access	findAll	media_asset_find_all	R
media-assets	GET	/media-assets/:id	access	findOne	media_asset_find_one	R
media-assets	POST	/media-assets/background-audio	media.manage	createBackgroundAudio	media_asset_create_background_audio	W
media-assets	DELETE	/media-assets/:id	media.manage	removeStandaloneAsset	media_asset_remove_standalone_asset	D
media-assets	PUT	/media-assets/:id/labels	media.manage	replaceAssetLabels	media_asset_replace_asset_labels	W
media-assets	GET	/media-labels	access	findLabels	media_asset_find_labels	R
media-assets	GET	/media-labels/:id	access	findLabel	media_asset_find_label	R
media-assets	POST	/media-labels	media.manage	createLabel	media_asset_create_label	W
media-assets	PUT	/media-labels/:id	media.manage	updateLabel	media_asset_update_label	W
media-assets	PUT	/media-labels/:id/assets	media.manage	replaceLabelAssets	media_asset_replace_label_assets	W
media-assets	DELETE	/media-labels/:id	media.manage	removeLabel	media_asset_remove_label	D
radio	GET	/radio/:programId/similarity/coverage	radio.read	similarityCoverage	radio_similarity_coverage	R
radio	GET	/radio/:programId/similarity/decisions	radio.read	similarityDecisions	radio_similarity_decisions	R
radio	GET	/radio/:programId/similarity/export	radio.manage	similarityExport	radio_similarity_export	R
radio	POST	/radio/:programId/similarity/embeddings	radio.manage	similarityUpload	radio_similarity_upload	W
`
  .trim()
  .split('\n')
  .map((line) => line.split('\t'));

const permissionOf = (key: string): string => {
  const [group, action] = key.split('.');
  const entry = (ALCANTARA_PERMISSIONS as Record<string, unknown>)[group];
  return typeof entry === 'string'
    ? entry
    : (entry as Record<string, string>)[action];
};

const specs = [
  ...new SongsMcpTools(
    {} as never,
    {} as never,
    { teamId: 7 } as never,
  ).specs(),
  ...new MediaMcpTools({} as never, {} as never).specs(),
  ...new MediaAssetsMcpTools({} as never, {} as never).specs(),
  ...new SimilarityMcpTools({} as never).specs(),
];

describe('appendix A rows of ticket #218', () => {
  it.each(ROWS)(
    '%s %s %s needs %s and is capability %s (tier %s)',
    (_area, _method, _path, permission, _handler, name, tier) => {
      const spec = specs.find((candidate) => candidate.name === name);
      expect(spec).toBeDefined();
      expect(spec?.permission).toBe(permissionOf(permission));
      expect(spec?.tier).toBe(tier);
      expect(spec?.firstClass).toBe(false);
    },
  );

  it.each(ROWS)(
    '%s %s %s: the permission is the one the controller handler requires',
    (area, _method, _path, permission, handler, name, tier) => {
      const controller = (
        {
          songs: SongsController,
          media: MediaController,
          'media-assets': MediaAssetsController,
          radio: RadioController,
        } as Record<string, { prototype: object }>
      )[area];
      const required =
        (Reflect.getMetadata(
          REQUIRED_PERMISSION_KEY,
          (controller.prototype as Record<string, object>)[handler],
        ) as string | undefined) ??
        (Reflect.getMetadata(REQUIRED_PERMISSION_KEY, controller) as string);
      const actual = specs.find((spec) => spec.name === name)?.permission;
      // The media asset and label writes need the media write permission.
      if (area === 'media-assets' && tier !== 'R')
        expect(actual).toBe(ALCANTARA_PERMISSIONS.media.manage);
      else expect(actual).toBe(required);
      expect(permission).toBeTruthy();
    },
  );

  it('registers exactly those rows, once each', () => {
    expect(specs.map((spec) => spec.name).sort()).toEqual(
      ROWS.map((row) => row[5]).sort(),
    );
  });

  it('has the counted rows per area and tier', () => {
    const count = (area: string) =>
      ROWS.filter((row) => row[0] === area).length;
    expect([
      count('songs'),
      count('media'),
      count('media-assets'),
      count('radio'),
    ]).toEqual([5, 5, 11, 4]);
    const tiers = ROWS.map((row) => row[6]);
    for (const [tier, n] of [
      ['R', 11],
      ['W', 10],
      ['A', 0],
      ['D', 4],
    ] as const)
      expect(tiers.filter((t) => t === tier)).toHaveLength(n);
  });

  it('gives every W, A and D capability a dry run, and every A and D a confirm target', () => {
    for (const spec of specs) {
      expect(spec.dryRun !== undefined).toBe(spec.tier !== 'R');
      expect(spec.confirmTarget !== undefined).toBe(
        spec.tier === 'A' || spec.tier === 'D',
      );
    }
  });

  it('ends every description with the untrusted note', () => {
    for (const spec of specs)
      expect(spec.description.endsWith(UNTRUSTED_NOTE)).toBe(true);
  });
});
