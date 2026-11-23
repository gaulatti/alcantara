// gaulatti/alcantara#354: the LiveKit server configuration, rendered from the
// runtime secret's LiveKit group so the keys live in one place.

/**
 * The LiveKit server's ports. infra/helix/compose.livekit.yml publishes signal
 * (on loopback), rtcTcp, rtcUdp and turnUdp; the relay range stays inside the container.
 */
const LIVEKIT_PORTS = Object.freeze({
  signal: 7880,
  rtcTcp: 7881,
  rtcUdp: 7882,
  turnUdp: 3478,
  relayStart: 30000,
  relayEnd: 30100,
});

/**
 * The server's livekit.yaml for a validated LiveKit group (`parseRuntimeSecretPayload`
 * output). Values are written as double-quoted YAML scalars; the TURN domain is the
 * signalling host.
 */
function renderLivekitServerConfig(selected) {
  const host = new URL(selected.livekitWsUrl).hostname;
  const quote = (value) => JSON.stringify(String(value));
  return [
    `port: ${LIVEKIT_PORTS.signal}`,
    'rtc:',
    `  tcp_port: ${LIVEKIT_PORTS.rtcTcp}`,
    // One muxed UDP port for every participant, so the router forwards one port;
    // LiveKit ignores udp_port when port_range_start/end are set, so they are not.
    `  udp_port: ${LIVEKIT_PORTS.rtcUdp}`,
    '  use_external_ip: true',
    'redis:',
    '  address: redis:6379',
    'turn:',
    '  enabled: true',
    `  domain: ${quote(host)}`,
    `  udp_port: ${LIVEKIT_PORTS.turnUdp}`,
    `  relay_range_start: ${LIVEKIT_PORTS.relayStart}`,
    `  relay_range_end: ${LIVEKIT_PORTS.relayEnd}`,
    '  ttl_seconds: 300',
    'keys:',
    `  ${quote(selected.livekitApiKey)}: ${quote(selected.livekitApiSecret)}`,
    '',
  ].join('\n');
}

module.exports = { LIVEKIT_PORTS, renderLivekitServerConfig };
