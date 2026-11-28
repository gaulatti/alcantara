import { RadioController } from './radio.controller';

it('does not reconnect Palazzo when only listener configuration changes', async () => {
  const service = {
    getRadioSettings: jest
      .fn()
      .mockResolvedValue({ palazzoUrl: 'http://palazzo:3100', enabled: true }),
    updateRadioSettings: jest.fn().mockResolvedValue({
      palazzoUrl: 'http://palazzo:3100',
      enabled: true,
      listenerUrl: 'https://radio.example/stream',
    }),
  };
  const telemetry = { handleRadioSettingsChanged: jest.fn() };
  const controller = new RadioController(
    service as never,
    {} as never,
    {} as never,
    telemetry as never,
    {} as never,
    undefined as never,
  );
  await controller.updateSettings('radio', {
    listenerUrl: 'https://radio.example/stream',
  });
  expect(telemetry.handleRadioSettingsChanged).not.toHaveBeenCalled();
  service.updateRadioSettings.mockResolvedValueOnce({
    palazzoUrl: 'http://other-palazzo:3100',
    enabled: true,
  });
  await controller.updateSettings('radio', {
    palazzoUrl: 'http://other-palazzo:3100',
  });
  expect(telemetry.handleRadioSettingsChanged).toHaveBeenCalledWith('radio');
});
