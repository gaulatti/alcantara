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

function slideshowProps(scene: SlideshowSceneLike | null | undefined): Record<string, unknown> | null {
  const componentTypes = scene?.layout?.componentType
    ?.split(',')
    .map((componentType) => componentType.trim())
    .filter(Boolean) ?? [];
  if (!componentTypes.includes('slideshow')) return null;

  try {
    const metadata = scene?.metadata ? JSON.parse(scene.metadata) : {};
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const slideshow = (metadata as Record<string, unknown>).slideshow;
    return slideshow && typeof slideshow === 'object' && !Array.isArray(slideshow)
      ? (slideshow as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function getSceneSlideshowLabelId(scene: SlideshowSceneLike | null | undefined): string | null {
  const props = slideshowProps(scene);
  if (!props) return null;
  const labelId = props.labelId;
  if (typeof labelId === 'string' && labelId.trim()) return labelId.trim();
  const legacyMediaGroupId = normalizeMediaGroupId(props.mediaGroupId);
  return legacyMediaGroupId === null ? null : `legacy-media-group:${legacyMediaGroupId}`;
}

export function getSceneSlideshowMediaGroupId(scene: SlideshowSceneLike | null | undefined): number | null {
  const props = slideshowProps(scene);
  return props ? normalizeMediaGroupId(props.mediaGroupId) : null;
}

export function getProgramSlideshowMediaGroupIds(
  activeScene: SlideshowSceneLike | null | undefined,
  stagedScene: SlideshowSceneLike | null | undefined
): number[] {
  const ids = [getSceneSlideshowMediaGroupId(activeScene), getSceneSlideshowMediaGroupId(stagedScene)];
  return [...new Set(ids.filter((id): id is number => id !== null))];
}

export function getProgramSlideshowLabelIds(
  activeScene: SlideshowSceneLike | null | undefined,
  stagedScene: SlideshowSceneLike | null | undefined
): string[] {
  const ids = [getSceneSlideshowLabelId(activeScene), getSceneSlideshowLabelId(stagedScene)];
  return [...new Set(ids.filter((id): id is string => id !== null))];
}
