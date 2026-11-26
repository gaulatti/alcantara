import { describe, expect, it, vi } from 'vitest';
import { loadCapabilities } from './mcpConnect';

// gaulatti/alcantara#527 (untriaged gaps): a capability list with a row that is not an object is refused as a whole.

const json = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe('loadCapabilities with malformed rows', () => {
  it('refuses the whole list when one row is null', async () => {
    const result = await loadCapabilities(json({ capabilities: [null] }));
    expect(result).toEqual({ status: 'unavailable', reason: 'The server sent an answer this page cannot read.' });
  });
});
