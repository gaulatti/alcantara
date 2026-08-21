import { RealtimeTicketService } from './realtime-ticket.service';

describe('RealtimeTicketService', () => {
  it('issues a one-use ticket bound to one program', () => {
    const service = new RealtimeTicketService();
    const mismatched = service.issue('news');

    expect(service.consume(mismatched.ticket, 'sports')).toBe(false);
    expect(service.consume(mismatched.ticket, 'news')).toBe(false);

    const valid = service.issue('news');
    expect(service.consume(valid.ticket, 'news')).toBe(true);
    expect(service.consume(valid.ticket, 'news')).toBe(false);
  });

  it('expires tickets quickly', () => {
    jest.useFakeTimers();
    try {
      const service = new RealtimeTicketService();
      const issued = service.issue('news');
      jest.advanceTimersByTime(15_001);
      expect(service.consume(issued.ticket, 'news')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});
