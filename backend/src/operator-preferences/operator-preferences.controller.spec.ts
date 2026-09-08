import { OperatorPreferencesController } from './operator-preferences.controller';

describe('OperatorPreferencesController canonical identity boundary', () => {
  const authorization = {
    permissions: ['alcantara:access'],
    teamId: 1,
  };
  const request = {
    user: {
      authorization,
      principalId: 'principal-a',
      sub: 'pool-subject-a',
    },
  };
  const preferences = {
    get: jest.fn(),
    publish: jest.fn(),
  };
  const controller = new OperatorPreferencesController(preferences as never);

  beforeEach(() => jest.clearAllMocks());

  it('passes both identities to private preference reads', async () => {
    await controller.get('desktop', request);

    expect(preferences.get).toHaveBeenCalledWith(
      { principalId: 'principal-a', subject: 'pool-subject-a' },
      'desktop',
    );
  });

  it('passes both identities to shared-layout writes', async () => {
    const body = { name: 'Fixture' };
    await controller.publish(body, request);

    expect(preferences.publish).toHaveBeenCalledWith(
      { principalId: 'principal-a', subject: 'pool-subject-a' },
      body,
      authorization,
    );
  });
});
