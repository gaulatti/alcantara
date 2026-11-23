import { Injectable } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { ProgramService } from '../program/program.service';
import { McpToolProvider, type McpToolSpec } from './contract';
import { McpRegistry } from './mcp-registry.service';

// Discovery: only decorated providers contribute specs, and a name is unique.

const spec = (name: string): McpToolSpec => ({
  name,
  title: name,
  description: name,
  permission: ALCANTARA_PERMISSIONS.access,
  tier: 'R',
  firstClass: false,
  shape: {},
  run: () => Promise.resolve({ result: null, audit: {} }),
});

@Injectable()
@McpToolProvider()
class Provides {
  specs() {
    return [spec('provided_one')];
  }
}

@Injectable()
class NotAProvider {
  specs() {
    return [spec('never_listed')];
  }
}

@Injectable()
@McpToolProvider()
class Duplicates {
  specs() {
    return [spec('whoami')];
  }
}

async function registry(providers: unknown[]) {
  const module = await Test.createTestingModule({
    imports: [DiscoveryModule],
    providers: [
      McpRegistry,
      { provide: ProgramService, useValue: {} },
      { provide: ManagedMetricsService, useValue: new ManagedMetricsService() },
      { provide: 'A_PLAIN_VALUE', useValue: 3 },
      ...(providers as never[]),
    ],
  }).compile();
  await module.init();
  return module;
}

describe('MCP registry discovery', () => {
  it('collects the built-in specs and decorated providers only', async () => {
    const module = await registry([Provides, NotAProvider]);
    const names = module
      .get(McpRegistry)
      .all()
      .map((s) => s.name);
    expect(names).toEqual([
      'whoami',
      'list_programs',
      'list_capabilities',
      'call_capability',
      'provided_one',
    ]);
    await module.close();
  });

  it('refuses two specs with one name', async () => {
    await expect(registry([Duplicates])).rejects.toThrow(
      'Duplicate MCP tool name: whoami',
    );
  });
});
