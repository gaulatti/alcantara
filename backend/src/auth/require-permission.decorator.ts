import { SetMetadata } from '@nestjs/common';
import type { AlcantaraPermission } from './permissions';

export const REQUIRED_PERMISSION_KEY = 'requiredPermission';

export const RequirePermission = (permission: AlcantaraPermission) =>
  SetMetadata(REQUIRED_PERMISSION_KEY, permission);
