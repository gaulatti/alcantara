import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/**
 * Short-lived, program-scoped tickets that let a plain browser download carry
 * authorization. A ticket stays valid for its TTL so an interrupted download
 * can resume with Range requests.
 */
@Injectable()
export class RecordingDownloadTicketService {
  static readonly TTL_MS = 5 * 60_000;
  private static readonly MAX_TICKETS = 100;
  private readonly tickets = new Map<
    string,
    { expiresAt: number; programId: string }
  >();

  issue(programId: string): { ticket: string; expiresInMs: number } {
    this.removeExpired();
    if (this.tickets.size >= RecordingDownloadTicketService.MAX_TICKETS) {
      for (const oldest of this.tickets.keys()) {
        this.tickets.delete(oldest);
        break;
      }
    }
    const ticket = randomUUID();
    this.tickets.set(ticket, {
      expiresAt: Date.now() + RecordingDownloadTicketService.TTL_MS,
      programId,
    });
    return {
      ticket,
      expiresInMs: RecordingDownloadTicketService.TTL_MS,
    };
  }

  validate(ticket: string | undefined, programId: string): boolean {
    this.removeExpired();
    const value = ticket ? this.tickets.get(ticket) : undefined;
    return value !== undefined && value.programId === programId;
  }

  private removeExpired(): void {
    const now = Date.now();
    for (const [ticket, value] of this.tickets) {
      if (value.expiresAt <= now) this.tickets.delete(ticket);
    }
  }
}
