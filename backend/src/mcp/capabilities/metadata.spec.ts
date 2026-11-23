/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- modules are loaded inside jest.isolateModules with their dependencies mocked away. */
describe('capability provider decorator metadata under unresolved circular imports', () => {
  it('records Object for dependencies whose modules are not yet defined', () => {
    jest.isolateModules(() => {
      jest.doMock('../../program/program.service', () => ({}));
      jest.doMock('../../program/program-template.service', () => ({}));
      jest.doMock('../../auth/pompeii.service', () => ({}));
      jest.doMock('../../scenes/scenes.service', () => ({}));
      jest.doMock('../../layouts/layouts.service', () => ({}));
      jest.doMock('../../media-groups/media-groups.service', () => ({}));
      const { ProgramMcpTools } = require('./program');
      const { ScenesMcpTools } = require('./scenes');
      const { LayoutsMcpTools } = require('./layouts');
      const { MediaGroupsMcpTools } = require('./media-groups');
      for (const provider of [
        ProgramMcpTools,
        ScenesMcpTools,
        LayoutsMcpTools,
        MediaGroupsMcpTools,
      ])
        expect(Reflect.getMetadata('design:paramtypes', provider)).toEqual(
          provider === ProgramMcpTools ? [Object, Object, Object] : [Object, Object],
        );
    });
  });

  it('records Object for the dependencies of the broadcast, radio, guest and preference providers', () => {
    jest.isolateModules(() => {
      for (const path of [
        '../../broadcast-destinations/broadcast-destinations.service',
        '../../filler/filler.service',
        '../../recording/alana-recording.client',
        '../../radio/radio.service',
        '../../radio/now-playing-publisher.service',
        '../../radio/palazzo-telemetry.service',
        '../../radio/radio-output-confidence.service',
        '../../radio/song-similarity.service',
        '../../radio/song-execution.engine',
        '../../program/program.service',
        '../../auth/pompeii.service',
        '../../operator-preferences/operator-preferences.service',
        '../../prisma.service',
        '../../external-sources/external-sources.service',
        '../../webrtc/webrtc.service',
      ])
        jest.doMock(path, () => ({}));
      const providers = [
        ['./destinations', 'BroadcastDestinationsMcpTools', 1],
        ['./filler', 'FillerMcpTools', 1],
        ['./recording', 'RecordingMcpTools', 1],
        ['./radio', 'RadioMcpTools', 7],
        ['./preferences', 'OperatorPreferencesMcpTools', 3],
        ['./external-sources', 'ExternalSourcesMcpTools', 3],
        ['./webrtc', 'WebrtcMcpTools', 2],
      ] as const;
      for (const [file, name, count] of providers) {
        const provider = require(file)[name];
        expect(Reflect.getMetadata('design:paramtypes', provider)).toEqual(
          Array(count).fill(Object),
        );
      }
    });
  });
});
