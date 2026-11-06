const mockCtor = jest.fn();
const mockConnect = jest.fn();
const mockDisconnect = jest.fn();
const mockAdapter = { adapter: true };

jest.mock('@prisma/client', () => ({
  PrismaClient: class {
    constructor(options: unknown) {
      mockCtor(options);
    }
    $connect = mockConnect;
    $disconnect = mockDisconnect;
  },
}));
jest.mock('./prisma-adapter', () => ({
  createPostgresAdapter: jest.fn(() => mockAdapter),
}));

import { createPostgresAdapter } from './prisma-adapter';
import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  it('constructs the client with the postgres adapter built from DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/db';
    new PrismaService();
    expect(createPostgresAdapter).toHaveBeenCalledWith(
      'postgres://u:p@h:5432/db',
    );
    expect(mockCtor).toHaveBeenCalledWith({ adapter: mockAdapter });
  });

  it('connects on module init and disconnects on destroy', async () => {
    const service = new PrismaService();
    mockConnect.mockResolvedValue(undefined);
    mockDisconnect.mockResolvedValue(undefined);
    await service.onModuleInit();
    expect(mockConnect).toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });
});
