import { EventEmitter } from 'node:events';
import type * as http from 'node:http';
import type * as https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import type { ResolveAll, SafeFetchDeps } from './safe-fetch';

export interface ScriptedResponse {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer | Buffer[];
  /** Never answer (to exercise the deadline). */
  hang?: boolean;
  /** The socket reports an idle timeout instead of answering. */
  socketTimeout?: boolean;
}

export interface SentRequest {
  scheme: 'https:' | 'http:';
  hostname: string;
  path: string;
  method: string;
  headers: Record<string, unknown>;
  servername?: string;
  /** The request body as written. */
  body: string;
  /** The address the pinned lookup handed the socket. */
  connectedTo: string;
}

/**
 * A transport for the outbound policy that answers from a script instead of
 * the network. Each request calls the policy's own lookup first, so a test
 * sees the address the socket would have connected to.
 */
export function scriptedTransport(
  names: Record<string, string[]>,
  script: Record<string, ScriptedResponse>,
): Required<Omit<SafeFetchDeps, 'record'>> & { sent: SentRequest[] } {
  const sent: SentRequest[] = [];
  const resolve: ResolveAll = (hostname) => {
    const addresses = names[hostname];
    if (!addresses) return Promise.reject(new Error('ENOTFOUND'));
    return Promise.resolve(
      addresses.map((address) => ({
        address,
        family: address.includes(':') ? 6 : 4,
      })),
    );
  };
  const request = (
    scheme: 'https:' | 'http:',
    options: https.RequestOptions,
  ): http.ClientRequest => {
    let body = '';
    const req = new EventEmitter() as EventEmitter & {
      write: (chunk: string) => boolean;
      end: () => void;
      destroy: () => void;
    };
    req.write = (chunk) => {
      body += chunk;
      return true;
    };
    req.destroy = () => undefined;
    req.end = () => {
      const hostname = String(options.hostname);
      const finish = (connectedTo: string) => {
        sent.push({
          scheme,
          hostname,
          path: String(options.path),
          method: String(options.method),
          headers: { ...(options.headers as Record<string, unknown>) },
          servername: options.servername,
          body,
          connectedTo,
        });
        const scripted = script[`${hostname}${String(options.path)}`];
        if (!scripted) return req.emit('error', new Error('ECONNREFUSED'));
        if (scripted.socketTimeout) return req.emit('timeout');
        if (scripted.hang) return;
        const response = Readable.from(
          [scripted.body ?? []].flat(),
        ) as Readable & {
          statusCode: number;
          headers: Record<string, string>;
        };
        response.statusCode = scripted.status;
        response.headers = Object.fromEntries(
          Object.entries(scripted.headers ?? {}).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ]),
        );
        req.emit('response', response);
      };
      // An IP literal connects directly; a name goes through the policy's
      // pinned lookup, which never fails.
      if (isIP(hostname)) finish(hostname);
      else
        (options.lookup as LookupFunction)(hostname, {}, (_error, address) =>
          finish(address as string),
        );
    };
    return req as unknown as http.ClientRequest;
  };
  return { resolve, request, sent };
}
