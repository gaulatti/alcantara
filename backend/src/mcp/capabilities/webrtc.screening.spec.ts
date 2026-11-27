import type { McpContext } from '../contract';
import { WebrtcMcpTools } from './webrtc';

// gaulatti/alcantara#788: Admit and Decline (screening before air) as MCP tools.

const ctx = {
  principal: { subject: 'agent', principalId: 'prn_fictional' },
} as unknown as McpContext;

function setup(screening: boolean, slotNumber: number | null = 2) {
  const invitation = {
    id: 'inv-1',
    programId: 'main',
    displayName: 'Ada',
    slotNumber,
    status: 'active',
  };
  const webrtc = {
    listInvitations: jest.fn().mockResolvedValue([invitation]),
    listParticipants: jest.fn().mockResolvedValue({
      participants: [{ invitationId: 'inv-1', screening }],
    }),
    admitGuest: jest.fn().mockResolvedValue({ status: 'admitted' }),
    declineGuest: jest.fn().mockResolvedValue({ status: 'declined' }),
  };
  const specs = new WebrtcMcpTools(webrtc as never, {} as never).specs();
  const tool = (name: string) => specs.find((spec) => spec.name === name)!;
  return { webrtc, tool };
}
const args = { invitation_id: 'inv-1' } as never;

describe('guest screening capabilities', () => {
  it('admits with a dry run and a confirm target', async () => {
    const { webrtc, tool } = setup(true);
    const admit = tool('webrtc_admit_guest');
    expect((await admit.dryRun!(args, ctx)).summary).toContain('slot 2');
    await expect(admit.confirmTarget!(args, ctx)).resolves.toEqual({
      id: 'inv-1',
      name: 'Ada (active)',
    });
    expect(webrtc.admitGuest).not.toHaveBeenCalled();
    await admit.run(args, ctx);
    expect(webrtc.admitGuest).toHaveBeenCalledWith(expect.anything(), 'inv-1');
  });

  it('admits only a guest who is waiting, as the desk does', async () => {
    const { webrtc, tool } = setup(false);
    await expect(tool('webrtc_admit_guest').run(args, ctx)).rejects.toThrow(
      'is not waiting to be admitted',
    );
    expect(webrtc.admitGuest).not.toHaveBeenCalled();
  });

  it('names the guest in a summary by the invitation id, never by the name they typed', async () => {
    const { tool } = setup(true);
    for (const name of ['webrtc_admit_guest', 'webrtc_decline_guest']) {
      const { summary } = await tool(name).dryRun!(args, ctx);
      expect(summary).toContain('inv-1');
      expect(summary).not.toContain('Ada');
    }
  });

  it('declines only a guest who is waiting', async () => {
    const waiting = setup(true);
    const decline = waiting.tool('webrtc_decline_guest');
    expect((await decline.dryRun!(args, ctx)).summary).toContain(
      'cannot be undone',
    );
    await expect(decline.confirmTarget!(args, ctx)).resolves.toMatchObject({
      id: 'inv-1',
    });
    await decline.run(args, ctx);
    expect(waiting.webrtc.declineGuest).toHaveBeenCalled();

    const admitted = setup(false, null);
    await expect(
      admitted.tool('webrtc_decline_guest').run(args, ctx),
    ).rejects.toThrow('is not waiting to be admitted');
    expect(admitted.webrtc.declineGuest).not.toHaveBeenCalled();
    expect(
      (await admitted.tool('webrtc_decline_guest').dryRun!(args, ctx)).summary,
    ).toContain('slot none');
    expect(
      (await admitted.tool('webrtc_admit_guest').dryRun!(args, ctx)).summary,
    ).toContain('slot none');
  });
});
