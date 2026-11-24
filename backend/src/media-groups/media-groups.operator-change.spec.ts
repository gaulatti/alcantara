import {
  mcpActor,
  noRecorder,
  type RecorderStub,
} from '../operator-change/operator-change-recorder.testing';
import { MediaGroupsService } from './media-groups.service';

// gaulatti/alcantara#236 slice 3: a media group change is recorded after it with no program; the size of a
// replaced media list is read before the change only when an actor will be recorded, and a failed read never
// stops the change.

function recording(): RecorderStub {
  const recorder = noRecorder();
  recorder.actor.mockReturnValue(mcpActor);
  return recorder;
}

function fixture(recorder: RecorderStub) {
  const group = {
    id: 7,
    name: 'Opening',
    description: 'Station idents',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    mediaItems: [
      {
        id: 11,
        mediaGroupId: 7,
        mediaId: 3,
        position: 0,
        media: { id: 3, assetId: 'asset-3' },
      },
      {
        id: 12,
        mediaGroupId: 7,
        mediaId: 4,
        position: 1,
        media: { id: 4, assetId: null },
      },
    ],
  };
  const tx = {
    mediaGroup: {
      create: jest.fn().mockResolvedValue({ id: 7 }),
      update: jest.fn(),
      delete: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(group),
    },
    mediaGroupItem: { createMany: jest.fn(), deleteMany: jest.fn() },
    mediaLabel: { upsert: jest.fn(), deleteMany: jest.fn() },
    mediaAssetLabel: { createMany: jest.fn(), deleteMany: jest.fn() },
  };
  const prisma = {
    mediaGroup: {
      findMany: jest.fn().mockResolvedValue([group]),
      count: jest.fn().mockResolvedValue(3),
      findUnique: jest.fn().mockResolvedValue(group),
    },
    media: { findMany: jest.fn().mockResolvedValue([{ id: 3 }, { id: 4 }]) },
    mediaGroupItem: { count: jest.fn().mockResolvedValue(5) },
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  return {
    service: new MediaGroupsService(prisma as any, recorder),
    prisma,
    tx,
    group,
  };
}

describe('MediaGroupsService operator change records', () => {
  it('records a replaced media list with its size before and after, and no program', async () => {
    const recorder = recording();
    const { service, prisma } = fixture(recorder);
    await service.update(7, { mediaIds: [3, 4] });
    expect(prisma.mediaGroupItem.count).toHaveBeenCalledWith({
      where: { mediaGroupId: 7 },
    });
    expect(recorder.record).toHaveBeenCalledWith({
      actor: mcpActor,
      target: 'media_group',
      targetId: '7',
      programId: null,
      capability: {
        mcp: 'media_group_update',
        console: 'media-groups.update',
      },
      summary: {
        changed: ['mediaIds'],
        before: { mediaIds: 5 },
        after: { mediaIds: 2 },
      },
    });
  });

  it('records the change with no size before when that read fails', async () => {
    const recorder = recording();
    const { service, prisma } = fixture(recorder);
    prisma.mediaGroupItem.count.mockRejectedValue(new Error('read failed'));
    await expect(
      service.update(7, { mediaIds: [3, 4] }),
    ).resolves.toMatchObject({ id: 7 });
    expect(recorder.record.mock.calls[0][0].summary).toEqual({
      changed: ['mediaIds'],
      before: { mediaIds: null },
      after: { mediaIds: 2 },
    });
  });

  it('reads no size when the list is not replaced, or when no actor will be recorded', async () => {
    const recorder = recording();
    const named = fixture(recorder);
    await named.service.update(7, { name: 'Fictional group' });
    expect(named.prisma.mediaGroupItem.count).not.toHaveBeenCalled();
    expect(recorder.record.mock.calls[0][0].summary).toEqual({
      changed: ['name'],
      before: {},
      after: {},
    });

    const automatic = fixture(noRecorder());
    await automatic.service.update(7, { mediaIds: [3, 4] });
    expect(automatic.prisma.mediaGroupItem.count).not.toHaveBeenCalled();
  });
});
