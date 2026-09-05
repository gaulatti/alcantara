export interface SlideshowSceneLike {
  layout?: { componentType?: string | null } | null;
  metadata?: string | null;
}

function normalizeMediaGroupId(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || !Number.isInteger(numeric)) {
    return null;
  }
  return numeric;
}

export function getSceneSlideshowMediaGroupId(scene: SlideshowSceneLike | null | undefined): number | null {
  const componentTypes = scene?.layout?.componentType
    ?.split(',')
    .map((componentType) => componentType.trim())
    .filter(Boolean) ?? [];
  if (!componentTypes.includes('slideshow')) {
    return null;
  }

  try {
    const metadata = scene?.metadata ? JSON.parse(scene.metadata) : {};
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }
    const slideshow = (metadata as Record<string, unknown>).slideshow;
    if (!slideshow || typeof slideshow !== 'object' || Array.isArray(slideshow)) {
      return null;
    }
    return normalizeMediaGroupId((slideshow as Record<string, unknown>).mediaGroupId);
  } catch {
    return null;
  }
}

export function getProgramSlideshowMediaGroupIds(
  activeScene: SlideshowSceneLike | null | undefined,
  stagedScene: SlideshowSceneLike | null | undefined
): number[] {
  const ids = [getSceneSlideshowMediaGroupId(activeScene), getSceneSlideshowMediaGroupId(stagedScene)];
  return [...new Set(ids.filter((id): id is number => id !== null))];
}
