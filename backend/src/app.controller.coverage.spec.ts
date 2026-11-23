import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController coverage', () => {
  it('delegates to the service', () => {
    const service = { getHello: jest.fn().mockReturnValue('hi') };
    const controller = new AppController(service as unknown as AppService);
    expect(controller.getHello()).toBe('hi');
    expect(service.getHello).toHaveBeenCalledTimes(1);
  });
});
