export function sceneInstantBelongsToActiveScene(
  sceneInstantSceneId: number | null,
  activeSceneId: number | null
): boolean {
  return sceneInstantSceneId !== null && sceneInstantSceneId === activeSceneId;
}
