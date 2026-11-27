import { Injectable } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { WebrtcService } from '../../webrtc/webrtc.service';
import { ReturnRouterService } from '../../webrtc/return-router.service';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { ProgramService } from '../../program/program.service';
import { z } from 'zod';
import { McpToolError } from '../contract';
import { identityOf } from './preferences';
import { whyNot } from './on-air';
import { actionSpec, present, programIdArg, readSpec } from './support';

const permissions = ALCANTARA_PERMISSIONS.webrtc;

const invitationIdArg = z.string().trim().min(1).max(64);
const identityArg = z.string().trim().min(1).max(64);
/** The return feed a guest hears and sees; the console's own bounds. */
const returnShape = {
  return_video: z.enum(['program', 'preview', 'none']).optional(),
  return_audio_bus: z
    .string()
    .regex(/^(master|monitor|aux-[1-8])$/)
    .optional(),
  source_gain: z.number().min(0).max(1).optional(),
  source_muted: z.boolean().optional(),
  source_delay_ms: z.number().int().min(0).max(2000).optional(),
};

interface Invitation {
  id: string;
  programId: string;
  displayName: string;
  slotNumber: number | null;
  status: string;
  returnVideo: string;
  returnAudioBus: string;
  sourceGain: number;
  sourceMuted: boolean;
  sourceDelayMs: number;
}

interface Participants {
  participants: Array<{
    identity: string;
    name: string;
    connectionState: string;
  }>;
}

interface ListedProgram {
  programId: string;
  activeSceneId: number | null;
  fadeToBlack: boolean;
}

/** The program id as the guest routes normalize it. */
const normalized = (programId: string): string =>
  programId.trim().toLowerCase();

/**
 * gaulatti/alcantara#219: the guest (WebRTC) capabilities: invitations, the
 * guests in a program's room and the commands sent to them. The routes that
 * produce a guest link (create and replace an invitation) or an operator token
 * are not capabilities: each returns a credential (appendix A, excluded).
 *
 * Step 0 of the D rows. webrtc_revoke_invitation: the console revokes the
 * invitation (its link stops working for good, its slot is freed) and removes
 * the guest from the room if connected, whatever is on air. webrtc_remove_
 * participant: the console disconnects the guest at once and clears their
 * session, but the invitation stays valid, so the guest can rejoin with the
 * same link. Neither looks at what is on air. Both refuse with on_air while the
 * guest is connected and the program has a scene or fade to black on air (the
 * guest may be in the picture); a guest who is not connected, or a program off
 * air, is not refused.
 */
@Injectable()
@McpToolProvider()
export class WebrtcMcpTools {
  constructor(
    private readonly webrtc: WebrtcService,
    private readonly programs: ProgramService,
    private readonly returns: ReturnRouterService,
  ) {}

