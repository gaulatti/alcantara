import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { McpToolError } from '../contract';
import { specNamed } from './capabilities.testing';
import { callerWith, palazzoStatus, recovery } from './broadcast.testing';
import { RadioMcpTools, recoveryRefusal } from './radio';

// #788 (MCP parity with the radio desk): radio_start_recovery and radio_stop_recovery refuse what the desk's
// Start with fallback and Hold · stop session disable, on the same service path (setRecoveryAutomation), and the
// dry run says so before anything is sent. Fictional programs only.

const p = ALCANTARA_PERMISSIONS;
const ctx = callerWith(p.radio.operate, p.radio.read);

const stopped = {
  ...recovery,
  automation: {
    ...recovery.automation,
    filler: { activeVersion: null, ready: false },
  },
};
const running = recovery;

function tools(state: unknown, status: unknown = palazzoStatus) {
  const radio = {
    getRecoveryStatus: jest.fn().mockResolvedValue(state),
    setRecoveryAutomation: jest.fn().mockResolvedValue(running),
  };
  const telemetry = { getStatus: jest.fn().mockReturnValue(status) };
  const specs = new RadioMcpTools(
    radio as never,
    {} as never,
    telemetry as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  ).specs();
  return { radio, telemetry, spec: (name: string) => specNamed(specs, name) };
}

const live = (state: typeof stopped, playoutDown = false) => ({
  ...state,
  playoutDown,
});

describe('recoveryRefusal: the desk rule for its recovery buttons', () => {
  it('offers Start only with playout up, a prepared playlist, a connected Palazzo and no session running', () => {
    expect(recoveryRefusal('start', live(stopped))).toBeNull();
    expect(recoveryRefusal('start', live(stopped, true))).toBe(
      'Playout down: nothing can air, the recovery playlist included: Start with fallback is unavailable until playout is back',
    );
    expect(
      recoveryRefusal('start', live({ ...stopped, preparedVersion: null } as never)),
    ).toBe(
      'No recovery playlist is prepared: prepare one with radio_prepare_recovery first',
    );
    expect(
      recoveryRefusal(
        'start',
        live({ ...stopped, connection: 'unavailable', automation: null } as never),
      ),
    ).toBe('Palazzo recovery status is unavailable');
    expect(recoveryRefusal('start', live(running))).toBe(
      'A recovery session is already running',
    );
  });

  it('offers Stop only while a session runs, whatever the playout', () => {
    expect(recoveryRefusal('stop', live(running, true))).toBeNull();
    expect(recoveryRefusal('stop', live(stopped))).toBe(
      'No recovery session is running',
    );
    expect(
      recoveryRefusal('stop', live({ ...stopped, automation: null } as never)),
    ).toBe('No recovery session is running');
  });
});

describe('radio_start_recovery and radio_stop_recovery refuse as the desk does', () => {
  it('refuses Start while Palazzo reports its playout down, in the dry run and the run, and sends nothing', async () => {
    const t = tools(stopped, { ...palazzoStatus, playout: 'down' });
    const spec = t.spec('radio_start_recovery');
    const plan = await spec.dryRun!({ program_id: 'main' }, ctx);
    expect(plan.summary).toMatch(/^REFUSED \(on_air\): Playout down/);
    expect(plan.onAir).toBe(true);
    await expect(spec.run({ program_id: 'main' }, ctx)).rejects.toMatchObject({
      code: 'on_air',
    });
    await expect(spec.run({ program_id: 'main' }, ctx)).rejects.toBeInstanceOf(
      McpToolError,
    );
    expect(t.telemetry.getStatus).toHaveBeenCalledWith('main');
    expect(t.radio.setRecoveryAutomation).not.toHaveBeenCalled();
  });

  // Yakko's #796 review: the desk counts a polling Palazzo as answering too (RadioPanel engineReady).
  it('refuses Start on playout down from a polling Palazzo, as the desk does', async () => {
    const t = tools(stopped, {
      ...palazzoStatus,
      connection: 'polling',
      playout: 'down',
    });
    await expect(
      t.spec('radio_start_recovery').run({ program_id: 'main' }, ctx),
    ).rejects.toMatchObject({ code: 'on_air' });
    expect(t.radio.setRecoveryAutomation).not.toHaveBeenCalled();
  });

  it('reads playout down only from a connected Palazzo, as the desk does', async () => {
    for (const status of [
      { ...palazzoStatus, connection: 'unavailable', playout: 'down' },
      { ...palazzoStatus, playout: 'up' },
      null,
    ]) {
      const t = tools(stopped, status);
      await t.spec('radio_start_recovery').run({ program_id: 'main' }, ctx);
      expect(t.radio.setRecoveryAutomation).toHaveBeenCalledWith(
        'main',
        'start',
      );
    }
  });

  it('refuses a second Start while a session runs, and a Stop with none', async () => {
    const start = tools(running);
    await expect(
      start.spec('radio_start_recovery').run({ program_id: 'main' }, ctx),
    ).rejects.toMatchObject({ code: 'on_air' });
    const stop = tools(stopped);
    const plan = await stop
      .spec('radio_stop_recovery')
      .dryRun!({ program_id: 'main' }, ctx);
    expect(plan.summary).toMatch(
      /^REFUSED \(on_air\): No recovery session is running/,
    );
    await expect(
      stop.spec('radio_stop_recovery').run({ program_id: 'main' }, ctx),
    ).rejects.toMatchObject({ code: 'on_air' });
    expect(start.radio.setRecoveryAutomation).not.toHaveBeenCalled();
    expect(stop.radio.setRecoveryAutomation).not.toHaveBeenCalled();
  });

  it('stops a running session even with playout down', async () => {
    const t = tools(running, { ...palazzoStatus, playout: 'down' });
    await t.spec('radio_stop_recovery').run({ program_id: 'main' }, ctx);
    expect(t.radio.setRecoveryAutomation).toHaveBeenCalledWith('main', 'stop');
  });
});
