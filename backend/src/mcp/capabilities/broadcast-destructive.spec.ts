/* eslint-disable @typescript-eslint/no-unsafe-assignment -- the services are exercised through loosely typed fakes. */
import { NotFoundException } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { specNamed } from './capabilities.testing';
import {
  callerWith,
  externalSource,
  invitation,
  participants,
  preferenceRow,
  sharedLayout,
} from './broadcast.testing';
import { ExternalSourcesMcpTools } from './external-sources';
import { OperatorPreferencesMcpTools } from './preferences';
import { WebrtcMcpTools } from './webrtc';

// Step 0 of every D row of gaulatti/alcantara#219: what the console does when
// the target is on air, queued or referenced, and what the capability does
// instead. The console acts in every one of these cases; the capability
// refuses with on_air, and its dry run says what would be lost.

const p = ALCANTARA_PERMISSIONS;
const ctx = callerWith(p.access, p.webrtc.operate, p.layout.manage);
const answers = (value: unknown) => jest.fn().mockResolvedValue(value);

const program = (overrides: Record<string, unknown> = {}) => ({
  programId: 'main',
  activeSceneId: null as number | null,
  stagedSceneId: null as number | null,
  fadeToBlack: false,
  scenes: [{ sceneId: 3, scene: { externalSourceId: 'src-1' } }],
  ...overrides,
});

function build() {
  const programs = { listPrograms: answers([program()]) };
  const sources = {
    get: answers(externalSource),
    list: answers([externalSource]),
    revoke: answers({ id: 'src-1', lifecycle: 'revoked' }),
  };
  const webrtc = {
    listInvitations: answers([invitation]),
    listParticipants: answers(participants),
    revokeInvitation: answers({ id: 'inv-1', status: 'revoked' }),
    removeParticipant: answers({ identity: 'g', status: 'removed' }),
  };
  const preferences = {
    get: answers(preferenceRow),
    reset: answers({ ok: true }),
    retire: answers({ ...sharedLayout, retiredAt: new Date() }),
  };
  const prisma = {
    sharedConsoleLayout: { findUnique: answers(sharedLayout) },
  };
  const specs = [
    ...new ExternalSourcesMcpTools(
      sources as never,
      { teamId: 7 } as never,
      programs as never,
    ).specs(),
    ...new WebrtcMcpTools(
      webrtc as never,
      programs as never,
      {} as never,
    ).specs(),
    ...new OperatorPreferencesMcpTools(
      preferences as never,
      { teamId: 7 } as never,
      prisma as never,
    ).specs(),
  ];
  return {
    programs,
    sources,
    webrtc,
    preferences,
    prisma,
    spec: (name: string) => specNamed(specs, name),
  };
}

async function refused(
  b: ReturnType<typeof build>,
  name: string,
  args: Record<string, unknown>,
  service: jest.Mock,
  words: RegExp,
) {
  const plan = await b.spec(name).dryRun!(args, ctx);
  expect(plan.onAir).toBe(true);
  expect(plan.summary).toMatch(/^REFUSED \(on_air\): /);
  expect(plan.summary).toMatch(words);
  await expect(b.spec(name).run(args, ctx)).rejects.toMatchObject({
    code: 'on_air',
    message: expect.stringMatching(words),
  });
  expect(service).not.toHaveBeenCalled();
}

