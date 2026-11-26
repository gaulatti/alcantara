import {
  CreateSecretCommand,
  DeleteSecretCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { Injectable } from '@nestjs/common';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { IngestPayload } from './ingest-payload';

export interface DestinationSecretClient {
  send(command: unknown): Promise<{ ARN?: string; VersionId?: string }>;
}

/** The prefix every destination secret is written under (the backend role is scoped to it). */
export const DESTINATION_SECRET_PREFIX = 'alcantara/destinations';

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
}
