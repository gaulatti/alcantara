import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from 'node:http';

/** The parts of Fastify's request the MCP controllers use. */
export interface McpHttpRequest {
  headers: IncomingHttpHeaders;
  raw: IncomingMessage;
  body?: unknown;
}

/** The parts of Fastify's reply the MCP controllers use (chainable). */
export interface McpHttpReply {
  raw: ServerResponse;
  sent: boolean;
  status(code: number): McpHttpReply;
  header(name: string, value: string): McpHttpReply;
  headers(values: Record<string, string>): McpHttpReply;
  send(payload?: unknown): unknown;
  hijack(): void;
}
