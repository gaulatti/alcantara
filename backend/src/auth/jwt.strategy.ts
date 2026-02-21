import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService) {
    const userPoolId = configService.get<string>('COGNITO_USER_POOL_ID');
    const cognitoRegion = configService.get<string>('COGNITO_REGION');
    const clientId = configService.get<string>('COGNITO_CLIENT_ID');

    if (!userPoolId || !cognitoRegion || !clientId) {
      throw new Error(
        'Missing Cognito configuration. Ensure COGNITO_USER_POOL_ID, COGNITO_REGION, and COGNITO_CLIENT_ID are set.',
      );
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      audience: clientId,
      issuer: `https://cognito-idp.${cognitoRegion}.amazonaws.com/${userPoolId}`,
      algorithms: ['RS256'],
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: `https://cognito-idp.${cognitoRegion}.amazonaws.com/${userPoolId}/.well-known/jwks.json`,
      }) as any,
    });
  }

  async validate(payload: any) {
    if (!payload?.sub) {
      throw new UnauthorizedException('Invalid token claims');
    }

    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      username: payload['cognito:username'],
    };
  }
}
