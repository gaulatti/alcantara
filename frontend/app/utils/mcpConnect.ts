// The /connect page (gaulatti/bastille#35): what a person needs to add Alcántara's MCP server to a
// client. Every step below was read from that client's current official documentation (the `doc`
// link on each entry); where the documentation does not state a step, the page says so and links it.

import { apiUrl } from './apiBaseUrl';

export type CapabilityTier = 'R' | 'W' | 'A' | 'D';

export interface PublicCapability {
  name: string;
  title: string;
  description: string;
  tier: CapabilityTier;
  permission: string;
}

/** The tiers as `docs/mcp.md` defines them. */
export const TIER_LABELS: Record<CapabilityTier, { title: string; meaning: string }> = {
  R: { title: 'Read', meaning: 'Looks at the station; changes nothing.' },
  W: { title: 'Reversible write', meaning: 'Changes something that can be changed back.' },
  A: { title: 'On-air action', meaning: 'Affects what listeners hear. Asks you to confirm.' },
  D: { title: 'Destructive', meaning: 'Deletes. Asks you to confirm.' },
};

export const TIER_ORDER: CapabilityTier[] = ['R', 'W', 'A', 'D'];

/** The MCP endpoint, from the same API origin the console calls. */
export function mcpUrl(): string {
  return apiUrl('/mcp');
}

/** Where the server publishes its capability list (no sign-in, no data, no arguments). */
export function capabilitiesUrl(): string {
  return apiUrl('/mcp/capabilities');
}

export interface ClientGuide {
  id: string;
  name: string;
  /** The official page every step below comes from. */
  doc: { label: string; href: string };
  /** What the documentation does not state, said plainly. */
  gap?: string;
  steps: string[];
  /** A command or file to copy, with the server URL already in it. */
  snippet?: { label: string; text: string };
}

const SERVER = 'alcantara';

export function clientGuides(url: string): ClientGuide[] {
  return [
    {
      id: 'chatgpt',
      name: 'ChatGPT (plugin)',
      doc: {
        label: 'OpenAI: Connect and test your plugin',
        href: 'https://developers.openai.com/apps-sdk/deploy/connect-chatgpt',
      },
      gap: 'The documentation does not say which plans can add a custom MCP server; it says account and workspace policies apply.',
      steps: [
        'Open ChatGPT Plugins (chatgpt.com/plugins).',
        'Select the plus button, then Add custom MCP server.',
        'Enter a name and a description.',
        `Under Connection, enter the MCP server URL including the /mcp path: ${url}`,
        'Configure authentication, review the risk warning, and select I understand and want to continue.',
        'Select Create as a plugin, then review the tools ChatGPT discovered.',
        'Sign-in starts the first time a tool is used.',
      ],
    },
    {
      id: 'claude',
      name: 'Claude (claude.ai and desktop)',
      doc: {
        label: 'Claude Help Center: custom connectors using remote MCP',
        href: 'https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp',
      },
      gap: 'The help page gives the claude.ai paths; it does not give a separate path for the desktop app. On Team and Enterprise plans an owner adds the connector first (Organization settings > Connectors), then members select Connect.',
      steps: [
        'Go to Customize > Connectors.',
        'Select + Add, then Add custom connector.',
        'Enter a name and the server URL exactly as shown above, then Continue.',
        'Review the detected authentication settings, then Continue.',
        'Select Add, then sign in when Claude asks.',
      ],
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      doc: {
        label: 'Claude Code: connect to tools via MCP',
        href: 'https://code.claude.com/docs/en/mcp',
      },
      steps: [
        'Add the server from a terminal.',
        'Inside Claude Code run /mcp and follow the steps in your browser to sign in.',
        `To remove it later: claude mcp remove ${SERVER}.`,
      ],
      snippet: {
        label: 'Terminal',
        text: `claude mcp add --transport http ${SERVER} ${url}`,
      },
    },
    {
      id: 'codex',
      name: 'Codex',
      doc: {
        label: 'Codex: Model Context Protocol',
        href: 'https://developers.openai.com/codex/mcp',
      },
      gap: 'The documentation shows a bare codex mcp add --url only together with OAuth client options, so this page uses the config file it shows instead.',
      steps: [
        'Add the server to ~/.codex/config.toml (or .codex/config.toml in a trusted project).',
        `Then sign in from a terminal: codex mcp login ${SERVER}`,
        'With no local browser, add --no-browser, open the printed URL, and paste the full redirect URL back.',
      ],
      snippet: {
        label: '~/.codex/config.toml',
        text: `[mcp_servers.${SERVER}]\nurl = "${url}"`,
      },
    },
    {
      id: 'cursor',
      name: 'Cursor',
      doc: {
        label: 'Cursor: Model Context Protocol',
        href: 'https://cursor.com/docs/context/mcp',
      },
      gap: 'For a server added by file, the documentation does not say which button or command starts sign-in; follow the page above if Cursor does not prompt you.',
      steps: [
        'Create .cursor/mcp.json in a project, or ~/.cursor/mcp.json for every project.',
        'Add the server with its url.',
      ],
      snippet: {
        label: '.cursor/mcp.json',
        text: JSON.stringify({ mcpServers: { [SERVER]: { url } } }, null, 2),
      },
    },
  ];
}

export type CapabilityLoad =
  | { status: 'ready'; capabilities: PublicCapability[] }
  | { status: 'unavailable'; reason: string };

function isCapability(value: unknown): value is PublicCapability {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.name === 'string' &&
    typeof row.title === 'string' &&
    typeof row.description === 'string' &&
    typeof row.permission === 'string' &&
    (row.tier === 'R' || row.tier === 'W' || row.tier === 'A' || row.tier === 'D')
  );
}

/** Reads the server's own capability list; a refusal or a malformed answer is reported, never replaced. */
export async function loadCapabilities(fetchImpl: typeof fetch = fetch): Promise<CapabilityLoad> {
  let response: Response;
  try {
    response = await fetchImpl(capabilitiesUrl(), { headers: { Accept: 'application/json' } });
  } catch {
    return { status: 'unavailable', reason: 'The server could not be reached.' };
  }
  if (!response.ok) {
    return { status: 'unavailable', reason: `The server answered ${response.status}.` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: 'unavailable', reason: 'The server sent an answer this page cannot read.' };
  }
  const rows = (body as { capabilities?: unknown } | null)?.capabilities;
  if (!Array.isArray(rows) || !rows.every(isCapability)) {
    return { status: 'unavailable', reason: 'The server sent an answer this page cannot read.' };
  }
  return { status: 'ready', capabilities: rows };
}

export function groupByTier(capabilities: PublicCapability[]): Array<{ tier: CapabilityTier; items: PublicCapability[] }> {
  return TIER_ORDER.map((tier) => ({
    tier,
    items: capabilities.filter((capability) => capability.tier === tier).sort((a, b) => a.title.localeCompare(b.title)),
  })).filter((group) => group.items.length > 0);
}
