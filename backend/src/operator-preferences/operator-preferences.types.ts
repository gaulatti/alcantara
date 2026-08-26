import { BadRequestException } from '@nestjs/common';

export const DEVICE_CLASSES = ['desktop', 'tablet', 'phone'] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];
export type ConsoleWorkspace = 'director' | 'audio' | 'graphics' | 'compact';

export interface ConsoleProfile {
  workspace: ConsoleWorkspace;
  dockWidth?: number;
  touchMode: boolean;
  shortcutsEnabled: boolean;
  selectedProgramId: string;
  transitions: Record<string, string>;
}

export function parseDeviceClass(value: string): DeviceClass {
  if (!DEVICE_CLASSES.includes(value as DeviceClass)) {
    throw new BadRequestException(
      'deviceClass must be desktop, tablet, or phone',
    );
  }
  return value as DeviceClass;
}

export function defaultProfile(deviceClass: DeviceClass): ConsoleProfile {
  return {
    workspace: deviceClass === 'desktop' ? 'director' : 'compact',
    ...(deviceClass === 'phone'
      ? {}
      : { dockWidth: deviceClass === 'desktop' ? 320 : 300 }),
    touchMode: deviceClass !== 'desktop',
    shortcutsEnabled: deviceClass === 'desktop',
    selectedProgramId: 'main',
    transitions: { main: 'crescendo-prism' },
  };
}

export function parseProfile(
  value: unknown,
  deviceClass: DeviceClass,
): ConsoleProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('profile must be an object');
  }
  const record = value as Record<string, unknown>;
  const workspaces: ConsoleWorkspace[] = [
    'director',
    'audio',
    'graphics',
    'compact',
  ];
  const workspace = workspaces.includes(record.workspace as ConsoleWorkspace)
    ? (record.workspace as ConsoleWorkspace)
    : defaultProfile(deviceClass).workspace;
  const selectedProgramId = boundedIdentifier(
    record.selectedProgramId,
    'selectedProgramId',
  );
  const transitions: Record<string, string> = {};
  if (
    record.transitions &&
    typeof record.transitions === 'object' &&
    !Array.isArray(record.transitions)
  ) {
    const entries = Object.entries(record.transitions).slice(0, 100);
    for (const [programId, transitionId] of entries) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(programId)) continue;
      if (
        typeof transitionId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(transitionId)
      )
        continue;
      transitions[programId] = transitionId;
    }
  }
  const result: ConsoleProfile = {
    workspace: deviceClass === 'phone' ? 'compact' : workspace,
    touchMode: deviceClass === 'phone' ? true : record.touchMode === true,
    shortcutsEnabled:
      deviceClass === 'phone' ? false : record.shortcutsEnabled !== false,
    selectedProgramId,
    transitions,
  };
  if (deviceClass !== 'phone') {
    const width = Number(record.dockWidth);
    result.dockWidth =
      Number.isFinite(width) && width >= 260 && width <= 520
        ? Math.round(width)
        : defaultProfile(deviceClass).dockWidth;
  }
  return result;
}

function boundedIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  ) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return value;
}
