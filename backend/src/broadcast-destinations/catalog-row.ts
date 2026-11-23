import { BadRequestException } from '@nestjs/common';
import type { BroadcastDestination } from '@prisma/client';

const MAX_NAME = 100;

/** A destination's name: 1 to 100 characters, trimmed. */
export function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > MAX_NAME) {
    throw new BadRequestException('Name must contain 1-100 characters');
  }
  return name;
}

/**
 * A destination as the catalog (broadcast.manage) shows it. The key is never here: only the
 * Secrets Manager reference, the service, the non-secret ingest address and the last four
 * characters of the key.
 */
export function catalogRow(destination: BroadcastDestination) {
  return {
    id: destination.id,
    displayName: destination.displayName,
    secretId: destination.secretId,
    secretVersionId: destination.secretVersionId,
    service: destination.service,
    ingestUrl: destination.ingestUrl,
    keyLast4: destination.keyLast4,
    keySetAt: destination.keySetAt,
    position: destination.position,
    retiredAt: destination.retiredAt,
    createdAt: destination.createdAt,
    updatedAt: destination.updatedAt,
  };
}