describe('external_source_revoke', () => {
  const args = { source_id: 'src-1' };

  it.each([
    ['on air', { activeSceneId: 3 }],
    ['staged', { stagedSceneId: 3 }],
  ])(
    'is refused with on_air while a scene that points at it is %s',
    (_why, state) => {
      const b = build();
      b.programs.listPrograms.mockResolvedValue([program(state)]);
      return refused(
        b,
        'external_source_revoke',
        args,
        b.sources.revoke,
        /points at external source src-1 is on air or staged on program\(s\) main/,
      );
    },
  );

  it('says what is lost, as unrecoverable, and runs while no such scene is live', async () => {
    const b = build();
    b.programs.listPrograms.mockResolvedValue([program({ activeSceneId: 9 })]);
    const plan = await b.spec('external_source_revoke').dryRun!(args, ctx);
    expect(plan.onAir).toBe(false);
    expect(plan.recoverable).toBe(false);
    expect(plan.summary).toMatch(
      /1 program\(s\) have a scene that points at it \(main\)/,
    );
    expect(plan.summary).toMatch(/cannot be restored/);
    expect(plan.summary).toMatch(
      /The console revokes it even when such a scene is on air/,
    );
    expect(plan.affects.map((entry) => entry.kind)).toEqual([
      'external_source',
      'program',
    ]);
    await expect(
      b.spec('external_source_revoke').run(args, ctx),
    ).resolves.toMatchObject({
      result: { id: 'src-1', lifecycle: 'revoked' },
      audit: { target: 'src-1' },
    });
    expect(b.sources.revoke).toHaveBeenCalledWith('src-1', {
      teamId: 7,
      permissions: [...ctx.principal.permissions],
    });
  });

  it('confirms against the source as it is now', async () => {
    const b = build();
    const before = await b.spec('external_source_revoke').confirmTarget!(
      args,
      ctx,
    );
    b.sources.get.mockResolvedValue({
      ...externalSource,
      lifecycle: 'offline',
    });
    const after = await b.spec('external_source_revoke').confirmTarget!(
      args,
      ctx,
    );
    expect(before.id).toBe('src-1');
    expect(after.name).not.toBe(before.name);
  });

  it('reports a source that is not there as not_found', async () => {
    const b = build();
    b.sources.get.mockRejectedValue(
      new NotFoundException('External source not found'),
    );
    await expect(
      b.spec('external_source_revoke').run(args, ctx),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('webrtc_revoke_invitation', () => {
  const args = { invitation_id: 'inv-1' };

  it('is refused with on_air while the guest is connected and the program is on air', async () => {
    const b = build();
    b.programs.listPrograms.mockResolvedValue([program({ activeSceneId: 3 })]);
    await refused(
      b,
      'webrtc_revoke_invitation',
      args,
      b.webrtc.revokeInvitation,
      /guest inv-1 is connected and program main is on air/,
    );
  });

  it('is refused on a fade to black as well', async () => {
    const b = build();
    b.programs.listPrograms.mockResolvedValue([program({ fadeToBlack: true })]);
    await refused(
      b,
      'webrtc_revoke_invitation',
      args,
      b.webrtc.revokeInvitation,
      /is on air/,
    );
  });

  it.each([
    ['the program is off air', 'active', {}],
    ['the guest is not connected', 'available', { activeSceneId: 3 }],
  ])(
    'runs when %s, and says the link is lost for good',
    async (_why, status, state) => {
      const b = build();
      b.webrtc.listInvitations.mockResolvedValue([{ ...invitation, status }]);
      b.programs.listPrograms.mockResolvedValue([program(state)]);
      const plan = await b.spec('webrtc_revoke_invitation').dryRun!(args, ctx);
      expect(plan.onAir).toBe(false);
      expect(plan.recoverable).toBe(false);
      expect(plan.summary).toMatch(/link stops working for good/);
      expect(plan.summary).toMatch(/cannot be restored/);
      await b.spec('webrtc_revoke_invitation').run(args, ctx);
      expect(b.webrtc.revokeInvitation).toHaveBeenCalledWith(
        { subject: 'sub-1', principalId: 'principal-1' },
        'inv-1',
      );
    },
  );

  it('reports an unknown invitation as not_found', async () => {
    const b = build();
    await expect(
      b.spec('webrtc_revoke_invitation').run({ invitation_id: 'nope' }, ctx),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('webrtc_remove_participant', () => {
  const guest = participants.participants[0].identity;
  const args = { program_id: 'main', identity: guest };

  it('is refused with on_air while the guest is connected and the program is on air', async () => {
    const b = build();
    b.programs.listPrograms.mockResolvedValue([program({ activeSceneId: 3 })]);
    await refused(
      b,
      'webrtc_remove_participant',
      args,
      b.webrtc.removeParticipant,
      /is connected and program main is on air/,
    );
  });

  it('runs for a guest who is not connected, and says they can rejoin', async () => {
    const b = build();
    b.programs.listPrograms.mockResolvedValue([program({ activeSceneId: 3 })]);
    b.webrtc.listParticipants.mockResolvedValue({
      ...participants,
      participants: [
        { ...participants.participants[0], connectionState: 'offline' },
      ],
    });
    const plan = await b.spec('webrtc_remove_participant').dryRun!(args, ctx);
    expect(plan.onAir).toBe(false);
    expect(plan.recoverable).toBe(true);
    expect(plan.summary).toMatch(/can rejoin with the same link/);
    await b.spec('webrtc_remove_participant').run(args, ctx);
    expect(b.webrtc.removeParticipant).toHaveBeenCalledWith(
      { subject: 'sub-1', principalId: 'principal-1' },
      'main',
      guest,
    );
  });

  it('runs while the program is off air', async () => {
    const b = build();
    await expect(
      b.spec('webrtc_remove_participant').run(args, ctx),
    ).resolves.toMatchObject({ result: { status: 'removed' } });
  });

  it('reports a guest who is not invited as not_found', async () => {
    const b = build();
    await expect(
      b
        .spec('webrtc_remove_participant')
        .run({ program_id: 'main', identity: 'guest-unknown' }, ctx),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('preference_retire', () => {
  const args = { layout_id: 'layout-1' };

  it('is never an on_air case: it says what is lost and runs', async () => {
    const b = build();
    const plan = await b.spec('preference_retire').dryRun!(args, ctx);
    expect(plan.onAir).toBe(false);
    expect(plan.recoverable).toBe(true);
    expect(plan.summary).toMatch(/copies already loaded stay/);
    expect(plan.summary).toMatch(/publishing the same name again restores it/);
    const target = await b.spec('preference_retire').confirmTarget!(args, ctx);
    expect(target).toEqual({
      id: 'layout-1',
      name: `${sharedLayout.name} v${sharedLayout.version}`,
    });
    await b.spec('preference_retire').run(args, ctx);
    expect(b.preferences.retire).toHaveBeenCalledWith('layout-1', {
      permissions: [...ctx.principal.permissions],
      teamId: 7,
    });
  });

  it('reports a layout that is not there as not_found', async () => {
    const b = build();
    b.prisma.sharedConsoleLayout.findUnique.mockResolvedValue(null);
    await expect(
      b.spec('preference_retire').run(args, ctx),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(b.preferences.retire).not.toHaveBeenCalled();
  });
});

describe('preference_reset_class and preference_reset_all', () => {
  const identity = { subject: 'sub-1', principalId: 'principal-1' };

  it("reset_class deletes only the caller's own profile and says it cannot be recovered", async () => {
    const b = build();
    const spec = b.spec('preference_reset_class');
    const plan = await spec.dryRun!({ device_class: 'desktop' }, ctx);
    expect(plan).toMatchObject({ onAir: false, recoverable: false });
    expect(plan.summary).toMatch(/version 3/);
    expect(plan.summary).toMatch(/cannot be recovered/);
    expect(await spec.confirmTarget!({ device_class: 'desktop' }, ctx)).toEqual(
      {
        id: 'desktop',
        name: 'version 3',
      },
    );
    await spec.run({ device_class: 'desktop' }, ctx);
    expect(b.preferences.reset).toHaveBeenCalledWith(identity, 'desktop');
  });

  it('reset_class has nothing to lose when nothing is saved', async () => {
    const b = build();
    b.preferences.get.mockResolvedValue({ ...preferenceRow, version: 0 });
    const plan = await b.spec('preference_reset_class').dryRun!(
      { device_class: 'phone' },
      ctx,
    );
    expect(plan.recoverable).toBe(true);
    expect(plan.summary).toMatch(/Nothing is saved/);
  });

  it('reset_all lists every saved version and deletes them all', async () => {
    const b = build();
    b.preferences.get.mockImplementation((_who: unknown, deviceClass: string) =>
      Promise.resolve({
        ...preferenceRow,
        version: deviceClass === 'phone' ? 0 : 2,
      }),
    );
    const spec = b.spec('preference_reset_all');
    const plan = await spec.dryRun!({}, ctx);
    expect(plan.recoverable).toBe(false);
    expect(plan.affects.map((entry) => entry.id)).toEqual([
      'desktop',
      'tablet',
    ]);
    expect(await spec.confirmTarget!({}, ctx)).toEqual({
      id: 'all',
      name: 'desktop v2 tablet v2 phone v0',
    });
    await spec.run({}, ctx);
    expect(b.preferences.reset).toHaveBeenCalledWith(identity);
  });
});
