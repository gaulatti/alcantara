import { RadioMetricsService } from '../../radio/radio-metrics.service';
import { RadioService } from '../../radio/radio.service';
import type { McpContext } from '../contract';
import { FlightMcpTools } from './flight';
import { buildFlight } from './flight.testing';

// #788 (MCP parity, item 2): the real judgment, not a stubbed verdict. A simulcast program's own output airs on TV
// whatever its radio playout does, so a fresh playout-down report never refuses its Advance.
const ctx = { actor: { id: 'agent' } } as unknown as McpContext;
const args = { program_id: 'main' };

function build(type: 'radio' | 'both') {
  const { f, flights } = buildFlight();
  const metrics = new RadioMetricsService();
  const radio = new RadioService(
    {
      programState: { findUnique: jest.fn().mockResolvedValue({ type }) },
    } as never,
    {} as never,
    {} as never,
    metrics,
    { teamId: 0 } as never,
  );
  radio.setPlayoutReports({ playoutReport: () => 'down' });
  const spec = new FlightMcpTools(flights as never, f.programs as never, radio)
    .specs()
    .find((candidate) => candidate.name === 'program_go_flight_by_id')!;
  const count = (line: string) => metrics.render().includes(line);
  return { spec, flights, count };
}

describe('Advance with the real playout judgment, on a fresh down report', () => {
  it('advances a simulcast program, dry run included, and counts it as tv_leg', async () => {
    const { spec, flights, count } = build('both');
    expect((await spec.dryRun!(args, ctx)).summary).not.toContain('REFUSED');
    await spec.run(args, ctx);
    expect(flights.go).toHaveBeenCalledWith('main');
    expect(
      count(
        'alcantara_radio_take_playout_unconfirmed_total{report="tv_leg"} 1',
      ),
    ).toBe(true);
    expect(
      count('alcantara_radio_start_refused_total{reason="playout_down"} 0'),
    ).toBe(true);
  });

  it('refuses a radio-only program on the same report', async () => {
    const { spec, flights, count } = build('radio');
    await expect(spec.run(args, ctx)).rejects.toMatchObject({
      code: 'on_air',
    });
    expect(flights.go).not.toHaveBeenCalled();
    expect(
      count('alcantara_radio_start_refused_total{reason="playout_down"} 1'),
    ).toBe(true);
  });
});
