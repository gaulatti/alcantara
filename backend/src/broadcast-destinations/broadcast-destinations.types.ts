export const DESTINATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const DESTINATION_VERSION_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const DESTINATION_SECRET_ID_PATTERN = /^[A-Za-z0-9/_+=,.@:-]{1,512}$/;
export const MAX_DESTINATIONS = 20;

export interface DestinationReference {
  id: string;
  secretId: string;
  versionId: string;
}

export interface DestinationSelectionPayload {
  version: string;
  destinations: DestinationReference[];
}

export interface SafeDestinationState {
  id: string;
  mode: string;
  supervisorHealthy: boolean;
  publisherProcessHealthy: boolean;
}

/** The renderer's effective RTMP profile, as gaulatti/alana#29 reports it. */
export interface TelevisionLiveProfile {
  width: number;
  height: number;
  fps: number;
  videoBitrate: string;
  audioRate: number;
  audioChannels: number;
  audioBitrate: string;
  gop: number;
  loopSeconds: number;
}

/** A filler acknowledgement, reduced to the fields Alcantara binds against. */
export interface SafeAlanaFiller {
  version: string;
  status: string;
  ready: boolean;
  sourceId?: string;
  sourceSha256?: string;
  profileChecksum?: string;
}

export interface SafeAlanaState {
  requestedState: string;
  actualState: string;
  transition: string | null;
  readiness: boolean;
  lastSequence: number;
  activeDestinations: SafeDestinationMetadata | null;
  pendingDestinations: SafeDestinationMetadata | null;
  destinations: SafeDestinationState[];
  commandResult: {
    action: string;
    result: string;
    status: number;
    sequence: number;
    destinationVersion?: string;
    destinationSelectionHash?: string;
    destinationCount?: number;
  } | null;
  error?: string;
  activeFiller?: SafeAlanaFiller;
  pendingFiller?: SafeAlanaFiller;
}

export interface SafeDestinationMetadata {
  version: string;
  selectionHash: string;
  count: number;
  destinationIds: string[];
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
