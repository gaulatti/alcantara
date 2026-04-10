import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRE_FEATURE_KEY, RequireFeatureOptions } from './require-feature.decorator';

@Injectable()
export class FeaturesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredFeature = this.reflector.getAllAndOverride<RequireFeatureOptions>(
      REQUIRE_FEATURE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredFeature) {
      return true; // No requirement
    }

    const { user } = context.switchToHttp().getRequest();

    if (!user || !user.context || !user.context.features) {
      return false; // No context
    }

    const feature = user.context.features[requiredFeature.featureSlug];
    if (!feature) {
      return false; // Feature not in context
    }

    const levelValues = { C: 0, T1: 1, T2: 2, T3: 3 };
    const requiredLevelValue = levelValues[requiredFeature.minLevel];
    const userLevelValue = levelValues[feature.level as keyof typeof levelValues] ?? -1;

    return userLevelValue >= requiredLevelValue;
  }
}
