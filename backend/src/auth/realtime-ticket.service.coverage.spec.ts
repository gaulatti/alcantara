import { RealtimeTicketService } from './realtime-ticket.service';

describe('RealtimeTicketService normalization and expiry', () => {
  beforeEach(() =>
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z')),
  );
  afterEach(() => jest.useRealTimers());

  it('treats a blank program id as main on issue and consume', () => {
    const service = new RealtimeTicketService();
    const { ticket, expiresInMs } = service.issue('   ');
    expect(expiresInMs).toBe(15_000);
    expect(service.consume(ticket, 'main')).toBe(true);
    const second = service.issue('main');
    expect(service.consume(second.ticket, '')).toBe(true);
  });

  it('trims program ids when matching and is one-time use', () => {
    const service = new RealtimeTicketService();
    const { ticket } = service.issue(' show ');
    expect(service.consume(ticket, 'show ')).toBe(true);
    expect(service.consume(ticket, 'show')).toBe(false);
  });

  it('rejects unknown tickets and mismatched programs, consuming the ticket', () => {
    const service = new RealtimeTicketService();
    expect(service.consume('unknown', 'main')).toBe(false);
    const { ticket } = service.issue('a');
    expect(service.consume(ticket, 'b')).toBe(false);
    expect(service.consume(ticket, 'a')).toBe(false);
  });

  it('expires tickets at the TTL boundary and sweeps expired ones on issue', () => {
    const service = new RealtimeTicketService();
    const stale = service.issue('a').ticket;
    const boundary = service.issue('a').ticket;
    jest.advanceTimersByTime(14_999);
    const fresh = service.issue('a').ticket;
    expect(service.consume(boundary, 'a')).toBe(true);
    jest.advanceTimersByTime(1);
    expect(service.consume(stale, 'a')).toBe(false);
    expect(service.consume(fresh, 'a')).toBe(true);
  });
});
