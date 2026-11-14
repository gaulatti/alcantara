import * as fs from 'fs';
import * as path from 'path';

export interface IngressConfig {
  logging?: { level?: string };
  api_key?: string;
  api_secret?: string;
  ws_url?: string;
  redis?: { address?: string };
  health_port?: number;
  prometheus_port?: number;
  whip_port?: number;
  http_relay_port?: number;
  rtc_config?: { udp_port?: number; use_external_ip?: boolean };
  cpu_cost?: {
    rtmp_cpu_cost?: number;
    whip_cpu_cost?: number;
    whip_bypass_transcoding_cpu_cost?: number;
    url_cpu_cost?: number;
    min_idle_ratio?: number;
  };
  rtmp_port?: number;
  srt_port?: number;
  protocols?: {
    rtmp?: { enabled?: boolean };
    srt?: { enabled?: boolean };
    whip?: { enabled?: boolean };
    hls?: { enabled?: boolean };
  };
  [key: string]: unknown;
}

export interface ComposePortMapping {
  hostIp?: string;
  hostPort: number;
  containerPort: number;
  protocol: string;
  raw: string;
}

export function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split('\n');
  const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [
    { indent: -1, obj: result },
  ];

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '');
    if (!line.trim()) continue;
    const indent = rawLine.search(/\S/);
    const trimmed = line.trim();

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const current = stack[stack.length - 1].obj;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const valStr = trimmed.slice(colonIdx + 1).trim();

    if (valStr === '') {
      const child: Record<string, unknown> = {};
      current[key] = child;
      stack.push({ indent, obj: child });
    } else {
      let val: unknown = valStr;
      if (val === 'true') val = true;
      else if (val === 'false') val = false;
      else if (!isNaN(Number(val)) && val !== '') val = Number(val);
      else if (
        (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) ||
        (typeof val === 'string' && val.startsWith("'") && val.endsWith("'"))
      ) {
        val = (val as string).slice(1, -1);
      }
      current[key] = val;
    }
  }
  return result;
}

export function parsePortString(rawPort: string): ComposePortMapping | null {
  const trimmed = rawPort.replace(/['"]/g, '').trim();
  const [portPart, protoPart] = trimmed.split('/');
  const protocol = protoPart || 'tcp';
  const segments = portPart.split(':');

  if (segments.length === 1) {
    // Only container port specified, not published to host
    return null;
  }
  if (segments.length === 2) {
    // hostPort:containerPort
    const [h, c] = segments;
    return {
      hostIp: undefined,
      hostPort: parseInt(h, 10),
      containerPort: parseInt(c, 10),
      protocol,
      raw: trimmed,
    };
  }
  if (segments.length === 3) {
    // hostIp:hostPort:containerPort
    const [ip, h, c] = segments;
    return {
      hostIp: ip,
      hostPort: parseInt(h, 10),
      containerPort: parseInt(c, 10),
      protocol,
      raw: trimmed,
    };
  }
  return null;
}

export function isLoopbackOrPrivateIp(ip?: string): boolean {
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true;
  return false;
}

export function validateIngressConfig(config: IngressConfig): void {
  // RTMP must be disabled
  if (config.rtmp_port && config.rtmp_port > 0) {
    throw new Error(
      `RTMP is enabled in ingress config (rtmp_port: ${config.rtmp_port}). It must remain disabled until a canary proves stream keys are not logged.`,
    );
  }
  if (config.protocols?.rtmp?.enabled === true) {
    throw new Error(
      'RTMP is enabled in protocols.rtmp. It must remain disabled.',
    );
  }

  // SRT must be disabled
  if (config.srt_port && config.srt_port > 0) {
    throw new Error(
      `SRT is enabled in ingress config (srt_port: ${config.srt_port}). It must remain disabled until certified on Intel production host.`,
    );
  }
  if (config.protocols?.srt?.enabled === true) {
    throw new Error('SRT is enabled in protocols.srt. It must remain disabled.');
  }

  // WHIP must be enabled
  if (!config.whip_port || config.whip_port <= 0) {
    throw new Error('WHIP must be enabled with a valid whip_port (e.g. 8080)');
  }

  // Capacity: min_idle_ratio >= 0.3 (reserves 30% CPU per ADR 001)
  if (!config.cpu_cost || (config.cpu_cost.min_idle_ratio ?? 0) < 0.3) {
    throw new Error(
      'cpu_cost.min_idle_ratio must be configured to at least 0.3 (30% CPU reservation per ADR 001)',
    );
  }

  // Secrets: must be placeholders only
  if (config.api_key && !config.api_key.includes('replace-')) {
    throw new Error('api_key must be a placeholder, not a real secret');
  }
  if (config.api_secret && !config.api_secret.includes('replace-')) {
    throw new Error('api_secret must be a placeholder, not a real secret');
  }
}

export function validateComposePorts(composeContent: string): void {
  const sensitivePorts = [6379, 8081, 8082, 7888, 7889];
  const forbiddenPorts = [1935, 19000, 9710]; // RTMP, SRT

  const lines = composeContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('-') && (trimmed.includes(':') || trimmed.includes('/'))) {
      const portStr = trimmed.replace(/^-\s*/, '');
      const parsed = parsePortString(portStr);
      if (!parsed) continue;

      if (forbiddenPorts.includes(parsed.containerPort) || forbiddenPorts.includes(parsed.hostPort)) {
        throw new Error(
          `Forbidden protocol port ${parsed.containerPort} published in compose: "${parsed.raw}". RTMP and SRT must not be published.`,
        );
      }

      if (
        sensitivePorts.includes(parsed.containerPort) ||
        sensitivePorts.includes(parsed.hostPort)
      ) {
        if (!isLoopbackOrPrivateIp(parsed.hostIp)) {
          throw new Error(
            `Sensitive port ${parsed.containerPort} published without loopback or private bind address: "${parsed.raw}". Must bind to 127.0.0.1 or a private IP.`,
          );
        }
      }
    }
  }
}

