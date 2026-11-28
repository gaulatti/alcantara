// `ws` ships no types and @types/ws is not a dependency. This declares only what the program realtime socket and its
// specs use (types only: nothing here is emitted).
declare module 'ws' {
  import { EventEmitter } from 'node:events';
  import type { IncomingMessage } from 'node:http';
  import type { Duplex } from 'node:stream';

  export type RawData = Buffer | ArrayBuffer | Buffer[];

  export class WebSocket extends EventEmitter {
    static readonly OPEN: number;
    static readonly CLOSED: number;
    constructor(address: string);
    readonly readyState: number;
    send(data: string | Buffer, options?: { binary?: boolean }): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    // `binaryType` is never changed from its default, `nodebuffer`, so a message arrives as a Buffer.
    on(event: 'message', listener: (data: Buffer) => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;
    once(
      event: 'unexpected-response',
      listener: (request: unknown, response: IncomingMessage) => void,
    ): this;
    once(event: string | symbol, listener: (...args: unknown[]) => void): this;
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options: { noServer: boolean });
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (client: WebSocket) => void,
    ): void;
    close(): void;
  }
}
