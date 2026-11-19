import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { MCP_ACTION_EXECUTOR } from './contract';
import { McpActionExecutor } from './mcp-action.executor';
import { McpAuthService } from './mcp-auth.service';
import { McpController } from './mcp.controller';
import { McpOAuthController } from './mcp-oauth.controller';
import { McpRegistry } from './mcp-registry.service';

/**
 * gaulatti/alcantara#211: the /mcp endpoint, its OAuth discovery documents
 * and the tool registry. PompeiiService, TestAuthService, ProgramService and
 * ManagedMetricsService come from their global modules. Registered in
 * AppModule by the integrator (gaulatti/alcantara#221).
 */
@Module({
  imports: [DiscoveryModule],
  controllers: [McpController, McpOAuthController],
  providers: [
    McpAuthService,
    McpRegistry,
    McpActionExecutor,
    { provide: MCP_ACTION_EXECUTOR, useExisting: McpActionExecutor },
  ],
  exports: [McpRegistry],
})
export class McpModule {}
