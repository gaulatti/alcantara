import { Button, Card, SectionHeader, StatusBadge } from '@gaulatti/bleecker';
import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AppPage } from '../components/AppPage';
import {
  TIER_LABELS,
  clientGuides,
  groupByTier,
  loadCapabilities,
  mcpUrl,
  type CapabilityLoad,
  type ClientGuide,
} from '../utils/mcpConnect';
import type { Route } from './+types/connect';

export function meta({}: Route.MetaArgs) {
  return [
    { title: 'Connect an AI client - Alcántara' },
    { name: 'description', content: 'Add the Alcántara MCP server to ChatGPT, Claude, Claude Code, Codex or Cursor' },
  ];
}

const TIER_BADGE = { R: 'info', W: 'default', A: 'warning', D: 'offline' } as const;

const ACCEPTED_CLIENTS = 'https://github.com/gaulatti/bastille/issues/34';

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setFailed(false);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setFailed(true);
    }
  };
  return (
    <span className='inline-flex items-center gap-2'>
      <Button size='sm' variant='secondary' aria-label={label} onClick={() => void copy()}>
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
      {failed ? <span role='status' className='text-xs'>Copy was blocked. Select the text and copy it.</span> : null}
    </span>
  );
}

function Guide({ guide }: { guide: ClientGuide }) {
  return (
    <Card variant='outlined' className='p-4' data-testid={`guide-${guide.id}`}>
      <section aria-labelledby={`guide-${guide.id}-title`} className='space-y-3'>
        <h3 id={`guide-${guide.id}-title`} className='text-base font-semibold'>
          {guide.name}
        </h3>
        <ol className='list-decimal space-y-1.5 pl-5 text-sm'>
          {guide.steps.map((step) => (
            <li key={step} className='break-words'>
              {step}
            </li>
          ))}
        </ol>
        {guide.snippet ? (
          <div className='space-y-1.5'>
            <div className='flex items-center justify-between gap-2'>
              <span className='text-xs opacity-70'>{guide.snippet.label}</span>
              <CopyButton text={guide.snippet.text} label={`Copy the ${guide.name} snippet`} />
            </div>
            <pre className='overflow-x-auto rounded bg-[color-mix(in_srgb,currentColor_8%,transparent)] p-3 text-xs'>
              <code>{guide.snippet.text}</code>
            </pre>
          </div>
        ) : null}
        {guide.gap ? <p className='text-xs opacity-80'>{guide.gap}</p> : null}
        <p className='text-xs'>
          Checked against{' '}
          <a className='underline' href={guide.doc.href} target='_blank' rel='noreferrer'>
            {guide.doc.label}
          </a>
          .
        </p>
      </section>
    </Card>
  );
}

function Capabilities({ load }: { load: CapabilityLoad | null }) {
  if (!load) return <p role='status' className='text-sm'>Loading the capability list…</p>;
  if (load.status === 'unavailable') {
    return (
      <Card variant='outlined' role='alert' className='p-4 text-sm'>
        The capability list is not available right now. {load.reason}
      </Card>
    );
  }
  const groups = groupByTier(load.capabilities);
  if (groups.length === 0) return <p className='text-sm'>The server lists no capabilities.</p>;
  return (
    <div className='space-y-4'>
      {groups.map(({ tier, items }) => (
        <section key={tier} aria-labelledby={`tier-${tier}`} data-testid={`tier-${tier}`}>
          <h3 id={`tier-${tier}`} className='mb-1 flex flex-wrap items-center gap-2 text-sm font-semibold'>
            <StatusBadge label={tier} variant={TIER_BADGE[tier]} />
            {TIER_LABELS[tier].title}
            <span className='text-xs font-normal opacity-70'>{TIER_LABELS[tier].meaning}</span>
          </h3>
          <ul className='divide-y divide-white/10 text-sm'>
            {items.map((capability) => (
              <li key={capability.name} className='py-1.5'>
                <span className='font-medium'>{capability.title}</span>{' '}
                <code className='text-xs opacity-70'>{capability.name}</code>
                <p className='text-xs opacity-80'>{capability.description}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export default function ConnectRoute() {
  const url = mcpUrl();
  const [load, setLoad] = useState<CapabilityLoad | null>(null);
  useEffect(() => {
    let live = true;
    void loadCapabilities().then((result) => {
      if (live) setLoad(result);
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <AppPage>
      <SectionHeader
        eyebrow='Alcántara MCP'
        title='Connect an AI client'
        description='Let an assistant look at the station and, where you allow it, work it as you. Add this address to your client, then sign in.'
      />

      <Card variant='outlined' className='space-y-2 p-4' data-testid='mcp-url'>
        <p className='text-xs opacity-70'>MCP server URL</p>
        <div className='flex flex-wrap items-center gap-2'>
          <code className='min-w-0 flex-1 break-all text-sm'>{url}</code>
          <CopyButton text={url} label='Copy the MCP server URL' />
        </div>
      </Card>

      <h2 className='mt-6 text-lg font-semibold'>Add it to your client</h2>
      <div className='mt-2 space-y-3'>
        {clientGuides(url).map((guide) => (
          <Guide key={guide.id} guide={guide} />
        ))}
      </div>

      <h2 className='mt-6 text-lg font-semibold'>What sign-in looks like</h2>
      <Card variant='outlined' className='mt-2 space-y-2 p-4 text-sm'>
        <p>The client opens your browser at the Gaulatti sign-in. Sign in with the account you use for Alcántara.</p>
        <p>
          Web clients then show a consent page that reads “&lt;app&gt; at &lt;host&gt; wants to use Alcántara as you”. Approve it only for a client you started
          yourself.
        </p>
        <p>The assistant can do only what your own Alcántara permissions allow. Nothing is shared with it beyond that.</p>
      </Card>

      <h2 className='mt-6 text-lg font-semibold'>What it can do</h2>
      <p className='mt-1 text-sm'>
        Read from the server’s own list, so it matches what is running. You will see only the capabilities your permissions allow once you are signed in.
      </p>
      <div className='mt-2'>
        <Capabilities load={load} />
      </div>

      <h2 className='mt-6 text-lg font-semibold'>Troubleshooting</h2>
      <Card variant='outlined' className='mt-2 space-y-2 p-4 text-sm'>
        <p>
          <strong>“redirect_mismatch”, or a sign-in that is refused:</strong> that client is not supported yet. The accepted clients are listed in{' '}
          <a className='underline' href={ACCEPTED_CLIENTS} target='_blank' rel='noreferrer'>
            gaulatti/bastille#34
          </a>
          .
        </p>
        <p>
          <strong>The browser shows an error at {url}:</strong> that address is for MCP clients, not for browsers. Copy it into a client above.
        </p>
        <p>
          <strong>It connects but lists no tools:</strong> your account may not hold the Alcántara permissions. Ask an owner.
        </p>
      </Card>
    </AppPage>
  );
}
