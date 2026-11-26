import type { CallFailure, IcePath } from '../utils/callTelemetry';

const PATH_LABEL: Record<IcePath, string> = {
  udp: 'direct UDP',
  tcp: 'direct TCP',
  relay: 'relayed (TURN)'
};
const FAILURE_LABEL: Record<CallFailure, string> = {
  permission_denied: 'camera or microphone blocked',
  no_device: 'no camera or microphone found',
  ice_failed: 'no media path through their network',
  token_rejected: 'the call server refused the link',
  other: 'connection failed'
};

/** One line under a guest: how their call reaches the studio, or why it could not. Nothing until the guest reports. */
export function CallPathLine({ participant }: { participant: { icePath?: IcePath | null; joinFailure?: CallFailure | null; connectionState: string } }) {
  const { icePath, joinFailure, connectionState } = participant;
  // A path is the last connected call's, so it is not shown for a guest who is offline.
  const text = joinFailure ? `Could not join: ${FAILURE_LABEL[joinFailure]}` : icePath && connectionState !== 'offline' ? `Path: ${PATH_LABEL[icePath]}` : null;
  return text ? <p className='text-xs text-text-secondary'>{text}</p> : null;
}
