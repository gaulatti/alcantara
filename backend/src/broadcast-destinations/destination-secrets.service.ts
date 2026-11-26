import {
  CreateSecretCommand,
  DeleteSecretCommand,
  PutSecretValueCommand,
  RestoreSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import { Injectable } from '@nestjs/common';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { IngestPayload } from './ingest-payload';

export interface DestinationSecretClient {
  send(command: unknown): Promise<{ ARN?: string; VersionId?: string }>;
}

/** The prefix every destination secret is written under (the backend role is scoped to it). */
export const DESTINATION_SECRET_PREFIX = 'alcantara/destinations';

/** How long a retired destination's secret can still be brought back (Secrets Manager's default window). */
export const RETIRED_SECRET_RECOVERY_DAYS = 30;

/**
 * Writes a destination's stream key to Secrets Manager itself (gaulatti/alcantara#376), so the
 * operator never types a secret name or version. The payload is exactly what the ingest route
 * reads. Provider errors are dropped: this class never returns or logs the key or the provider's
 * own text.
 */
@Injectable()
export class DestinationSecretsService {
  /** Created on first use; a test replaces it. */
  client: DestinationSecretClient | undefined;

  private secrets(): DestinationSecretClient {
    return (this.client ??= new SecretsManagerClient({
      region: process.env.AWS_REGION,
    }) as unknown as DestinationSecretClient);
  }

  /** `alcantara/destinations/<team>/<id>`. */
  static nameFor(teamId: number, destinationId: string): string {
    return `${DESTINATION_SECRET_PREFIX}/${teamId}/${destinationId}`;
  }

  async create(
    name: string,
    payload: IngestPayload,
  ): Promise<{ secretId: string; versionId: string }> {
    const response = await this.secrets().send(
      new CreateSecretCommand({
        Name: name,
        SecretString: JSON.stringify(payload),
        Description: 'Alcantara broadcast destination (ingest address and key)',
      }),
    );
    if (!response.ARN || !response.VersionId) {
      throw new Error('secret not created');
    }
    return { secretId: response.ARN, versionId: response.VersionId };
  }

  /** A new version of an existing destination secret; returns its version id. */
  async put(secretId: string, payload: IngestPayload): Promise<string> {
    const response = await this.secrets().send(
      new PutSecretValueCommand({
        SecretId: secretId,
        SecretString: JSON.stringify(payload),
      }),
    );
    if (!response.VersionId) throw new Error('secret not written');
    return response.VersionId;
  }

  /**
   * Removes a secret this process created moments ago and could not record. Never used for a
   * secret an operator may rely on.
   */
  async discard(secretId: string): Promise<void> {
    await this.secrets().send(
      new DeleteSecretCommand({
        SecretId: secretId,
        ForceDeleteWithoutRecovery: true,
      }),
    );
  }

  /** Whether this application wrote the secret: older destinations may name secrets it must not touch. */
  static owns(secretId: string): boolean {
    return (
      secretId.startsWith(`${DESTINATION_SECRET_PREFIX}/`) ||
      secretId.includes(`:secret:${DESTINATION_SECRET_PREFIX}/`)
    );
  }

  /** A retired destination's key is deleted after the recovery window, never immediately. */
  async scheduleDeletion(secretId: string): Promise<void> {
    await this.secrets().send(
      new DeleteSecretCommand({
        SecretId: secretId,
        RecoveryWindowInDays: RETIRED_SECRET_RECOVERY_DAYS,
      }),
    );
  }

  /**
   * Brings back the secret of a restored destination. `gone` means the window had passed and there is no key left;
   * `kept` covers a secret that was never scheduled for deletion.
   */
  async cancelDeletion(secretId: string): Promise<'kept' | 'gone'> {
    try {
      await this.secrets().send(
        new RestoreSecretCommand({ SecretId: secretId }),
      );
      return 'kept';
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'ResourceNotFoundException') return 'gone';
      throw error;
    }
  }
}
