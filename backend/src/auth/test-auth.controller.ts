import { Controller, Get, NotFoundException, Query } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import { Public } from './public.decorator';
import { TEST_AUTH_AUDIENCE, TEST_AUTH_ISSUER, testAuthEnabled, testAuthSecret } from './test-auth';

const PROFILES = {
  viewer: { sub: 'test:alcantara-viewer', email: 'viewer@alcantara.local.test', name: 'Valerie Viewer' },
  manager: { sub: 'test:alcantara-manager', email: 'manager@alcantara.local.test', name: 'Morgan Manager' },
  operator: { sub: 'test:alcantara-operator', email: 'operator@alcantara.local.test', name: 'Oriana Operator' },
  denied: { sub: 'test:alcantara-denied', email: 'denied@alcantara.local.test', name: 'Dana Denied' },
  admin: { sub: 'test:alcantara-admin', email: 'admin@alcantara.local.test', name: 'Avery Administrator' }
} as const;

type Profile = keyof typeof PROFILES;

@Controller('__test')
export class TestAuthController {
  @Public()
  @Get('session')
  session(@Query('profile') requested?: string) {
    if (!testAuthEnabled()) throw new NotFoundException();
    const profile: Profile = requested && requested in PROFILES ? requested as Profile : 'admin';
    const user = PROFILES[profile];
    const expiresIn = 15 * 60;
    const accessToken = sign({
      sub: user.sub,
      email: user.email,
      email_verified: true,
      given_name: user.name.split(' ')[0],
      family_name: user.name.split(' ').slice(1).join(' '),
      name: user.name,
      token_use: 'id'
    }, testAuthSecret(), {
      algorithm: 'HS256',
      audience: TEST_AUTH_AUDIENCE,
      issuer: TEST_AUTH_ISSUER,
      expiresIn
    });
    return { accessToken, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(), profile, user };
  }
}
