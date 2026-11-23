import { Module } from '@nestjs/common';
import { AccessMcpTools } from '../mcp/capabilities/access';
import { AccessController } from './access.controller';
import { AccessService } from './access.service';

/**
 * gaulatti/alcantara#224: the Access page's backend (forwarding to Pompeii) and
 * the MCP access capabilities. PompeiiService and ManagedMetricsService come
 * from their global modules.
 */
@Module({
  controllers: [AccessController],
  providers: [AccessService, AccessMcpTools],
  exports: [AccessService],
})
export class AccessModule {}
