import {
  LIVEKIT_PORTS,
  renderLivekitServerConfig,
} from './livekit-server-config';
import * as fs from 'node:fs';
import * as path from 'node:path';

const selected = {
  livekitWsUrl: 'wss://livekit.example.test',
  livekitApiKey: 'APIfictional',
  livekitApiSecret: 'fictional-api-secret-'.padEnd(40, 'x'),
};

describe('the LiveKit server configuration rendered from the runtime secret', () => {
  it('writes the key pair, the ports and the TURN domain from the signalling host', () => {
    const yaml = renderLivekitServerConfig(selected);
    expect(yaml).toContain('port: 7880\n');
    expect(yaml).toContain(
      '  tcp_port: 7881\n  port_range_start: 50000\n  port_range_end: 50100\n  use_external_ip: true\n',
    );
    expect(yaml).toContain('redis:\n  address: redis:6379\n');
    expect(yaml).toContain(
      '  domain: "livekit.example.test"\n  udp_port: 3478\n  relay_range_start: 30000\n  relay_range_end: 30100\n',
    );
    expect(
      yaml.endsWith(
        `keys:\n  "APIfictional": "${selected.livekitApiSecret}"\n`,
      ),
    ).toBe(true);
  });

  it('quotes values so a key or secret cannot change the document', () => {
    const yaml = renderLivekitServerConfig({
      ...selected,
      livekitApiKey: 'API: "x"\nport: 1',
    });
    expect(yaml).toContain('  "API: \\"x\\"\\nport: 1": ');
    expect(yaml.match(/^port: /gm)).toHaveLength(1);
  });

  it('uses the ports the production compose file publishes', () => {
    const compose = fs.readFileSync(
      path.join(__dirname, '../../../infra/compose.production.yml'),
      'utf8',
    );
    for (const port of [LIVEKIT_PORTS.signal, LIVEKIT_PORTS.rtcTcp])
      expect(compose).toContain(`${port}:${port}/tcp`);
    expect(compose).toContain(
      `${LIVEKIT_PORTS.turnUdp}:${LIVEKIT_PORTS.turnUdp}/udp`,
    );
    expect(compose).toContain(
      `${LIVEKIT_PORTS.rtcUdpStart}-${LIVEKIT_PORTS.rtcUdpEnd}:${LIVEKIT_PORTS.rtcUdpStart}-${LIVEKIT_PORTS.rtcUdpEnd}/udp`,
    );
    expect(compose).toContain(
      `${LIVEKIT_PORTS.relayStart}-${LIVEKIT_PORTS.relayEnd}:${LIVEKIT_PORTS.relayStart}-${LIVEKIT_PORTS.relayEnd}/udp`,
    );
  });
});
