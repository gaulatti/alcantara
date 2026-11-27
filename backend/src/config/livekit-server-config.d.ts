import type { RuntimeSecretPayload } from './runtime-secret-contract';

export const LIVEKIT_PORTS: Readonly<{
  signal: number;
  rtcTcp: number;
  rtcUdp: number;
  turnUdp: number;
  turnTls: number;
  relayStart: number;
  relayEnd: number;
}>;

export function renderLivekitServerConfig(
  selected: Required<
    Pick<
      RuntimeSecretPayload,
      'livekitWsUrl' | 'livekitApiKey' | 'livekitApiSecret'
    >
  >,
  options?: { turnTlsDomain?: string },
): string;

export function turnTlsDomainFrom(
  value: unknown,
  livekitWsUrl: string,
): string | undefined;
