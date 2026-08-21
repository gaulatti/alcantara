import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

@Injectable()
export class RealtimeTicketService {
  private static readonly TTL_MS = 15_000;
  private readonly tickets = new Map<
    string,
    { expiresAt: number; programId: string }
  >();

  issue(programId: string): { ticket: string; expiresInMs: number } {
    this.removeExpired();
    const ticket = randomUUID();
    this.tickets.set(ticket, {
      expiresAt: Date.now() + RealtimeTicketService.TTL_MS,
      programId: this.normalizeProgramId(programId),
    });
    return { ticket, expiresInMs: RealtimeTicketService.TTL_MS };
  }

  consume(ticket: string, programId: string): boolean {
    this.removeExpired();
    const value = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return (
      value !== undefined &&
      value.expiresAt > Date.now() &&
      value.programId === this.normalizeProgramId(programId)
    );
  }

  private removeExpired(): void {
    const now = Date.now();
    for (const [ticket, value] of this.tickets) {
      if (value.expiresAt <= now) this.tickets.delete(ticket);
    }
  }

  private normalizeProgramId(programId: string): string {
    return programId.trim() || 'main';
  }
}
