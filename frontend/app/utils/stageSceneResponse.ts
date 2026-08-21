export type StageSceneResponse = {
  stagedSceneId?: unknown;
  stagedScene?: unknown;
  version?: unknown;
};

export type AcceptedStageSceneResponse<TScene extends object> = {
  stagedSceneId: number | null;
  stagedScene: TScene | null;
};

type AcceptControlUpdate = (payload: unknown, topicOverride: 'state') => boolean;

export function acceptStageSceneResponse<TScene extends object>(
  result: StageSceneResponse,
  acceptControlUpdate: AcceptControlUpdate,
): AcceptedStageSceneResponse<TScene> | null {
  if (!acceptControlUpdate(result, 'state')) {
    return null;
  }

  return {
    stagedSceneId:
      typeof result.stagedSceneId === 'number' && Number.isFinite(result.stagedSceneId)
        ? result.stagedSceneId
        : null,
    stagedScene:
      result.stagedScene && typeof result.stagedScene === 'object'
        ? (result.stagedScene as TScene)
        : null,
  };
}
