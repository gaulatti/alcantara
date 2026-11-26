import type { McpContext } from '../contract';
import { buildFlight } from './flight.testing';

// #788 (MCP parity, item 2): Advance is refused only on a fresh, explicit playout-down report (D4).
const ctx = { actor: { id: 'agent' } } as unknown as McpContext;
const args = { program_id: 'main' };

function build(verdict: string | null) {
  const f = buildFlight();
  f.radio.judgePlayout.mockResolvedValue(verdict);
  const spec = f.specs.find((s) => s.name === 'program_go_flight_by_id')!;
  return { ...f, spec };
}

describe('advancing a flight while playout is judged', () => {
  it('refuses a fresh playout-down report, in the dry run too, and counts only the run', async () => {
    const { spec, flights, radio } = build('down');
    const plan = await spec.dryRun!(args, ctx);
    expect(plan.summary).toContain(
      'REFUSED (on_air): Playout down: nothing can air. Nothing was advanced.',
    );
    expect(radio.recordPlayoutVerdict).not.toHaveBeenCalled();
    await expect(spec.run(args, ctx)).rejects.toMatchObject({
      code: 'on_air',
    });
    expect(flights.go).not.toHaveBeenCalled();
    expect(radio.recordPlayoutVerdict.mock.calls).toEqual([['down']]);
  });

  it.each([['stale'], ['unknown'], ['tv_leg'], [null]])(
    'advances when the verdict is %s, and counts it',
    async (verdict) => {
      const { spec, flights, radio } = build(verdict);
      expect((await spec.dryRun!(args, ctx)).summary).not.toContain('REFUSED');
      await spec.run(args, ctx);
      expect(flights.go).toHaveBeenCalledWith('main');
      expect(radio.recordPlayoutVerdict.mock.calls).toEqual([[verdict]]);
    },
  );
});
