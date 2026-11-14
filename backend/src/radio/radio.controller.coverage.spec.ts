import { BadRequestException } from '@nestjs/common';
import { RadioController } from './radio.controller';

function build() {
  const radio = {
    getRadioSettings: jest.fn(),
    updateRadioSettings: jest.fn(),
    getRecoveryStatus: jest.fn(),
    prepareRecoveryPlaylist: jest.fn(),
    setRecoveryAutomation: jest.fn(),
    stopSong: jest.fn(),
    playInstant: jest.fn(),
    stopAllInstants: jest.fn(),
    getPalazzoStatus: jest.fn(),
  };
  const engine = { handleManualSong: jest.fn(), handleStopSong: jest.fn() };
  const nowPlaying = { listConsumers: jest.fn(), replaceConsumers: jest.fn() };
  const telemetry = {
    handleRadioSettingsChanged: jest.fn(),
    getStatus: jest.fn(),
  };
  const confidence = { get: jest.fn() };
  const similarity = {
    getCoverage: jest.fn(),
    listDecisions: jest.fn(),
    exportSongs: jest.fn(),
    storeEmbeddings: jest.fn(),
    onSettingsChanged: jest.fn(),
  };
  const controller = new RadioController(
    radio as any,
    engine as any,
    nowPlaying as any,
    telemetry as any,
    confidence as any,
    similarity as any,
  );
  return {
    controller,
    radio,
    engine,
    nowPlaying,
    telemetry,
    confidence,
    similarity,
  };
}