  specs(): McpToolSpec[] {
    return [
      readSpec({
        name: 'webrtc_list_invitations',
        title: 'List guest invitations',
        description:
          'Lists the guest invitations (program, guest name, slot, return feed, gain, expiry, status and the last ten commands sent). The invitation link itself is never returned.',
        permission: permissions.read,
        shape: {},
        run: () => this.webrtc.listInvitations(),
      }),
      readSpec({
        name: 'webrtc_list_participants',
        title: 'List the guests in a program room',
        description:
          'Lists the guests invited to a program room: whether each is connected, reconnecting or offline; whether each is waiting to be admitted (screening); whether their return feed is reaching them (returnReaching: healthy, stalled or missing, null until their page reports); the cue that holds now (cueState: live, standby, wrap, rejoined for a guest cued live who came back off air and needs a new cue, or null when none was sent); and their tracks and recent commands. The operator\'s own "Mic on air" is not in this list; webrtc_host_mic_off takes it off air.',
        permission: permissions.read,
        shape: { program_id: programIdArg },
        run: (args) => this.webrtc.listParticipants(args.program_id),
      }),
      readSpec({
        name: 'webrtc_health',
        title: 'Check that calls work',
        description:
          'Says whether the call chain of a program works now, as the calls desk reads it: returnRunner (whether guests are sent the studio sound), contribution (whether a cued guest can reach air) and livekit (whether the calls server answers), each ok, down or unknown (livekit is only ok or down), with checkedAt. unknown means nothing has been heard either way, for example for a few seconds after a backend restart; it is not ok.',
        permission: permissions.read,
        shape: { program_id: programIdArg },
        run: (args) => this.returns.health(args.program_id),
      }),
      actionSpec({
        name: 'webrtc_update_return',
        title: 'Change what a guest sees and hears',
        description:
          'Sets the return feed of an invitation: the video (program, preview or none), the audio bus (master, monitor or aux-1 to aux-8), the gain from 0 to 1, mute and delay up to 2000 ms. As in the console, a field not given is set to its default (program, master, 1, not muted, 0), not left unchanged: give every field you want to keep.',
        permission: permissions.operate,
        tier: 'A',
        shape: { invitation_id: invitationIdArg, ...returnShape },
        load: (args) => this.invitation(args.invitation_id),
        id: (args) => args.invitation_id,
        label: (_args, invitation) =>
          `${invitation.displayName} (${invitation.status})`,
        plan: (args, invitation) => {
          const next = `video ${args.return_video ?? 'program'}, bus ${args.return_audio_bus ?? 'master'}, gain ${args.source_gain ?? 1}, ${args.source_muted ? 'muted' : 'not muted'}, delay ${args.source_delay_ms ?? 0} ms`;
          const now = `video ${invitation.returnVideo}, bus ${invitation.returnAudioBus}, gain ${invitation.sourceGain}, ${invitation.sourceMuted ? 'muted' : 'not muted'}, delay ${invitation.sourceDelayMs} ms`;
          return {
            summary: `Sets the return feed of invitation ${invitation.id} to ${next} (now ${now}). Fields not given go to their defaults.${invitation.status === 'active' ? ' The guest is connected and is sent the change at once.' : ''}`,
            affects: [
              {
                kind: 'invitation',
                id: invitation.id,
                name: invitation.displayName,
              },
            ],
            recoverable: true,
          };
        },
        run: (args, _invitation, ctx) =>
          this.webrtc.updateReturn(
            identityOf(ctx),
            args.invitation_id,
            present({
              returnVideo: args.return_video,
              returnAudioBus: args.return_audio_bus,
              sourceGain: args.source_gain,
              sourceMuted: args.source_muted,
              sourceDelayMs: args.source_delay_ms,
            }),
          ),
      }),
      actionSpec({
        name: 'webrtc_control_participant',
        title: 'Send a command to a guest',
        description:
          'Sends one command to a connected guest of a program room: type "media" (device camera or microphone, enabled; disabling mutes the published track), "cue" (standby, live or wrap), "message" (text of up to 500 characters shown to the guest) or "talkback" (enabled).',
        permission: permissions.operate,
        tier: 'A',
        shape: {
          program_id: programIdArg,
          identity: identityArg,
          type: z.enum(['media', 'cue', 'message', 'talkback']),
          device: z.enum(['camera', 'microphone']).optional(),
          enabled: z.boolean().optional(),
          cue: z.enum(['standby', 'live', 'wrap']).optional(),
          text: z.string().max(500).optional(),
        },
        load: (args) => this.participant(args.program_id, args.identity),
        id: (args) => args.program_id,
        label: (_args, guest) => `${guest.name} (${guest.connectionState})`,
        plan: (args, guest) => ({
          summary: `Sends a ${args.type} command to guest ${guest.identity} of program ${args.program_id} (${guest.connectionState}). The guest sees or hears it at once${args.type === 'media' && args.enabled === false ? '; their ' + (args.device ?? 'device') + ' track is muted' : ''}. A command cannot be recalled; send the opposite one.`,
          affects: [
            {
              kind: 'participant',
              id: guest.identity,
              name: guest.name,
            },
          ],
          recoverable: true,
        }),
        run: (args) =>
          this.webrtc.controlParticipant(
            args.program_id,
            args.identity,
            present({
              type: args.type,
              device: args.device,
              enabled: args.enabled,
              cue: args.cue,
              text: args.text,
            }),
          ),
      }),
      actionSpec({
        name: 'webrtc_admit_guest',
        title: 'Admit a waiting guest',
        description:
          'The calls desk’s Admit (screening before air): lets a guest who is waiting onto their strip, from where they can reach returns and the output through a scene. Their page joins the program room by itself. Refused for a guest who is not waiting, as the desk offers Admit only to one.',
        permission: permissions.operate,
        tier: 'A',
        shape: { invitation_id: invitationIdArg },
        load: (args) => this.screened(args.invitation_id),
        id: (args) => args.invitation_id,
        label: (_args, { invitation }) =>
          `${invitation.displayName} (${invitation.status})`,
        plan: (_args, { invitation }) => ({
          summary: `Admits guest ${invitation.id} (${invitation.status}) onto slot ${invitation.slotNumber ?? 'none'} of program ${invitation.programId}.`,
          affects: [
            {
              kind: 'invitation',
              id: invitation.id,
              name: invitation.displayName,
            },
          ],
          recoverable: true,
        }),
        // The desk offers Admit only to a guest who is waiting.
        refuse: (args, { waiting }) =>
          waiting
            ? null
            : `guest ${args.invitation_id} is not waiting to be admitted`,
        run: (args, _loaded, ctx) =>
          this.webrtc.admitGuest(identityOf(ctx), args.invitation_id),
      }),
      actionSpec({
        name: 'webrtc_host_mic_off',
        title: 'Take the host microphone off air',
        description:
          'Takes the operator\'s own microphone off air in a program: every published host microphone track (the Mic on air track) is muted on the server, so it stops reaching air whatever the page does. When no host microphone is published it reports no-host-mic and mutes nothing. Reports muted only after LiveKit confirms each mute.',
        permission: permissions.operate,
        tier: 'A',
        shape: { program_id: programIdArg },
        load: (args) => this.webrtc.hostMicTracks(args.program_id),
        id: (args) => args.program_id,
        label: () => 'Host microphone',
        plan: (args, tracks) => ({
          summary:
            tracks.length === 0
              ? `No host microphone is published in program ${args.program_id}, so nothing is muted.`
              : `Mutes ${tracks.length} host microphone track(s) on air in program ${args.program_id}. LiveKit confirms each mute before it is reported.`,
          affects: tracks.map((track) => ({
            kind: 'participant',
            id: track.identity,
            name: 'Host microphone',
          })),
          recoverable: true,
        }),
        run: (args) => this.webrtc.muteHostMic(args.program_id),
      }),
      actionSpec({
        name: 'webrtc_decline_guest',
        title: 'Decline a waiting guest',
        description:
          'The calls desk’s Decline: turns a waiting guest away, revokes their link for good and frees the slot. Refused for a guest already admitted: use webrtc_remove_participant or webrtc_revoke_invitation.',
        permission: permissions.operate,
        tier: 'D',
        shape: { invitation_id: invitationIdArg },
        load: (args) => this.screened(args.invitation_id),
        id: (args) => args.invitation_id,
        label: (_args, { invitation }) =>
          `${invitation.displayName} (${invitation.status})`,
        plan: (_args, { invitation }) => ({
          summary: `Declines guest ${invitation.id}: their link stops working for good and slot ${invitation.slotNumber ?? 'none'} is freed. It cannot be undone.`,
          affects: [
            {
              kind: 'invitation',
              id: invitation.id,
              name: invitation.displayName,
            },
          ],
          recoverable: false,
        }),
        // The desk offers Decline only to a guest who is waiting.
        refuse: (args, { waiting }) =>
          waiting
            ? null
            : `guest ${args.invitation_id} is not waiting to be admitted`,
        run: (args, _loaded, ctx) =>
          this.webrtc.declineGuest(identityOf(ctx), args.invitation_id),
      }),
      actionSpec({
        name: 'webrtc_revoke_invitation',
        title: 'Revoke a guest invitation',
        description:
          'Revokes a guest invitation: its link stops working for good, its slot is freed and a connected guest is removed from the room. Refused with on_air while the guest is connected and the program has a scene or fade to black on air.',
        permission: permissions.operate,
        tier: 'D',
        shape: { invitation_id: invitationIdArg },
        load: async (args) => {
          const invitation = await this.invitation(args.invitation_id);
          return {
            invitation,
            programOnAir: await this.onAir(invitation.programId),
          };
        },
        id: (args) => args.invitation_id,
        label: (_args, { invitation }) =>
          `${invitation.displayName} (${invitation.status})`,
        plan: (_args, { invitation, programOnAir }) => ({
          summary: `Revokes invitation ${invitation.id} (${invitation.status}, slot ${invitation.slotNumber ?? 'none'}, program ${invitation.programId}): its link stops working for good and the slot is freed${invitation.status === 'active' ? '; the connected guest is removed from the room' : ''}. The console does this whatever is on air; this capability refuses while the guest is connected and program ${invitation.programId} is on air (${programOnAir ? 'it is' : 'it is not'} now). A revoked invitation cannot be restored: a new one with a new link is needed.`,
          affects: [
            {
              kind: 'invitation',
              id: invitation.id,
              name: invitation.displayName,
            },
          ],
          recoverable: false,
        }),
        refuse: (_args, { invitation, programOnAir }) =>
          whyNot([
            [
              invitation.status === 'active' && programOnAir,
              `guest ${invitation.id} is connected and program ${invitation.programId} is on air`,
            ],
          ]),
        run: (args, _loaded, ctx) =>
          this.webrtc.revokeInvitation(identityOf(ctx), args.invitation_id),
      }),
      actionSpec({
        name: 'webrtc_remove_participant',
        title: 'Remove a guest from a room',
        description:
          'Disconnects a guest from a program room and clears their session; the invitation stays valid, so the guest can rejoin with the same link. Refused with on_air while the guest is connected and the program has a scene or fade to black on air.',
        permission: permissions.operate,
        tier: 'D',
        shape: { program_id: programIdArg, identity: identityArg },
        load: async (args) => ({
          guest: await this.participant(args.program_id, args.identity),
          programOnAir: await this.onAir(args.program_id),
        }),
        id: (args) => args.identity,
        label: (_args, { guest }) => `${guest.name} (${guest.connectionState})`,
        plan: (args, { guest, programOnAir }) => ({
          summary: `Disconnects guest ${guest.identity} (${guest.connectionState}) from the room of program ${args.program_id} and clears their session. The invitation stays valid and the guest can rejoin with the same link. The console does this whatever is on air; this capability refuses while the guest is connected and the program is on air (${programOnAir ? 'it is' : 'it is not'} now).`,
          affects: [
            {
              kind: 'participant',
              id: guest.identity,
              name: guest.name,
            },
          ],
          recoverable: true,
        }),
        refuse: (args, { guest, programOnAir }) =>
          whyNot([
            [
              guest.connectionState === 'connected' && programOnAir,
              `guest ${guest.identity} is connected and program ${args.program_id} is on air`,
            ],
          ]),
        run: (args, _loaded, ctx) =>
          this.webrtc.removeParticipant(
            identityOf(ctx),
            args.program_id,
            args.identity,
          ),
      }),
    ];
  }

