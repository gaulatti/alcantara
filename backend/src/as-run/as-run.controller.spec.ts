import { AsRunController, type AsRunExportReply } from './as-run.controller';
import type { AsRunService } from './as-run.service';

describe('AsRunController', () => {
  let controller: AsRunController;
  let service: {
    export: jest.Mock;
  };

  beforeEach(() => {
    service = {
      export: jest.fn().mockResolvedValue('test,csv,output'),
    };
    controller = new AsRunController(service as unknown as AsRunService);
  });

  it('delegates export to service with query parameters and sets Content-Disposition', async () => {
    const headerSpy = jest.fn();
    const mockRes: AsRunExportReply = {
      header: headerSpy,
    };

    const result = await controller.export(
      'prog-1',
      '2026-11-01T00:00:00Z',
      '2026-11-15T00:00:00Z',
      'soundexchange',
      mockRes,
    );

    expect(result).toBe('test,csv,output');
    expect(service.export).toHaveBeenCalledWith('prog-1', {
      from: '2026-11-01T00:00:00Z',
      to: '2026-11-15T00:00:00Z',
      format: 'soundexchange',
    });
    expect(headerSpy).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="as-run-prog-1-soundexchange.csv"',
    );
  });

  it('defaults format to csv when format is omitted', async () => {
    const headerSpy = jest.fn();
    const mockRes: AsRunExportReply = {
      header: headerSpy,
    };

    const result = await controller.export(
      'prog-1',
      undefined,
      undefined,
      undefined,
      mockRes,
    );

    expect(result).toBe('test,csv,output');
    expect(service.export).toHaveBeenCalledWith('prog-1', {
      from: undefined,
      to: undefined,
      format: undefined,
    });
    expect(headerSpy).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="as-run-prog-1-csv.csv"',
    );
  });

  it('handles res without header method', async () => {
    const mockRes: AsRunExportReply = {};
    const result = await controller.export(
      'prog-3',
      undefined,
      undefined,
      'csv',
      mockRes,
    );
    expect(result).toBe('test,csv,output');
  });

  it('does not throw if res is not provided', async () => {
    const result = await controller.export(
      'prog-2',
      undefined,
      undefined,
      'csv',
    );
    expect(result).toBe('test,csv,output');
    expect(service.export).toHaveBeenCalledWith('prog-2', {
      from: undefined,
      to: undefined,
      format: 'csv',
    });
  });
});
