import type { ProgramFillerState } from '../models/filler';

/**
 * A `GET /broadcast/programs/:programId/fillers` response for a `both`
 * program, in the shape #126's backend spec asserts: the television leg is
 * running one version with another prepared next; the radio leg has a
 * prepared shuffle and nothing active. Fictional values only.
 */
export const FILLER_FIXTURE: ProgramFillerState = {
  programId: 'both-1',
  legs: {
    television: {
      pending: {
        version: 'filler-tv-2b1f0c1e-7a1d-4d2f-9f3e-3c7b5a1e9d42',
        checksum: '9f1c4e2a7b3d5f6e8a0c1b2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f',
        status: 'ready',
        reason: null,
        config: {
          sources: [{ assetId: 'media:7', sha256: 'a'.repeat(64) }],
          mode: 'loop',
          profileChecksum: 'b'.repeat(64),
        },
        createdAt: '2026-11-17T12:00:01.000Z',
        preparedAt: '2026-11-17T12:00:09.000Z',
      },
      active: {
        version: 'filler-tv-0c8e1b3a-1f2e-4c5d-8a9b-6e7f8a9b0c1d',
        checksum: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
        status: 'ready',
        reason: null,
        config: {
          sources: [{ assetId: 'media:3', sha256: 'c'.repeat(64) }],
          mode: 'loop',
          profileChecksum: 'b'.repeat(64),
        },
        createdAt: '2026-11-16T09:00:00.000Z',
        preparedAt: '2026-11-16T09:00:07.000Z',
      },
    },
    radio: {
      pending: {
        version: 'filler-radio-5d4c3b2a-1e0f-4a9b-8c7d-6e5f4a3b2c1d',
        checksum: 'd'.repeat(64),
        status: 'ready',
        reason: null,
        config: {
          sources: [
            { assetId: 'song:1', sha256: 'e'.repeat(64) },
            { assetId: 'song:2', sha256: 'f'.repeat(64) },
          ],
          mode: 'shuffle',
          shuffleSeed: 'rotation-7',
        },
        createdAt: '2026-11-17T11:00:00.000Z',
        preparedAt: '2026-11-17T11:00:30.000Z',
      },
      active: null,
    },
  },
};
