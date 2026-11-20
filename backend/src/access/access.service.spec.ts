import { Logger } from '@nestjs/common';
import { AccessController } from './access.controller';
import { AccessError, AccessService } from './access.service';

// Sparse and failing answers of Pompeii, against a fake PompeiiService: the
// wire is covered with a real gRPC server in access.http.spec.ts.

const AUTH = 'Bearer placeholder';

function serviceAnswering(answer: unknown, credential = true) {
  const accessCall = jest.fn().mockResolvedValue(answer);
  const metrics = { recordAccessRequest: jest.fn() };
  const service = new AccessService(
    {
      hasAccessCredential: () => credential,
      accessCall,
    } as never,
    metrics as never,
  );
  return { service, accessCall, metrics };
}

describe('AccessService', () => {
  it('fills what Pompeii leaves out with empty values, and never adds a field', async () => {
    const { service } = serviceAnswering({
      tokens: [{ id: 'a', unknown_field: 'x' }],
      roles: [{}],
      grants: [{}],
      entries: [{}],
      token: null,
    });
    const empty = {
      id: '',
      name: '',
      display_prefix: '',
      permissions: [],
      created_at: '',
      expires_at: '',
      last_used_at: '',
      created_via_application: '',
      last_used_application: '',
    };
    expect(await service.listTokens(AUTH, 'console')).toEqual({
      tokens: [{ ...empty, id: 'a' }],
    });
    expect(await service.createToken(AUTH, 'mcp', { name: 'n' })).toEqual({
      token: empty,
      value: '',
    });
    expect(await service.listRoles(AUTH, 'console')).toEqual({
      roles: [{ id: 0, name: '', permissions: [] }],
    });
    const grant = {
      id: 0,
      user_id: 0,
      user_email: '',
      role_id: 0,
      role_name: '',
      team_id: 0,
      granted_at: '',
    };
    expect(await service.listGrants(AUTH, 'console')).toEqual({
      grants: [grant],
    });
    expect(
      await service.grant(AUTH, 'console', { user_id: 1, role_id: 1 }),
    ).toEqual(grant);
    expect(await service.listHistory(AUTH, 'console')).toEqual({
      entries: [
        {
          at: '',
          action: '',
          actor_email: '',
          target: '',
          via_application: '',
          via_client: '',
        },
      ],
    });
    expect(await service.getTokenSwitch(AUTH, 'console')).toEqual({
      enabled: false,
    });
  });

  it('reads empty lists when Pompeii answers nothing', async () => {
    const { service } = serviceAnswering({});
    expect(await service.listTokens(AUTH, 'console')).toEqual({ tokens: [] });
    expect(await service.listRoles(AUTH, 'console')).toEqual({ roles: [] });
    expect(await service.listGrants(AUTH, 'console')).toEqual({ grants: [] });
    expect(await service.listHistory(AUTH, 'console', {})).toEqual({
      entries: [],
    });
    expect(await service.setTokenSwitch(AUTH, 'mcp', true)).toEqual({
      enabled: false,
    });
  });

  it('sends the via_client it is given and team 0', async () => {
    const { service, accessCall } = serviceAnswering({ enabled: true });
    await service.getTokenSwitch(AUTH, 'mcp');
    expect(accessCall).toHaveBeenCalledWith('GetTokenSwitch', {
      bearer_token: AUTH,
      team_id: 0,
      via_client: 'mcp',
    });
  });

  it('reports a failure without a grpc code as unavailable, never as Pompeii message', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { service, accessCall, metrics } = serviceAnswering(undefined);
    accessCall.mockRejectedValue(new Error('connect ECONNREFUSED secret-host'));
    await expect(service.listTokens(AUTH, 'console')).rejects.toEqual(
      expect.objectContaining({ code: 'access_unavailable', status: 503 }),
    );
    expect(String(warn.mock.calls[0])).toContain('unknown');
    expect(String(warn.mock.calls[0])).not.toContain('secret-host');
    expect(metrics.recordAccessRequest).toHaveBeenCalledWith(
      'tokens_list',
      'unavailable',
      expect.any(Number),
    );
    warn.mockRestore();
  });

  it('works without a metrics service', async () => {
    const service = new AccessService({
      hasAccessCredential: () => false,
    } as never);
    await expect(service.listTokens(AUTH, 'console')).rejects.toBeInstanceOf(
      AccessError,
    );
  });
});

describe('AccessController', () => {
  it('lets a failure that is not an AccessError through as it is', async () => {
    const boom = new Error('not ours');
    const controller = new AccessController({
      listTokens: () => Promise.reject(boom),
    } as never);
    await expect(
      controller.listTokens({ headers: { authorization: AUTH } }),
    ).rejects.toBe(boom);
  });
});

describe('AccessController my-permissions', () => {
  it('answers an empty list for a request that carries no decision', () => {
    const controller = new AccessController({} as never);
    expect(controller.myPermissions({ headers: {} })).toEqual({
      permissions: [],
    });
    expect(
      controller.myPermissions({ headers: {}, user: { authorization: {} } }),
    ).toEqual({ permissions: [] });
  });
});
