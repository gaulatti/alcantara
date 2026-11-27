import {
  LIVEKIT_PORTS,
  renderLivekitServerConfig,
  turnTlsDomainFrom,
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
      '  tcp_port: 7881\n  udp_port: 7882\n  use_external_ip: true\n',
    );
    expect(yaml).toContain('redis:\n  address: redis:6379\n');
    expect(yaml).toContain(
      '  domain: "livekit.example.test"\n  udp_port: 3478\n  relay_range_start: 30000\n  relay_range_end: 30100\n',
    );
    expect(yaml).not.toContain('port_range_');
    expect(
      yaml.endsWith(
        `keys:\n  "APIfictional": "${selected.livekitApiSecret}"\n`,
      ),
    ).toBe(true);
  });

  it('takes TURN over TLS behind nginx when the secret names it', () => {
    const yaml = renderLivekitServerConfig(selected, {
      turnTlsDomain: 'turn.example.test',
    });
    expect(yaml).toContain(
      '  domain: "turn.example.test"\n  tls_port: 5349\n  external_tls: true\n  udp_port: 3478\n',
    );
    expect(yaml).not.toContain('cert_file');
    expect(renderLivekitServerConfig(selected)).not.toContain('tls');
  });

  it('accepts only a DNS name of its own for TURN over TLS', () => {
    const url = selected.livekitWsUrl;
    expect(turnTlsDomainFrom(undefined, url)).toBeUndefined();
    expect(turnTlsDomainFrom(' Turn.Example.test ', url)).toBe(
      'turn.example.test',
    );
    for (const bad of [
      '',
      7,
      'turn',
      'turn.example.test:443',
      'https://turn.example.test',
      'livekit.example.test',
    ])
      expect(() => turnTlsDomainFrom(bad, url)).toThrow('livekitTurnTlsDomain');
  });

  it('quotes values so a key or secret cannot change the document', () => {
    const yaml = renderLivekitServerConfig({
      ...selected,
      livekitApiKey: 'API: "x"\nport: 1',
    });
    expect(yaml).toContain('  "API: \\"x\\"\\nport: 1": ');
    expect(yaml.match(/^port: /gm)).toHaveLength(1);
  });

  it('uses the ports the Helix compose file publishes, and keeps the relay range inside', () => {
    const compose = fs.readFileSync(
      path.join(__dirname, '../../../infra/helix/compose.livekit.yml'),
      'utf8',
    );
    expect(compose).toContain(
      `'127.0.0.1:${LIVEKIT_PORTS.signal}:${LIVEKIT_PORTS.signal}/tcp'`,
    );
    expect(compose).toContain(
      `'${LIVEKIT_PORTS.rtcTcp}:${LIVEKIT_PORTS.rtcTcp}/tcp'`,
    );
    for (const port of [LIVEKIT_PORTS.rtcUdp, LIVEKIT_PORTS.turnUdp])
      expect(compose).toContain(`'${port}:${port}/udp'`);
    // TURN over TLS arrives from nginx, which ended TLS: loopback only.
    expect(compose).toContain(
      `'127.0.0.1:${LIVEKIT_PORTS.turnTls}:${LIVEKIT_PORTS.turnTls}/tcp'`,
    );
    const stream = fs.readFileSync(
      path.join(__dirname, '../../../infra/helix/nginx-turn-stream.conf'),
      'utf8',
    );
    expect(stream).toContain(`proxy_pass 127.0.0.1:${LIVEKIT_PORTS.turnTls};`);
    expect(compose).not.toContain(`${LIVEKIT_PORTS.relayStart}`);
  });
});
