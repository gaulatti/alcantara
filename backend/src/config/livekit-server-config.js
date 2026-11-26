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
  turnTls: 5349,
  relayStart: 30000,
  relayEnd: 30100,
});

/**
 * The TURN-over-TLS name from the runtime secret's `livekitTurnTlsDomain`, or undefined when it has none. It must be a
 * DNS name of its own: nginx on Helix tells TURN from the web by the name a client asks for on 443.
 */
function turnTlsDomainFrom(value, livekitWsUrl) {
  if (value === undefined) return undefined;
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (
    !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
      name,
    ) ||
    name === new URL(livekitWsUrl).hostname
  ) {
    throw new Error(
      'LiveKit TURN TLS domain (livekitTurnTlsDomain) must be a DNS name other than the signalling host',
    );
  }
  return name;
}

/**
 * The server's livekit.yaml for a validated LiveKit group (`parseRuntimeSecretPayload`
 * output). Values are written as double-quoted YAML scalars. With a TURN TLS name, LiveKit also takes TURN over TLS:
 * it advertises `turns:<name>:443`, and nginx ends TLS and passes it the plain stream on turnTls. Without one the TURN
 * domain is the signalling host and only UDP TURN is offered.
 */
function renderLivekitServerConfig(selected, { turnTlsDomain } = {}) {
  const host = turnTlsDomain ?? new URL(selected.livekitWsUrl).hostname;
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
    ...(turnTlsDomain
      ? [`  tls_port: ${LIVEKIT_PORTS.turnTls}`, '  external_tls: true']
      : []),
    `  udp_port: ${LIVEKIT_PORTS.turnUdp}`,
    `  relay_range_start: ${LIVEKIT_PORTS.relayStart}`,
    `  relay_range_end: ${LIVEKIT_PORTS.relayEnd}`,
    '  ttl_seconds: 300',
    'keys:',
    `  ${quote(selected.livekitApiKey)}: ${quote(selected.livekitApiSecret)}`,
    '',
  ].join('\n');
}

module.exports = {
  LIVEKIT_PORTS,
  renderLivekitServerConfig,
  turnTlsDomainFrom,
};