describe('RadioController coverage', () => {
  it('returns settings from the radio service', async () => {
    const { controller, radio } = build();
    radio.getRadioSettings.mockResolvedValue({ enabled: true });
    await expect(controller.getSettings('p')).resolves.toEqual({
      enabled: true,
    });
    expect(radio.getRadioSettings).toHaveBeenCalledWith('p');
  });

  describe('updateSettings', () => {
    it('notifies telemetry when the palazzo url changes', async () => {
      const { controller, radio, telemetry } = build();
      radio.getRadioSettings.mockResolvedValue({
        palazzoUrl: 'a',
        enabled: true,
      });
      radio.updateRadioSettings.mockResolvedValue({
        palazzoUrl: 'b',
        enabled: true,
      });
      const data = { palazzoUrl: 'b' } as any;
      await expect(controller.updateSettings('p', data)).resolves.toEqual({
        palazzoUrl: 'b',
        enabled: true,
      });
      expect(radio.updateRadioSettings).toHaveBeenCalledWith('p', data);
      expect(telemetry.handleRadioSettingsChanged).toHaveBeenCalledWith('p');
    });

    it('notifies telemetry when enabled changes', async () => {
      const { controller, radio, telemetry } = build();
      radio.getRadioSettings.mockResolvedValue({
        palazzoUrl: 'a',
        enabled: true,
      });
      radio.updateRadioSettings.mockResolvedValue({
        palazzoUrl: 'a',
        enabled: false,
      });
      await controller.updateSettings('p', {} as any);
      expect(telemetry.handleRadioSettingsChanged).toHaveBeenCalledWith('p');
    });

    it('notifies telemetry when there were no previous settings', async () => {
      const { controller, radio, telemetry } = build();
      radio.getRadioSettings.mockResolvedValue(null);
      radio.updateRadioSettings.mockResolvedValue({
        palazzoUrl: 'a',
        enabled: true,
      });
      await controller.updateSettings('p', {} as any);
      expect(telemetry.handleRadioSettingsChanged).toHaveBeenCalledWith('p');
    });

    it('does not notify telemetry when nothing relevant changed', async () => {
      const { controller, radio, telemetry } = build();
      radio.getRadioSettings.mockResolvedValue({
        palazzoUrl: 'a',
        enabled: true,
      });
      radio.updateRadioSettings.mockResolvedValue({
        palazzoUrl: 'a',
        enabled: true,
      });
      await controller.updateSettings('p', {} as any);
      expect(telemetry.handleRadioSettingsChanged).not.toHaveBeenCalled();
    });
  });

  it('returns palazzo status from telemetry', async () => {
    const { controller, telemetry } = build();
    telemetry.getStatus.mockReturnValue({ ok: 1 });
    await expect(controller.getPalazzoStatus('p')).resolves.toEqual({ ok: 1 });
    expect(telemetry.getStatus).toHaveBeenCalledWith('p');
  });

  it('checks settings then returns output confidence', async () => {
    const { controller, radio, confidence } = build();
    confidence.get.mockReturnValue({ state: 'idle' });
    await expect(controller.getOutputConfidence('p')).resolves.toEqual({
      state: 'idle',
    });
    expect(radio.getRadioSettings).toHaveBeenCalledWith('p');
    expect(confidence.get).toHaveBeenCalledWith('p');
  });

  it('returns recovery status', async () => {
    const { controller, radio } = build();
    radio.getRecoveryStatus.mockResolvedValue({ r: 1 });
    await expect(controller.getRecovery('p')).resolves.toEqual({ r: 1 });
    expect(radio.getRecoveryStatus).toHaveBeenCalledWith('p');
  });

  it('prepares the recovery playlist from the posted song ids', async () => {
    const { controller, radio } = build();
    radio.prepareRecoveryPlaylist.mockResolvedValue({ prepared: true });
    await expect(
      controller.prepareRecovery('p', { songIds: [1, 2] }),
    ).resolves.toEqual({ prepared: true });
    expect(radio.prepareRecoveryPlaylist).toHaveBeenCalledWith('p', [1, 2]);
  });

  it('starts and stops recovery automation', async () => {
    const { controller, radio } = build();
    radio.setRecoveryAutomation.mockResolvedValue('r');
    await expect(controller.startRecovery('p')).resolves.toBe('r');
    await expect(controller.stopRecovery('p')).resolves.toBe('r');
    expect(radio.setRecoveryAutomation.mock.calls).toEqual([
      ['p', 'start'],
      ['p', 'stop'],
    ]);
  });

  it('lists now playing consumers', async () => {
    const { controller, nowPlaying } = build();
    nowPlaying.listConsumers.mockResolvedValue(['c']);
    await expect(controller.listNowPlayingConsumers('p')).resolves.toEqual([
      'c',
    ]);
    expect(nowPlaying.listConsumers).toHaveBeenCalledWith('p');
  });

  describe('replaceNowPlayingConsumers', () => {
    it('rejects a non-array body', async () => {
      const { controller, nowPlaying } = build();
      await expect(
        controller.replaceNowPlayingConsumers('p', {}),
      ).rejects.toThrow(new BadRequestException('consumers must be an array'));
      expect(nowPlaying.replaceConsumers).not.toHaveBeenCalled();
    });

    it('returns the replaced consumers', async () => {
      const { controller, nowPlaying } = build();
      const consumers = [{ url: 'https://x.test' }];
      nowPlaying.replaceConsumers.mockResolvedValue(['saved']);
      await expect(
        controller.replaceNowPlayingConsumers('p', { consumers }),
      ).resolves.toEqual(['saved']);
      expect(nowPlaying.replaceConsumers).toHaveBeenCalledWith('p', consumers);
    });

    it('maps service errors to bad request', async () => {
      const { controller, nowPlaying } = build();
      nowPlaying.replaceConsumers.mockRejectedValue(
        new Error('Program not found'),
      );
      await expect(
        controller.replaceNowPlayingConsumers('p', { consumers: [] }),
      ).rejects.toThrow(new BadRequestException('Error: Program not found'));
    });
  });

  describe('playSong', () => {
    it('requires an audio url', async () => {
      const { controller, engine } = build();
      await expect(controller.playSong('p', { audioUrl: '' })).rejects.toThrow(
        new BadRequestException('audioUrl is required'),
      );
      expect(engine.handleManualSong).not.toHaveBeenCalled();
    });

    it('starts the manual song with every field', async () => {
      const { controller, engine } = build();
      await expect(
        controller.playSong('p', {
          audioUrl: 'u',
          title: 't',
          artist: 'a',
          coverUrl: 'c',
          durationMs: 5,
          songId: 9,
        }),
      ).resolves.toEqual({ ok: true });
      expect(engine.handleManualSong).toHaveBeenCalledWith(
        'p',
        'u',
        't',
        'a',
        5,
        'c',
        9,
      );
    });
  });

  it('stops the song on the radio and the engine', async () => {
    const { controller, radio, engine } = build();
    await expect(controller.stopSong('p')).resolves.toEqual({ ok: true });
    expect(radio.stopSong).toHaveBeenCalledWith('p');
    expect(engine.handleStopSong).toHaveBeenCalledWith('p');
  });

  describe('playInstant', () => {
    it('requires an audio url', async () => {
      const { controller, radio } = build();
      await expect(
        controller.playInstant('p', { audioUrl: '', instantId: 1 }),
      ).rejects.toThrow(new BadRequestException('audioUrl is required'));
      expect(radio.playInstant).not.toHaveBeenCalled();
    });

    it('plays the instant with volume', async () => {
      const { controller, radio } = build();
      await expect(
        controller.playInstant('p', {
          audioUrl: 'u',
          instantId: 1,
          volume: 0.5,
        }),
      ).resolves.toEqual({ ok: true });
      expect(radio.playInstant).toHaveBeenCalledWith('p', 'u', 0.5);
    });
  });

  it('stops all instants', async () => {
    const { controller, radio } = build();
    await expect(controller.stopAllInstants('p')).resolves.toEqual({
      ok: true,
    });
    expect(radio.stopAllInstants).toHaveBeenCalledWith('p');
  });

  it('returns the palazzo status through the radio service', async () => {
    const { controller, radio } = build();
    radio.getPalazzoStatus.mockResolvedValue({ s: 1 });
    await expect(controller.getStatus('p')).resolves.toEqual({ s: 1 });
    expect(radio.getPalazzoStatus).toHaveBeenCalledWith('p');
  });
});

