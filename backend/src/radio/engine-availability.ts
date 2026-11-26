import type { PrismaService } from '../prisma.service';

/**
 * gaulatti/alcantara#609: a radio-only program plays only through its playout engine. True when
 * that program's engine is disabled in its radio settings, or it has none, so a song started now
 * would play nowhere. TV and simulcast programs, and unknown programs, are never "off" here.
 */
export async function isRadioOnlyEngineOff(
  prisma: Pick<PrismaService, 'programState'>,
  programId: string,
): Promise<boolean> {
  const state = await prisma.programState.findUnique({
    where: { programId },
    select: { type: true, radioSettings: { select: { enabled: true } } },
  });
  return state?.type === 'radio' && state.radioSettings?.enabled !== true;
}

/**
 * Whether a show's radio can air a timed block (the rundown-building walk): `not-configured` when it has no radio
 * settings or no Palazzo URL, `disabled` when its radio is off in its settings, `ready` otherwise. A show with no
 * radio leg is `not-radio`. Display only: what starts and airs is decided where it always was.
 */
export type RadioEngineReadiness =
  | 'ready'
  | 'not-configured'
  | 'disabled'
  | 'not-radio';

export async function radioEngineReadiness(
  prisma: Pick<PrismaService, 'programState'>,
  programId: string,
): Promise<RadioEngineReadiness> {
  const state = await prisma.programState.findUnique({
    where: { programId },
    select: {
      type: true,
      radioSettings: { select: { enabled: true, palazzoUrl: true } },
    },
  });
  if (!state || (state.type !== 'radio' && state.type !== 'both'))
    return 'not-radio';
  if (!state.radioSettings?.palazzoUrl.trim()) return 'not-configured';
  return state.radioSettings.enabled ? 'ready' : 'disabled';
}

/** A scheduled or running rundown song skipped because its radio-only program's engine is off. */
export class AutomationEngineUnavailableError extends Error {
  readonly reason = 'engine_unavailable';
  constructor() {
    super(
      'The radio engine is off (disabled in settings); the song was not aired.',
    );
  }
}
