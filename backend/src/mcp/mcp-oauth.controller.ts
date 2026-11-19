import { Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { McpHttpReply, McpHttpRequest } from './mcp.controller';
import { Public } from '../auth/public.decorator';
import {
  COGNITO_HOSTED_DOMAIN,
  COGNITO_ISSUER,
  MCP_LIMITS,
  MCP_OAUTH_SCOPES,
  MCP_PUBLIC_ORIGIN,
  MCP_REGISTRATION_URL,
  MCP_RESOURCE_URL,
  MCP_SHARED_CLIENT_ID,
} from './mcp.constants';

const PROTECTED_RESOURCE = {
  resource: MCP_RESOURCE_URL,
  authorization_servers: [MCP_PUBLIC_ORIGIN],
  scopes_supported: [...MCP_OAUTH_SCOPES],
  bearer_methods_supported: ['header'],
};

const AUTHORIZATION_SERVER = {
  issuer: COGNITO_ISSUER,
  authorization_endpoint: `${COGNITO_HOSTED_DOMAIN}/oauth2/authorize`,
  token_endpoint: `${COGNITO_HOSTED_DOMAIN}/oauth2/token`,
  registration_endpoint: MCP_REGISTRATION_URL,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  scopes_supported: [...MCP_OAUTH_SCOPES],
};

/** An https URI, or http on a loopback host (native clients). */
function acceptableRedirect(uri: unknown): uri is string {
  if (
    typeof uri !== 'string' ||
    uri.length > MCP_LIMITS.maxRegistrationUriLength
  )
    return false;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.hash || parsed.username || parsed.password) return false;
  if (parsed.protocol === 'https:') return true;
  return (
    parsed.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  );
}

/**
 * OAuth discovery for MCP clients. Cognito authenticates; Pompeii
 * authorizes. /register is a stateless facade over the console's public
 * Cognito app client: it checks the shape of the redirect URIs and reflects
 * them. The only list of allowed callbacks is the app client's own in
 * Cognito, so there is no second list here to drift from it; a callback the
 * app client does not allow is refused by Cognito at authorization time.
 */
@Controller()
@Public()
export class McpOAuthController {
  @Get([
    '.well-known/oauth-protected-resource',
    '.well-known/oauth-protected-resource/mcp',
  ])
  protectedResource() {
    return PROTECTED_RESOURCE;
  }

  @Get('.well-known/oauth-authorization-server')
  authorizationServer() {
    return AUTHORIZATION_SERVER;
  }

  @Post('register')
  async register(@Req() request: McpHttpRequest, @Res() reply: McpHttpReply) {
    const body = request.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      await reply.status(400).send({
        error: 'invalid_client_metadata',
        error_description: 'The body must be a JSON registration object.',
      });
      return;
    }
    const uris = body.redirect_uris;
    if (
      !Array.isArray(uris) ||
      uris.length === 0 ||
      uris.length > MCP_LIMITS.maxRegistrationUris ||
      !uris.every(acceptableRedirect)
    ) {
      await reply.status(400).send({
        error: 'invalid_redirect_uri',
        error_description: `redirect_uris must list 1 to ${MCP_LIMITS.maxRegistrationUris} https URIs (or http on localhost).`,
      });
      return;
    }
    const name = body.client_name;
    if (name !== undefined && (typeof name !== 'string' || name.length > 200)) {
      await reply.status(400).send({
        error: 'invalid_client_metadata',
        error_description: 'client_name must be a short string.',
      });
      return;
    }
    await reply.status(201).send({
      client_id: MCP_SHARED_CLIENT_ID,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(name === undefined ? {} : { client_name: name }),
    });
  }

  @Get('register')
  async notAllowed(@Res() reply: McpHttpReply) {
    await reply.status(405).send({ error: 'method_not_allowed' });
  }
}