describe('RadioController similarity endpoints', () => {
  it('returns similarity coverage for the program', async () => {
    const { controller, similarity } = build();
    similarity.getCoverage.mockResolvedValue({ total: 3, embedded: 2 });
    await expect(controller.similarityCoverage('p')).resolves.toEqual({
      total: 3,
      embedded: 2,
    });
    expect(similarity.getCoverage).toHaveBeenCalledWith('p');
  });

  it('lists decisions with the default and an explicit limit', async () => {
    const { controller, similarity } = build();
    similarity.listDecisions.mockResolvedValue([{ id: 1 }]);
    await expect(controller.similarityDecisions('p')).resolves.toEqual([
      { id: 1 },
    ]);
    expect(similarity.listDecisions).toHaveBeenLastCalledWith('p', 50);
    await controller.similarityDecisions('p', '7');
    expect(similarity.listDecisions).toHaveBeenLastCalledWith('p', 7);
  });

  it.each([
    ['sequence', undefined, false],
    ['catalog', 'true', true],
    ['catalog', 'false', false],
  ])(
    'exports the %s pool with missingOnly=%s',
    async (scope, missingOnly, expected) => {
      const { controller, similarity } = build();
      similarity.exportSongs.mockResolvedValue({ songs: [] });
      await expect(
        controller.similarityExport('p', scope, missingOnly),
      ).resolves.toEqual({ songs: [] });
      expect(similarity.exportSongs).toHaveBeenCalledWith('p', scope, expected);
    },
  );

  it.each([undefined, '', 'all'])(
    'rejects an export scope of %p',
    async (scope) => {
      const { controller, similarity } = build();
      await expect(controller.similarityExport('p', scope)).rejects.toThrow(
        new BadRequestException('scope must be sequence or catalog'),
      );
      expect(similarity.exportSongs).not.toHaveBeenCalled();
    },
  );

  it('stores uploaded embeddings', async () => {
    const { controller, similarity } = build();
    const body = { items: [] };
    similarity.storeEmbeddings.mockResolvedValue({ stored: 0 });
    await expect(controller.similarityUpload(body)).resolves.toEqual({
      stored: 0,
    });
    expect(similarity.storeEmbeddings).toHaveBeenCalledWith(body);
  });

  it.each([
    { similarityMode: 'on' },
    { similarityThreshold: 0.2 },
    { similarityWindowSeconds: 20 },
    { similarityPool: 'catalog' },
  ])('reloads similarity settings after saving %p', async (data) => {
    const { controller, radio, similarity } = build();
    radio.getRadioSettings.mockResolvedValue({
      palazzoUrl: 'a',
      enabled: true,
    });
    radio.updateRadioSettings.mockResolvedValue({
      palazzoUrl: 'a',
      enabled: true,
    });
    await controller.updateSettings('p', data as any);
    expect(similarity.onSettingsChanged).toHaveBeenCalledTimes(1);
  });

  it('does not reload similarity settings for unrelated changes', async () => {
    const { controller, radio, similarity } = build();
    radio.getRadioSettings.mockResolvedValue({
      palazzoUrl: 'a',
      enabled: true,
    });
    radio.updateRadioSettings.mockResolvedValue({
      palazzoUrl: 'a',
      enabled: true,
    });
    await controller.updateSettings('p', { bumperEnabled: true } as any);
    expect(similarity.onSettingsChanged).not.toHaveBeenCalled();
  });
});
