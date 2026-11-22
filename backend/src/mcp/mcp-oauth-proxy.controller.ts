import { Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import type { McpHttpReply, McpHttpRequest } from './mcp.controller';
import {
  McpOAuthProxyService,
  type Params,
  type ProxyAnswer,
} from './mcp-oauth-proxy.service';

/** A posted form as Nest's Fastify adapter parses it: string fields only. */
function formOf(body: unknown): Params {
  const out: Params = {};
  if (!body || typeof body !== 'object') return out;
  for (const [key, value] of Object.entries(body as Record<string, unknown>))
    if (typeof value === 'string') out[key] = value;
  return out;
}

function queryOf(query: Record<string, unknown>): Params {
  const out: Params = {};
  for (const [key, value] of Object.entries(query ?? {}))
    if (typeof value === 'string') out[key] = value;
  return out;
}

async function write(reply: McpHttpReply, answer: ProxyAnswer): Promise<void> {
  reply.status(answer.status);
  if (answer.headers) reply.headers(answer.headers);
  if (answer.location !== undefined) {
    reply.header('location', answer.location);
    await reply.send();
  } else if (answer.html !== undefined) {
    reply.header('content-type', 'text/html; charset=utf-8');
    await reply.send(answer.html);
  } else {
    await reply.send(answer.json);
  }
}

/** The MCP sign-in routes (gaulatti/bastille#34): see McpOAuthProxyService. */
@Controller('oauth')
@Public()
export class McpOAuthProxyController {
  constructor(private readonly proxy: McpOAuthProxyService) {}

  @Get('authorize')
  async authorize(
    @Query() query: Record<string, unknown>,
    @Res() reply: McpHttpReply,
  ) {
    await write(reply, this.proxy.authorize(queryOf(query)));
  }

  @Post('authorize')
  async consent(@Req() request: McpHttpRequest, @Res() reply: McpHttpReply) {
    const cookie = request.headers.cookie;
    await write(
      reply,
      this.proxy.consent(
        formOf(request.body),
        Array.isArray(cookie) ? cookie.join(';') : cookie,
      ),
    );
  }

  @Get('callback')
  async callback(
    @Query() query: Record<string, unknown>,
    @Res() reply: McpHttpReply,
  ) {
    await write(reply, await this.proxy.callback(queryOf(query)));
  }

  @Post('token')
  async token(@Req() request: McpHttpRequest, @Res() reply: McpHttpReply) {
    await write(reply, await this.proxy.token(formOf(request.body)));
  }
}
