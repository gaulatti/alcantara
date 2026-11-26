import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import {
  MediaAssetsService,
  type MediaAssetAuthorization,
} from '../../media-assets/media-assets.service';
import { PompeiiService } from '../../auth/pompeii.service';
import { ProgramService } from '../../program/program.service';
import {
  McpToolProvider,
  type McpContext,
  type McpToolSpec,
} from '../contract';
import {
  legacyGroupOf,
  loadUsage,
  readingGroup,
  scenesNaming,
  uniq,
  visuallyOnAir,
} from './media-usage';
import { programsAffected, whyNot } from './on-air';
import { actionSpec, present, readSpec } from './support';

const access = ALCANTARA_PERMISSIONS.access;
const manage = ALCANTARA_PERMISSIONS.media.manage;

/** Asset and label text and addresses were typed or imported by people. */
export const ASSET_UNTRUSTED = ['sourceUrl', 'artist', 'title', 'coverUrl'];

const idArg = z.string().trim().min(1).max(200);
const nameArg = z.string().trim().min(1).max(200);
const descriptionArg = z.string().max(2000).nullable().optional();
const idsArg = (max: number) => z.array(idArg).max(max);

interface AssetAnswer {
  id: string;
  name: string;
  sourceUrl: string;
  capabilities: string[];
  labels: Array<{ id: string }>;
}

interface LabelAnswer {
  id: string;
  name: string;
  description: string | null;
  assetCount: number;
  assets: Array<{ asset: { id: string } }>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A label write answers with the label's ids, text and times and the ids of
 * its assets, not with every asset of it (a stored outcome is kept whole in
 * memory); media_asset_find_label lists them.
 */
function labelSummary(raw: unknown) {
  const label = raw as LabelAnswer;
  return {
    id: label.id,
    createdAt: label.createdAt,
    updatedAt: label.updatedAt,
    assetCount: label.assetCount,
    assetIds: label.assets.map((entry) => entry.asset.id),
    name: label.name,
    description: label.description,
  };
}

/**
 * What the service decides asset and label access from: the caller's
 * permissions as Pompeii answered for them, as the console's guard hands it.
 */
export const authorizationOf = (ctx: McpContext): MediaAssetAuthorization => ({
  permissions: [...ctx.principal.permissions],
});

/**
 * gaulatti/alcantara#218: the media asset and media label capabilities. They
 * call MediaAssetsService, the service the console's media-assets and
 * media-labels routes call, in process, with the caller's own permissions, so
 * the service's per-asset checks decide as they do in the console.
 *
 * Step 0 of the two D rows. media_asset_remove_standalone_asset: the console
 * deletes the asset (and, by cascade, its label assignments and analysis) when
 * the caller may manage it and it is not an image, a clip, a song, a cover or
 * a transition (those have their own editors); it never looks at what is on
 * air. media_asset_remove_label: the console deletes the label and its
 * assignments (the assets stay); a legacy slideshow label deletes the media
 * group it mirrors, with that group's program assignments. Neither looks at
 * what is on air. These capabilities refuse with on_air while a scene that is
 * on air or staged names the asset (its id or address) or the label (its id)
 * in its settings, and, for a legacy label, while a program that reads the
 * mirrored group has a scene or fade to black on air.
 *
 * The writes need media.manage; the service then decides from the caller's
 * own permissions (a background audio needs scene.manage, a label write any
 * manage permission, an asset the manage permission of its kind).
 */
@Injectable()
@McpToolProvider()
export class MediaAssetsMcpTools {
  constructor(
    private readonly assets: MediaAssetsService,
    private readonly programs: ProgramService,
    private readonly pompeii: PompeiiService,
  ) {}

  /** The caller's permissions and the team they act for. */
  private authorization(ctx: McpContext): MediaAssetAuthorization {
    return { ...authorizationOf(ctx), teamId: this.pompeii.teamId };
  }

