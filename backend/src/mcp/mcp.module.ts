import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { MCP_ACTION_EXECUTOR } from './contract';
import { AsRunModule } from '../as-run/as-run.module';
import { SongsModule } from '../songs/songs.module';
import { McpActionExecutor } from './mcp-action.executor';
import { McpAuthService } from './mcp-auth.service';
import { McpController } from './mcp.controller';
import { McpOAuthController } from './mcp-oauth.controller';
import { McpOAuthProxyController } from './mcp-oauth-proxy.controller';
import { McpOAuthProxyService } from './mcp-oauth-proxy.service';
import { McpRegistry } from './mcp-registry.service';
import { McpChangeFeed } from './tools/mcp-change.feed';
import { McpRadioReadTools } from './tools/radio-read.tools';

/**
 * gaulatti/alcantara#211: the /mcp endpoint, its OAuth discovery documents
 * and the tool registry. PompeiiService, TestAuthService, ProgramService and
 * ManagedMetricsService, FlightService and the radio services come from
 * their global modules; the as-run and songs services from their own
 * modules. McpRadioReadTools (gaulatti/alcantara#214) is the R-tier radio
 * tools provider. Registered in
 * AppModule by the integrator (gaulatti/alcantara#221).
 */
@Module({
  imports: [DiscoveryModule, AsRunModule, SongsModule],
  controllers: [McpController, McpOAuthController, McpOAuthProxyController],
  providers: [
    McpOAuthProxyService,
    McpAuthService,
    McpRegistry,
    McpActionExecutor,
    McpChangeFeed,
    McpRadioReadTools,
    { provide: MCP_ACTION_EXECUTOR, useExisting: McpActionExecutor },
  ],
  exports: [McpRegistry],
})
export class McpModule {}
