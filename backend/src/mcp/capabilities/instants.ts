import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { ProgramService } from '../../program/program.service';
import { RadioService } from '../../radio/radio.service';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { loadUsage, uniq, type UsageProgram } from './media-usage';
import { loadProgramLive, programsAffected, whyNot } from './on-air';
import {
  actionSpec,
  present,
  programIdArg,
  readSpec,
  rowIdArg,
} from './support';

const permissions = ALCANTARA_PERMISSIONS.instant;

const nameArg = z.string().trim().min(1).max(200);
const addressArg = z.string().trim().min(1).max(2000);
/** The service clamps the volume to 0..1; any finite number is accepted as the console accepts it. */
const volumeArg = z.number();
/** The console's routes without a program act on the default program. */
const playProgramArg = programIdArg.default('main');

/** An instant's text and address were typed or imported by people. */
const INSTANT_UNTRUSTED = ['audioUrl'] as const;

interface InstantRow {
  id: number;
  name: string;
  audioUrl: string;
  volume: number;
  enabled: boolean;
  availableForSongIntro: boolean;
}

/** Whether a scene's settings name the instant as its background audio. */
function namesInstant(metadata: unknown, instantId: number): boolean {
  try {
    const parsed = (
      typeof metadata === 'string' ? JSON.parse(metadata) : metadata
    ) as { sceneInstant?: { instantId?: unknown } } | null;
    return Number(parsed?.sceneInstant?.instantId) === instantId;
  } catch {
    return false;
  }
}

const idsWhere = (
  list: UsageProgram[],
  test: (program: UsageProgram) => boolean,
): string[] => list.filter(test).map((program) => program.programId);

/**
 * gaulatti/alcantara#217: the instant capabilities. They call ProgramService,
 * the service the console's instants routes call, in process.
 *
 * Step 0 of instant_delete_instant: the console checks that the instant
 * exists and that it is not a song's intro (answering 400 for that), then
 * deletes the instant and its media asset and renumbers the later instants. It
 * never looks at what is playing or on air. This capability refuses with
 * on_air while a program is playing the instant as a scene background, while a
 * scene on air or staged names it as its background audio, or while a program
 * lists it in its bumper rotation and has bumpers on; the song intro refusal
 * stays the console's.
 */
@Injectable()
@McpToolProvider()
export class InstantsMcpTools {
  constructor(
    private readonly programs: ProgramService,
    private readonly radio: RadioService,
  ) {}

  /** The instant and everything that plays, shows or rotates it. */
  private async instantInUse(instantId: number) {
    const found = await this.instantOf(instantId);
    const list = await loadUsage(this.programs);
    const named = (program: UsageProgram) =>
      program.scenes.some((entry) =>
        namesInstant(entry.scene.metadata, instantId),
      );
    const playing: string[] = [];
    const bumperListed: string[] = [];
    const bumperOn: string[] = [];
    for (const program of list) {
      const playback = await this.programs.getProgramSceneInstantPlayback(
        program.programId,
      );
      if (playback.isPlaying && playback.instantId === instantId)
        playing.push(program.programId);
      const settings = await this.radio.getRadioSettings(program.programId);
      if (settings?.bumperInstantIds.includes(instantId)) {
        bumperListed.push(program.programId);
        if (settings.bumperEnabled) bumperOn.push(program.programId);
      }
    }
    return {
      instant: found,
      readers: idsWhere(list, named),
      onAirIn: idsWhere(list, (program) =>
        program.scenes.some(
          (entry) =>
            namesInstant(entry.scene.metadata, instantId) &&
            (entry.sceneId === program.activeSceneId ||
              entry.sceneId === program.stagedSceneId),
        ),
      ),
      playing,
      bumperListed,
      bumperOn,
    };
  }