export function validateComposeServices(composeContent: string): void {
  // Ingress service must exist and be pinned to v1.5.0
  const hasIngressService = /ingress:\s*\n/m.test(composeContent);
  if (!hasIngressService) {
    throw new Error('compose.production.yml must define an ingress service');
  }
  const hasPinnedImage = /image:\s*['"]?livekit\/ingress:v1\.5\.0['"]?/m.test(
    composeContent,
  );
  if (!hasPinnedImage) {
    throw new Error(
      'ingress service in compose.production.yml must use pinned image livekit/ingress:v1.5.0 matching spike',
    );
  }
}

describe('LiveKit Ingress Production Infrastructure Definition', () => {
  const infraDir = path.resolve(__dirname, '../..');
  const composePath = path.join(infraDir, 'compose.production.yml');
  const ingressYamlPath = path.join(infraDir, 'ingress.production.example.yaml');
  const spikeComposePath = path.resolve(
    infraDir,
    '../spikes/livekit-ingress/compose.yml',
  );

  test('production compose defines ingress service matching pinned spike version', () => {
    const composeContent = fs.readFileSync(composePath, 'utf-8');
    const spikeContent = fs.readFileSync(spikeComposePath, 'utf-8');

    // Extract pinned image from spike
    const spikeMatch = spikeContent.match(/image:\s*(livekit\/ingress:[^\s]+)/);
    expect(spikeMatch).toBeTruthy();
    const spikeImage = spikeMatch![1];
    expect(spikeImage).toBe('livekit/ingress:v1.5.0');

    validateComposeServices(composeContent);
    expect(composeContent).toContain(spikeImage);
  });

  test('production compose enforces loopback/private binding for sensitive ports (redis, health, metrics)', () => {
    const composeContent = fs.readFileSync(composePath, 'utf-8');
    expect(() => validateComposePorts(composeContent)).not.toThrow();
  });

  test('production ingress configuration adheres to safety and capacity rules', () => {
    const ingressContent = fs.readFileSync(ingressYamlPath, 'utf-8');
    const parsed = parseSimpleYaml(ingressContent) as IngressConfig;

    validateIngressConfig(parsed);
    expect(parsed.rtmp_port).toBe(0);
    expect(parsed.whip_port).toBe(8080);
    expect(parsed.cpu_cost?.min_idle_ratio).toBe(0.3);
  });

  test('validation fails when RTMP is enabled in ingress configuration', () => {
    const brokenConfig: IngressConfig = {
      api_key: 'replace-api-key',
      api_secret: 'replace-api-secret',
      whip_port: 8080,
      cpu_cost: { min_idle_ratio: 0.3 },
      rtmp_port: 1935, // Deliberately enabled
    };
    expect(() => validateIngressConfig(brokenConfig)).toThrow(
      /RTMP is enabled in ingress config/,
    );
  });

  test('validation fails when SRT is enabled in ingress configuration', () => {
    const brokenConfig: IngressConfig = {
      api_key: 'replace-api-key',
      api_secret: 'replace-api-secret',
      whip_port: 8080,
      cpu_cost: { min_idle_ratio: 0.3 },
      rtmp_port: 0,
      srt_port: 19000, // Deliberately enabled
    };
    expect(() => validateIngressConfig(brokenConfig)).toThrow(
      /SRT is enabled in ingress config/,
    );
  });

  test('validation fails when Redis, health or metrics port is published without loopback address', () => {
    const brokenComposePublicHealth = `
services:
  ingress:
    image: livekit/ingress:v1.5.0
    ports:
      - '8081:8081' # Public health port!
`;
    expect(() => validateComposePorts(brokenComposePublicHealth)).toThrow(
      /Sensitive port 8081 published without loopback or private bind address/,
    );

    const brokenComposePublicRedis = `
services:
  redis:
    image: redis:7.4-alpine
    ports:
      - '0.0.0.0:6379:6379' # Public redis!
`;
    expect(() => validateComposePorts(brokenComposePublicRedis)).toThrow(
      /Sensitive port 6379 published without loopback or private bind address/,
    );

    const brokenComposePublicMetrics = `
services:
  ingress:
    image: livekit/ingress:v1.5.0
    ports:
      - '8082:8082' # Public metrics!
`;
    expect(() => validateComposePorts(brokenComposePublicMetrics)).toThrow(
      /Sensitive port 8082 published without loopback or private bind address/,
    );
  });

  test('validation fails when RTMP port is published in compose', () => {
    const brokenComposeRtmp = `
services:
  ingress:
    image: livekit/ingress:v1.5.0
    ports:
      - '1935:1935' # RTMP port published!
`;
    expect(() => validateComposePorts(brokenComposeRtmp)).toThrow(
      /Forbidden protocol port 1935 published in compose/,
    );
  });
});
