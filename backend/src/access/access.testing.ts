import {
  Server,
  ServerCredentials,
  loadPackageDefinition,
  status,
  type Metadata,
  type ServerUnaryCall,
  type sendUnaryData,
  type UntypedServiceImplementation,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { join } from 'node:path';
import { ACCESS_METHODS } from '../auth/pompeii.service';

/**
 * A fake Pompeii for gaulatti/alcantara#224: one real gRPC server that serves
 * AuthorizationService and ApplicationAccessService, records every access call
 * with the service credential it carried, and answers from a table the test
 * sets. The credentials used by the specs are placeholders built from repeated
 * characters.
 */

const options = {
  defaults: true,
  enums: String,
  keepCase: true,
  longs: Number,
  oneofs: true,
};
type Loaded = {
  pompeii: {
    authorization: { v1: { AuthorizationService: { service: never } } };
    access: { v1: { ApplicationAccessService: { service: never } } };
  };
};
const authorization = loadPackageDefinition(
  loadSync(join(__dirname, '..', 'proto', 'authorization.proto'), options),
) as unknown as Loaded;
const accessDefinition = loadPackageDefinition(
  loadSync(join(__dirname, '..', 'proto', 'application_access.proto'), options),
) as unknown as Loaded;

export const SERVICE_CREDENTIAL = `pmp_svc_${'c'.repeat(43)}`;
export const TOKEN_VALUE = `pmp_pat_${'v'.repeat(43)}`;
export const BEARER = `Bearer ${'s'.repeat(36)}.${'p'.repeat(120)}.${'g'.repeat(86)}`;

export interface RecordedCall {
  method: string;
  request: Record<string, unknown>;
  credential: string | undefined;
}

export type Answer =
  | { reply: Record<string, unknown> }
  | { fail: status }
  | { delayMs: number };

export interface FakePompeii {
  port: number;
  calls: RecordedCall[];
  /** What Authorize answers (effective permissions of the session). */
  permissions: string[];
  /** Per RPC: a reply, a gRPC failure or a delay before the default reply. */
  answers: Map<string, Answer>;
  close(): Promise<void>;
}

export async function startFakePompeii(): Promise<FakePompeii> {
  const server = new Server();
  const fake: FakePompeii = {
    port: 0,
    calls: [],
    permissions: ['alcantara:access'],
    answers: new Map(),
    close: () =>
      new Promise<void>((resolve) => {
        server.tryShutdown(() => resolve());
      }),
  };
  server.addService(
    authorization.pompeii.authorization.v1.AuthorizationService.service,
    {
      Authorize: (
        _call: unknown,
        reply: sendUnaryData<Record<string, unknown>>,
      ) =>
        reply(null, {
          authenticated: true,
          allowed: true,
          reason: 'ALLOW',
          subject: 'subject-1',
          principal_id: 'principal-1',
          effective_permissions: fake.permissions,
          roles: ['operator'],
        }),
    } satisfies UntypedServiceImplementation,
  );
  const handlers: UntypedServiceImplementation = {};
  for (const method of ACCESS_METHODS) {
    handlers[method] = (
      call: ServerUnaryCall<Record<string, unknown>, unknown>,
      reply: sendUnaryData<Record<string, unknown>>,
    ) => {
      const metadata: Metadata = call.metadata;
      fake.calls.push({
        method,
        request: call.request,
        credential: metadata.get('x-pompeii-service-credential')[0] as
          | string
          | undefined,
      });
      const answer = fake.answers.get(method);
      if (answer && 'fail' in answer)
        reply({ code: answer.fail, details: 'a message Pompeii wrote' }, null);
      else if (answer && 'reply' in answer) reply(null, answer.reply);
      else
        setTimeout(
          () => reply(null, {}),
          answer && 'delayMs' in answer ? answer.delayMs : 0,
        );
    };
  }
  server.addService(
    accessDefinition.pompeii.access.v1.ApplicationAccessService.service,
    handlers,
  );
  fake.port = await new Promise<number>((resolve) =>
    server.bindAsync(
      '127.0.0.1:0',
      ServerCredentials.createInsecure(),
      (_error, port) => resolve(port),
    ),
  );
  return fake;
}
