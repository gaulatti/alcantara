import { Injectable } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { WebrtcService } from '../../webrtc/webrtc.service';
import { McpToolProvider, type McpToolSpec } from '../contract';
import { programIdArg, readSpec } from './support';

const permissions = ALCANTARA_PERMISSIONS.webrtc;

/**
 * gaulatti/alcantara#219: the guest (WebRTC) capabilities: invitations, the
 * guests in a program's room and the commands sent to them. An invitation
 * link is a bearer credential, so no answer carries one (see the write
 * capabilities), and the route that issues an operator token is not a
 * capability.
 */
@Injectable()
@McpToolProvider()
export class WebrtcMcpTools {
  constructor(private readonly webrtc: WebrtcService) {}

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
          'Lists the guests invited to a program room and whether each is connected, reconnecting or offline, with their tracks and recent commands.',
        permission: permissions.read,
        shape: { program_id: programIdArg },
        run: (args) => this.webrtc.listParticipants(args.program_id),
      }),
    ];
  }
}
