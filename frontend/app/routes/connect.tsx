import { Button, Card } from '@gaulatti/bleecker';
import { useState } from 'react';

// bastille#35: the public page a browser reaches from /mcp (no sign-in). It shows
// the MCP address and links to each client's official docs; nothing here is secret.
export const MCP_URL = 'https://api.alcantara.gaulatti.com/mcp';

export const CLIENT_DOCS = [
  { name: 'ChatGPT', href: 'https://help.openai.com/en/articles/12584461' },
  { name: 'Claude', href: 'https://claude.com/docs/connectors/custom' },
  { name: 'Claude Code', href: 'https://code.claude.com/docs/en/mcp' },
  { name: 'Codex', href: 'https://developers.openai.com/codex/mcp' },
  { name: 'Cursor', href: 'https://cursor.com/docs/mcp' },
] as const;

export default function Connect() {
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(MCP_URL);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  };

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 16 }}>
      <h1>Connect Alcántara</h1>
      <p>Alcántara&apos;s MCP server lets an AI client read the radio and TV console. Add it with this address:</p>
      <Card>
        <code style={{ wordBreak: 'break-all' }}>{MCP_URL}</code>
        <div style={{ marginTop: 8 }}>
          <Button type="button" onClick={copy}>Copy MCP URL</Button>
          <span role="status" aria-live="polite" style={{ marginLeft: 8 }}>
            {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed: select the address and copy it by hand' : ''}
          </span>
        </div>
      </Card>
      <h2>Official setup guides</h2>
      <ul>
        {CLIENT_DOCS.map((client) => (
          <li key={client.name}>
            <a href={client.href} target="_blank" rel="noreferrer">
              {client.name}: official MCP guide
            </a>
          </li>
        ))}
      </ul>
      <p>If a sign-in is refused or the client is not supported, see the list of accepted clients in bastille#34.</p>
    </main>
  );
}
