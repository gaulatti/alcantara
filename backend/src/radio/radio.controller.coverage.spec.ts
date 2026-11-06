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
  const controller = new RadioController(
    radio as any,
    engine as any,
    nowPlaying as any,
    telemetry as any,
    confidence as any,
  );
  return { controller, radio, engine, nowPlaying, telemetry, confidence };
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