  /** The asset, its labels, and which programs have a scene on air or staged that names it. */
  private async assetInUse(assetId: string, ctx: McpContext) {
    const asset = (await this.assets.findOne(
      assetId,
      this.authorization(ctx),
    )) as AssetAnswer;
    const scenes = scenesNaming(await loadUsage(this.programs), [
      asset.id,
      asset.sourceUrl,
    ]);
    return { asset, readers: scenes.readers, onAirIn: scenes.onAir };
  }

  /** The label, and where it is read: by scenes naming it and by a mirrored group. */
  private async labelInUse(labelId: string, ctx: McpContext) {
    const label = (await this.assets.findLabel(
      labelId,
      this.authorization(ctx),
    )) as LabelAnswer;
    const list = await loadUsage(this.programs);
    const scenes = scenesNaming(list, [label.id]);
    const groupId = legacyGroupOf(label.id);
    const groupReaders = groupId === null ? [] : readingGroup(list, groupId);
    return {
      label,
      mirrorsGroup: groupId,
      readers: uniq(scenes.readers, groupReaders),
      onAirIn: uniq(
        scenes.onAir,
        list
          .filter(
            (program) =>
              groupReaders.includes(program.programId) &&
              visuallyOnAir(program),
          )
          .map((program) => program.programId),
      ),
    };
  }

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'media_asset_find_all',
        title: 'List media assets',
        description:
          'Lists the media assets the caller may read, paged as the console pages them (default 50 per page, at most 200), filtered by name, media type, capability (INSTANT, BACKGROUND, SONG, COVER, TRANSITION) or label.',
        permission: access,
        untrusted: ASSET_UNTRUSTED,
        shape: {
          search: z.string().max(200).optional(),
          media_type: z.string().max(50).optional(),
          capability: z.string().max(50).optional(),
          label_id: idArg.optional(),
          page: z.number().int().min(1).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        },
        run: (args, ctx) =>
          this.assets.findAll(
            {
              search: args.search,
              mediaType: args.media_type,
              capability: args.capability,
              labelId: args.label_id,
              page: args.page ?? 1,
              limit: args.limit ?? 50,
            },
            this.authorization(ctx),
          ),
      }),
      readSpec({
        name: 'media_asset_find_one',
        title: 'Get a media asset',
        description: 'Returns one media asset the caller may read.',
        permission: access,
        untrusted: ASSET_UNTRUSTED,
        shape: { asset_id: idArg },
        run: (args, ctx) =>
          this.assets.findOne(args.asset_id, this.authorization(ctx)),
      }),
      readSpec({
        name: 'media_asset_find_labels',
        title: 'List media labels',
        description:
          'Lists media labels with the assets of each that the caller may read, paged as the console pages them (default 50 per page, at most 200).',
        permission: access,
        untrusted: ASSET_UNTRUSTED,
        shape: {
          search: z.string().max(200).optional(),
          page: z.number().int().min(1).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        },
        run: (args, ctx) =>
          this.assets.findLabels(
            {
              search: args.search,
              page: args.page ?? 1,
              limit: args.limit ?? 50,
            },
            this.authorization(ctx),
          ),
      }),
      readSpec({
        name: 'media_asset_find_label',
        title: 'Get a media label',
        description:
          'Returns one media label with the assets of it that the caller may read.',
        permission: access,
        untrusted: ASSET_UNTRUSTED,
        shape: { label_id: idArg },
        run: (args, ctx) =>
          this.assets.findLabel(args.label_id, this.authorization(ctx)),
      }),
      actionSpec({
        name: 'media_asset_create_background_audio',
        title: 'Create a background audio asset',
        description:
          'Creates a background audio asset (a name, a source address and a default volume from 0 to 1, default 1). The service requires scene.manage of the caller.',
        permission: manage,
        tier: 'W',
        untrusted: ASSET_UNTRUSTED,
        shape: {
          name: nameArg,
          source_url: z.string().trim().min(1).max(2000),
          default_volume: z.number().min(0).max(1).optional(),
        },
        id: () => 'new-media-asset',
        plan: () => ({
          summary:
            'Creates a background audio asset; no scene uses it until its settings name it.',
          affects: [],
          recoverable: true,
        }),
        run: (args, _loaded, ctx) =>
          this.assets.createBackgroundAudio(
            present({
              name: args.name,
              sourceUrl: args.source_url,
              defaultVolume: args.default_volume,
            }),
            this.authorization(ctx),
          ),
      }),
      actionSpec({
        name: 'media_asset_replace_asset_labels',
        title: 'Replace the labels of an asset',
        description:
          'Replaces the whole list of labels of an asset (label_ids); the asset keeps its position in a label it stays in and goes last in a new one. An empty list removes every label.',
        permission: manage,
        tier: 'W',
        untrusted: ASSET_UNTRUSTED,
        shape: { asset_id: idArg, label_ids: idsArg(200) },
        load: (args, ctx) => this.assetInUse(args.asset_id, ctx),
        id: (args) => args.asset_id,
        plan: (args, { asset }) => ({
          summary: `Replaces the ${asset.labels.length} label(s) of asset ${args.asset_id} with ${args.label_ids.length}. Labels it leaves lose it; the labels it had are not kept, so read the asset first to restore them.`,
          affects: [
            { kind: 'media_asset', id: args.asset_id, name: args.asset_id },
          ],
          recoverable: true,
        }),
        run: (args, _loaded, ctx) =>
          this.assets.replaceAssetLabels(
            args.asset_id,
            args.label_ids,
            this.authorization(ctx),
          ),
      }),
      actionSpec({
        name: 'media_asset_create_label',
        title: 'Create a media label',
        description:
          'Creates a media label (a unique name and an optional description). The answer lists the asset ids, not the assets.',
        permission: manage,
        tier: 'W',
        untrusted: ASSET_UNTRUSTED,
        shape: { name: nameArg, description: descriptionArg },
        id: () => 'new-media-label',
        plan: () => ({
          summary: 'Creates an empty media label.',
          affects: [],
          recoverable: true,
        }),
        run: (args, _loaded, ctx) =>
          this.assets.createLabel(
            { name: args.name, description: args.description },
            this.authorization(ctx),
          ),
        result: labelSummary,
      }),
      actionSpec({
        name: 'media_asset_update_label',
        title: 'Update a media label',
        description:
          'Changes the name or description of a media label; a field left out stays, null clears the description. A legacy slideshow label also renames the media group it mirrors. The answer lists the asset ids, not the assets.',
        permission: manage,
        tier: 'W',
        untrusted: ASSET_UNTRUSTED,
        shape: {
          label_id: idArg,
          name: nameArg.optional(),
          description: descriptionArg,
        },
        load: (args, ctx) => this.labelInUse(args.label_id, ctx),
        id: (args) => args.label_id,
        plan: (args, { readers, mirrorsGroup }) => ({
          summary: `Updates media label ${args.label_id}${mirrorsGroup === null ? '' : ` and the media group ${mirrorsGroup} it mirrors`}. The previous values are not kept: read the label first to restore them. It is read by ${readers.length} program(s).`,
          affects: [
            { kind: 'media_label', id: args.label_id, name: args.label_id },
          ],
          recoverable: true,
        }),
        onAir: (_args, { onAirIn }) => onAirIn.length > 0,
        run: (args, _loaded, ctx) =>
          this.assets.updateLabel(
            args.label_id,
            present({ name: args.name, description: args.description }),
            this.authorization(ctx),
          ),
        result: labelSummary,
      }),
      actionSpec({
        name: 'media_asset_replace_label_assets',
        title: 'Replace the assets of a label',
        description:
          'Replaces the whole ordered list of assets of a media label (asset_ids); assets it drops stay, only their place in the label goes. A legacy slideshow label takes image assets only and rewrites the media group it mirrors. The answer lists the asset ids, not the assets.',
        permission: manage,
        tier: 'W',
        untrusted: ASSET_UNTRUSTED,
        shape: { label_id: idArg, asset_ids: idsArg(500) },
        load: (args, ctx) => this.labelInUse(args.label_id, ctx),
        id: (args) => args.label_id,
        plan: (args, { label, readers, mirrorsGroup }) => ({
          summary: `Replaces the ${label.assetCount} asset(s) of media label ${args.label_id} with ${args.asset_ids.length}${mirrorsGroup === null ? '' : `, rewriting the media group ${mirrorsGroup} it mirrors`}. The previous list and its order are not kept: read the label first to restore them. It is read by ${readers.length} program(s).`,
          affects: [
            { kind: 'media_label', id: args.label_id, name: args.label_id },
            ...programsAffected(readers),
          ],
          recoverable: true,
        }),
        onAir: (_args, { onAirIn }) => onAirIn.length > 0,
        run: (args, _loaded, ctx) =>
          this.assets.replaceLabelAssets(
            args.label_id,
            args.asset_ids,
            this.authorization(ctx),
          ),
        result: labelSummary,
      }),
      actionSpec({
        name: 'media_asset_remove_standalone_asset',
        title: 'Delete a standalone media asset',
        description:
          'Deletes a media asset that is not an image, a clip, a song, a cover or a transition (those have their own editors; the service refuses them as invalid), with its label assignments. Refused with on_air while a scene on air or staged names it. Not recoverable. Stricter than the console, which deletes whatever is on air.',
        permission: manage,
        tier: 'D',
        untrusted: ASSET_UNTRUSTED,
        shape: { asset_id: idArg },
        load: (args, ctx) => this.assetInUse(args.asset_id, ctx),
        id: (args) => args.asset_id,
        label: (_args, { asset }) => asset.name,
        plan: (args, { asset, readers, onAirIn }) => ({
          summary: `Deletes media asset ${args.asset_id} (${asset.capabilities.join(', ') || 'no capability'}) and its ${asset.labels.length} label assignment(s). The file in storage stays, but the asset cannot be recovered (a new asset gets a new id and must be labelled again). ${readers.length} program(s) have a scene that names it. The console deletes it even when a live scene names it; this capability refuses while that scene is on air or staged (${onAirIn.length} now).`,
          affects: [
            { kind: 'media_asset', id: args.asset_id, name: args.asset_id },
            ...programsAffected(readers),
          ],
          recoverable: false,
        }),
        refuse: (args, { onAirIn }) =>
          whyNot([
            [
              onAirIn.length > 0,
              `asset ${args.asset_id} is named by a scene on air or staged on ${onAirIn.join(', ')}`,
            ],
          ]),
        run: (args, _loaded, ctx) =>
          this.assets.removeStandaloneAsset(
            args.asset_id,
            this.authorization(ctx),
          ),
      }),
      actionSpec({
        name: 'media_asset_remove_label',
        title: 'Delete a media label',
        description:
          'Deletes a media label and its assignments (the assets stay); a legacy slideshow label deletes the media group it mirrors, with its program assignments. Refused with on_air while a scene on air or staged names the label, or a program that reads the mirrored group has a scene or fade to black on air. Not recoverable. Stricter than the console, which deletes whatever is on air.',
        permission: manage,
        tier: 'D',
        untrusted: ASSET_UNTRUSTED,
        shape: { label_id: idArg },
        load: (args, ctx) => this.labelInUse(args.label_id, ctx),
        id: (args) => args.label_id,
        label: (_args, { label }) => label.name,
        plan: (args, { label, readers, onAirIn, mirrorsGroup }) => ({
          summary: `Deletes media label ${args.label_id} and its ${label.assetCount} readable asset assignment(s)${mirrorsGroup === null ? '' : `, and the media group ${mirrorsGroup} it mirrors with its program assignments`}. The assets stay; the label, its order and its assignments cannot be recovered (a new label gets a new id). ${readers.length} program(s) read it. The console deletes it even when a live scene or page reads it; this capability refuses while one is on air (${onAirIn.length} now).`,
          affects: [
            { kind: 'media_label', id: args.label_id, name: args.label_id },
            ...programsAffected(readers),
          ],
          recoverable: false,
        }),
        refuse: (args, { onAirIn }) =>
          whyNot([
            [
              onAirIn.length > 0,
              `label ${args.label_id} is read by program(s) on air: ${onAirIn.join(', ')}`,
            ],
          ]),
        run: (args, _loaded, ctx) =>
          this.assets.removeLabel(args.label_id, this.authorization(ctx)),
      }),
    ];
  }
}
