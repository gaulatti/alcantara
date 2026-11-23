import {
  PROGRAM_TEMPLATE_V2_SIGNALS,
  projectProgramTemplateSignal,
  type ProgramTemplateManifest,
} from './program-template.service';

// A contract v2 registration that declares every v2 signal.
const v2Manifest = {
  contractVersion: 2,
  control: { signals: [...PROGRAM_TEMPLATE_V2_SIGNALS] },
} as unknown as ProgramTemplateManifest;

const BRACKET = 'harbor-light-bracket';

/**
 * The generic draw-start event with the scenes service's payload for a draw of
 * four songs: `{type, sceneId, componentType, drawId, durationSeconds, songIds}`,
 * as scenes.service.coverage.spec.ts pins it, plus the stream's own programId
 * and version.
 */
function scenesServiceDrawStart(): Record<string, unknown> {
  return {
    type: 'audience_interaction_draw_start',
    sceneId: 101,
    componentType: BRACKET,
    drawId: 1794881297394,
    durationSeconds: 5,
    songIds: [13, 12, 14, 11],
    programId: 'harbor-light-tv',
    version: 3,
  };
}

describe('program template projection of a draw start', () => {
  it("carries the scenes service's four candidates, in the order drawn, as candidateIds", () => {
    const start = scenesServiceDrawStart();

    const projected = projectProgramTemplateSignal(start, v2Manifest);

    expect(projected).toEqual({
      type: 'audience_interaction_draw_start',
      programId: 'harbor-light-tv',
      schemaVersion: 2,
      version: 3,
      sceneId: 101,
      componentType: BRACKET,
      drawId: 1794881297394,
      durationSeconds: 5,
      candidateIds: [13, 12, 14, 11],
    });
  });

  it('carries an empty candidate list, not a missing field, for a draw without candidates', () => {
    const base = {
      type: 'audience_interaction_draw_start',
      programId: 'harbor-light-tv',
      version: 1,
      sceneId: 101,
      componentType: BRACKET,
      drawId: 1,
      durationSeconds: 5,
    };

    expect(projectProgramTemplateSignal(base, v2Manifest)).toHaveProperty(
      'candidateIds',
      [],
    );
    expect(
      projectProgramTemplateSignal({ ...base, songIds: [] }, v2Manifest),
    ).toHaveProperty('candidateIds', []);
    expect(
      projectProgramTemplateSignal(
        { ...base, songIds: 'not-a-list' },
        v2Manifest,
      ),
    ).toHaveProperty('candidateIds', []);
  });
});
