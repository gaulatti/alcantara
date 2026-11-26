import { apiUrl } from './apiBaseUrl';

/** What a call reports about itself, so production shows whether calls work (counted by the API). */
export type IcePath = 'udp' | 'tcp' | 'relay';
export type CallFailure = 'permission_denied' | 'no_device' | 'ice_failed' | 'token_rejected' | 'other';

type Stat = {
  type?: string;
  selectedCandidatePairId?: string;
  selected?: boolean;
  nominated?: boolean;
  state?: string;
  localCandidateId?: string;
  candidateType?: string;
  protocol?: string;
};
type StatsReport = { get(id: string): Stat | undefined; values(): Iterable<Stat> };
type Publication = { track?: { getRTCStatsReport?: () => Promise<unknown> } };
type Publisher = { trackPublications?: Map<string, Publication> };
export type CallRoom = { localParticipant?: Publisher; remoteParticipants?: Map<string, Publisher> };

/** The path of the selected candidate pair: relayed by TURN, or direct over UDP or TCP. */
export function selectedIcePath(report: StatsReport): IcePath | null {
  const stats = [...report.values()];
  const pairId = stats.find((stat) => stat.type === 'transport' && stat.selectedCandidatePairId)?.selectedCandidatePairId;
  // Firefox has no transport stats: it marks the pair itself.
  const pair = pairId ? report.get(pairId) : stats.find((stat) => stat.type === 'candidate-pair' && (stat.selected || (stat.nominated && stat.state === 'succeeded')));
  const local = pair?.localCandidateId ? report.get(pair.localCandidateId) : undefined;
  if (!local) return null;
  if (local.candidateType === 'relay') return 'relay';
  return local.protocol === 'udp' || local.protocol === 'tcp' ? local.protocol : null;
}

/** The room's ICE path, read from the first track whose stats name one; null when none does yet. */
export async function roomIcePath(room: CallRoom | null): Promise<IcePath | null> {
  const participants = [room?.localParticipant, ...(room?.remoteParticipants?.values() ?? [])];
  for (const participant of participants) {
    for (const publication of participant?.trackPublications?.values() ?? []) {
      try {
        const report = await publication.track?.getRTCStatsReport?.();
        const path = report ? selectedIcePath(report as StatsReport) : null;
        if (path) return path;
      } catch {
        // A track being torn down has no stats; another one may.
      }
    }
  }
  return null;
}

/** Why a call could not start, from what getUserMedia or LiveKit threw. */
export function callFailureReason(error: unknown): CallFailure {
  const { name, reasonName } = (error ?? {}) as { name?: string; reasonName?: string };
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission_denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no_device';
  if (name === 'ConnectionError') {
    if (reasonName === 'NotAllowed') return 'token_rejected';
    // The signal connected but media did not: LiveKit's "could not establish pc connection".
    if (reasonName === 'InternalError' || reasonName === 'Timeout') return 'ice_failed';
  }
  return 'other';
}

/** Tells the API a guest could not join. A report that cannot be sent is dropped: it must not disturb the guest. */
export async function reportJoinFailure(invitation: string, error: unknown) {
  try {
    await fetch(apiUrl('/webrtc/join/failure'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invitation, reason: callFailureReason(error) })
    });
  } catch {
    // The studio is unreachable: nothing to report to.
  }
}
