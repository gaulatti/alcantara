import { Test } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { RealtimeTicketService } from './realtime-ticket.service';
import { ALCANTARA_PERMISSIONS } from './permissions';
import { REQUIRED_PERMISSION_KEY } from './require-permission.decorator';

describe('AuthController', () => {
  const tickets = {
    issue: jest.fn().mockReturnValue({ ticket: 't', expiresInMs: 15000 }),
  };
  let controller: AuthController;

  beforeEach(async () => {
    tickets.issue.mockClear();
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: RealtimeTicketService, useValue: tickets }],
    }).compile();
    controller = moduleRef.get(AuthController);
  });

  it('returns the authenticated request user from /auth/me', () => {
    const user = {
      sub: 'subject-a',
      principalId: 'principal-a',
      authorization: {
        permission: 'alcantara:access',
        permissions: ['alcantara:access'],
        roles: ['operator'],
        teamId: 3,
      },
    };
    expect(controller.getMe({ user })).toBe(user);
  });

  it('issues a realtime ticket for a string program id', () => {
    expect(controller.issueRealtimeTicket({ programId: 'show-1' })).toEqual({
      ticket: 't',
      expiresInMs: 15000,
    });
    expect(tickets.issue).toHaveBeenCalledWith('show-1');
  });

  it.each([undefined, 42, null, { id: 'x' }])(
    'defaults the program id to main for non-string input %p',
    (programId) => {
      controller.issueRealtimeTicket({ programId });
      expect(tickets.issue).toHaveBeenCalledWith('main');
    },
  );

  it('protects each route with the documented permission', () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSION_KEY,
        AuthController.prototype.getMe,
      ),
    ).toBe(ALCANTARA_PERMISSIONS.access);
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSION_KEY,
        AuthController.prototype.issueRealtimeTicket,
      ),
    ).toBe(ALCANTARA_PERMISSIONS.program.read);
  });
});