  private async invitation(id: string): Promise<Invitation> {
    const found = ((await this.webrtc.listInvitations()) as Invitation[]).find(
      (invitation) => invitation.id === id,
    );
    if (!found) throw new McpToolError('not_found', 'Invitation not found.');
    return found;
  }

  /** An invitation and whether its guest is waiting in screening, as the desk's Admit and Decline read it. */
  private async screened(id: string) {
    const invitation = await this.invitation(id);
    const { participants } = await this.webrtc.listParticipants(
      invitation.programId,
    );
    return {
      invitation,
      waiting: participants.some(
        (guest) => guest.invitationId === invitation.id && guest.screening,
      ),
    };
  }

  private async participant(programId: string, identity: string) {
    const room = (await this.webrtc.listParticipants(
      programId,
    )) as Participants;
    const found = room.participants.find(
      (guest) => guest.identity === identity,
    );
    if (!found)
      throw new McpToolError('not_found', 'Active invitation not found.');
    return found;
  }

  /** Whether the program has a scene or fade to black on air. */
  private async onAir(programId: string): Promise<boolean> {
    const listed =
      (await this.programs.listPrograms()) as unknown as ListedProgram[];
    const program = listed.find(
      (candidate) => candidate.programId === normalized(programId),
    );
    return program
      ? program.activeSceneId !== null || program.fadeToBlack
      : false;
  }
}