  /** The instant as the console's list reports it, or not_found. */
  private async instantOf(instantId: number) {
    const found = (
      (await this.programs.listInstants()) as unknown as InstantRow[]
    ).find((row) => row.id === instantId);
    if (!found) throw new NotFoundException('Instant not found');
    return found;
  }

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'instant_list_instants',
        title: 'List instants',
        description:
          'Lists every instant (a short audio clip played over the program) in the console order, with whether it can still be assigned as a song intro and, for program_id (default main), which song it introduces there.',
        permission: permissions.read,
        untrusted: INSTANT_UNTRUSTED,
        shape: { program_id: programIdArg.optional() },
        run: (args) => this.programs.listInstants(args.program_id),
      }),
      actionSpec({
        name: 'instant_create_instant',
        title: 'Create an instant',
        description:
          'Adds an instant (a name and an audio address, with an optional volume from 0 to 1, clamped as the console clamps it, and enabled, default true) at the end of the list and creates its media asset. It plays only when played or named by a scene or a bumper rotation.',
        permission: permissions.manage,
        tier: 'W',
        untrusted: INSTANT_UNTRUSTED,
        shape: {
          name: nameArg,
          audio_url: addressArg,
          volume: volumeArg.optional(),
          enabled: z.boolean().optional(),
        },
        id: () => 'new-instant',
        plan: () => ({
          summary:
            'Creates an instant and its media asset at the end of the instant list; nothing plays it until it is played, named by a scene or put in a bumper rotation.',
          affects: [],
          recoverable: true,
        }),
        run: (args) =>
          this.programs.createInstant({
            name: args.name,
            audioUrl: args.audio_url,
            volume: args.volume,
            enabled: args.enabled,
          }),
      }),
      actionSpec({
        name: 'instant_update_instant',
        title: 'Update an instant',
        description:
          'Changes the name, audio address, volume or enabled flag of an instant; only the fields given change. The change shows at once wherever the instant is used, a bumper rotation or a scene background on air included.',
        permission: permissions.manage,
        tier: 'W',
        untrusted: INSTANT_UNTRUSTED,
        shape: {
          instant_id: rowIdArg,
          name: nameArg.optional(),
          audio_url: addressArg.optional(),
          volume: volumeArg.optional(),
          enabled: z.boolean().optional(),
        },
        load: (args) => this.instantInUse(args.instant_id),
        id: (args) => String(args.instant_id),
        plan: (args, use) => ({
          summary: `Updates instant ${args.instant_id}. The previous values are not kept: read the instant first to restore them. It is the background of a scene of ${use.readers.length} program(s), playing as one on ${use.playing.length}, named by a scene on air or staged on ${use.onAirIn.length}, and in the bumper rotation of ${use.bumperListed.length} program(s) (${use.bumperOn.length} with bumpers on).`,
          affects: [
            {
              kind: 'instant',
              id: String(use.instant.id),
              name: use.instant.name,
            },
            ...programsAffected(
              uniq(use.readers, use.playing, use.bumperListed),
            ),
          ],
          recoverable: true,
        }),
        onAir: (_args, use) =>
          use.playing.length > 0 ||
          use.onAirIn.length > 0 ||
          use.bumperOn.length > 0,
        run: (args) =>
          this.programs.updateInstant(
            args.instant_id,
            present({
              name: args.name,
              audioUrl: args.audio_url,
              volume: args.volume,
              enabled: args.enabled,
            }),
          ),
      }),
      actionSpec({
        name: 'instant_delete_instant',
        title: 'Delete an instant',
        description:
          'Deletes an instant and its media asset and renumbers the later instants; the audio file stays in storage. Refused by the console (invalid) while it is a song intro, and with on_air while a program is playing it as a scene background, a scene on air or staged names it, or a program with bumpers on lists it. Not recoverable.',
        permission: permissions.manage,
        tier: 'D',
        untrusted: INSTANT_UNTRUSTED,
        shape: { instant_id: rowIdArg },
        load: (args) => this.instantInUse(args.instant_id),
        id: (args) => String(args.instant_id),
        label: (_args, { instant }) => instant.name,
        plan: (args, use) => ({
          summary: `Deletes instant ${args.instant_id} with its media asset and moves the later instants up one place; the audio file stays in storage. Its name, volume and place in the list are lost and cannot be recovered (a new instant gets a new id, so every scene background and bumper rotation that names this id must be changed by hand). ${use.instant.availableForSongIntro ? 'It is not a song intro.' : 'It is assigned as a song intro: the console refuses the delete (invalid) until that assignment is removed.'} A scene of ${use.readers.length} program(s) names it, it is in the bumper rotation of ${use.bumperListed.length} program(s), and it is playing as a scene background on ${use.playing.length}. The console deletes it whatever is on air; this capability refuses while it is playing (${use.playing.length}), a scene on air or staged names it (${use.onAirIn.length}) or a program with bumpers on lists it (${use.bumperOn.length}).`,
          affects: [
            {
              kind: 'instant',
              id: String(use.instant.id),
              name: use.instant.name,
            },
            ...programsAffected(
              uniq(use.readers, use.playing, use.bumperListed),
            ),
          ],
          recoverable: false,
        }),
        refuse: (args, use) =>
          whyNot([
            [
              use.playing.length > 0,
              `instant ${args.instant_id} is playing as the scene background on ${use.playing.join(', ')}`,
            ],
            [
              use.onAirIn.length > 0,
              `a scene on air or staged on ${use.onAirIn.join(', ')} names instant ${args.instant_id} as its background audio`,
            ],
            [
              use.bumperOn.length > 0,
              `instant ${args.instant_id} is in the bumper rotation of ${use.bumperOn.join(', ')}`,
            ],
          ]),
        run: (args) => this.programs.deleteInstant(args.instant_id),
      }),
      actionSpec({
        name: 'instant_play_instant',
        title: 'Play an instant on air',
        description:
          'Plays an instant once on a program (default main) now, over whatever is playing there. The console refuses a disabled instant (invalid) and an unknown one (not_found); this also refuses an unknown program.',
        permission: permissions.operate,
        tier: 'A',
        untrusted: INSTANT_UNTRUSTED,
        shape: { instant_id: rowIdArg, program_id: playProgramArg },
        load: async (args) => ({
          instant: await this.instantOf(args.instant_id),
          live: await loadProgramLive(this.programs, args.program_id),
        }),
        id: (args) => String(args.instant_id),
        label: (args, { instant, live }) =>
          `${instant.name} on ${args.program_id} (${instant.enabled ? 'enabled' : 'disabled'}; ${live.stamp})`,
        plan: (args, { instant, live }) => ({
          summary: `Plays instant ${instant.id} once on program ${args.program_id} at volume ${instant.volume}, now, over whatever is playing there; listeners and viewers hear it. ${instant.enabled ? '' : 'It is disabled: the console refuses to play it (invalid). '}A played instant cannot be recalled; instant_stop_all_instants cuts it. Live now: ${live.liveText}.`,
          affects: [
            {
              kind: 'instant',
              id: String(instant.id),
              name: instant.name,
            },
            ...programsAffected([args.program_id]),
          ],
          recoverable: true,
        }),
        run: (args) =>
          this.programs.playInstant(args.instant_id, args.program_id),
      }),
      actionSpec({
        name: 'instant_stop_all_instants',
        title: 'Stop every playing instant',
        description:
          'Cuts every instant playing on a program (default main) at once. An instant that was cut starts again from the beginning only when it is played again.',
        permission: permissions.operate,
        tier: 'A',
        shape: { program_id: playProgramArg },
        load: (args) => loadProgramLive(this.programs, args.program_id),
        id: (args) => args.program_id,
        label: (_args, live) => live.stamp,
        plan: (args, live) => ({
          summary: `Cuts every instant playing on program ${args.program_id} now. Live now: ${live.liveText}.`,
          affects: programsAffected([args.program_id]),
          recoverable: true,
        }),
        run: (args) => this.programs.stopAllInstants(args.program_id),
      }),
    ];
  }
}
