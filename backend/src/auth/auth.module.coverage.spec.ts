import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth.module';
import { AuthController } from './auth.controller';
import { TestAuthController } from './test-auth.controller';
import { PompeiiAuthorizationGuard } from './pompeii-authorization.guard';
import { PompeiiService } from './pompeii.service';
import { RealtimeTicketService } from './realtime-ticket.service';
import { TestAuthService } from './test-auth.service';

describe('AuthModule wiring', () => {
  it('is global, imports config, and exposes the auth controllers', () => {
    expect(Reflect.getMetadata('__module:global__', AuthModule)).toBe(true);
    expect(Reflect.getMetadata('imports', AuthModule)).toEqual([ConfigModule]);
    expect(Reflect.getMetadata('controllers', AuthModule)).toEqual([
      AuthController,
      TestAuthController,
    ]);
  });

  it('provides and exports the auth services and registers the global guard', () => {
    const providers = Reflect.getMetadata('providers', AuthModule) as unknown[];
    expect(providers).toEqual(
      expect.arrayContaining([
        PompeiiService,
        RealtimeTicketService,
        TestAuthService,
        { provide: APP_GUARD, useClass: PompeiiAuthorizationGuard },
      ]),
    );
    expect(Reflect.getMetadata('exports', AuthModule)).toEqual([
      PompeiiService,
      RealtimeTicketService,
      TestAuthService,
    ]);
  });
});
