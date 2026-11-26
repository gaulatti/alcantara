import { ProgramTeamAccess } from '../tenancy/program-team-access';
import { Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { ProgramService } from '../program/program.service';
import {
  MCP_ACTION_EXECUTOR,
  MCP_TOOL_PROVIDER,
  McpToolError,
  UNTRUSTED_NOTE,
  type McpActionExecutor,
  type McpContext,
  type McpPrincipal,
  type McpToolProviderShape,
  type McpToolSpec,
} from './contract';
import { actionShape, describeSpec } from './mcp-action.shape';
import { MCP_LIMITS } from './mcp.constants';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function refusal(error: unknown): ToolResult {
  const known = error instanceof McpToolError;
  const body = known
    ? {
        error: error.code,
        message: error.message,
        ...(error.retryAfterSeconds === undefined
          ? {}
          : { retry_after_seconds: error.retryAfterSeconds }),
      }
    : { error: 'unavailable', message: 'The action could not be completed.' };
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    isError: true,
  };
}

/** The song rotation mode stored on a program, when it has one. */
function rotationMode(sequence: unknown): string | null {
  const mode = (sequence as { mode?: unknown } | null)?.mode;
  return typeof mode === 'string' ? mode : null;
}

/**
 * Collects every MCP tool spec: the built-in ones here plus every class
 * decorated with @McpToolProvider(). Registers, for one request, the
 * first-class specs the caller may use as tools, and list_capabilities and
 * call_capability over every spec the caller may use. A spec runs only when
 * the caller holds its permission, checked again at call time.
 */
@Injectable()
export class McpRegistry implements OnModuleInit {
  private specs: McpToolSpec[] = [];

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
    private readonly programs: ProgramService,
    private readonly metrics: ManagedMetricsService,
    @Optional()
    @Inject(MCP_ACTION_EXECUTOR)
    private readonly executor?: McpActionExecutor,
    @Optional() private readonly programTeams?: ProgramTeamAccess,
  ) {}

  onModuleInit(): void {
    const discovered = this.discovery
      .getProviders()
      .filter(
        (wrapper) =>
          wrapper.metatype &&
          wrapper.instance &&
          this.reflector.get(MCP_TOOL_PROVIDER, wrapper.metatype) === true,
      )
      .flatMap((wrapper) => (wrapper.instance as McpToolProviderShape).specs());
    const all = [...this.builtins(), ...discovered];
    const names = new Set<string>();
    for (const spec of all) {
      if (names.has(spec.name))
        throw new Error(`Duplicate MCP tool name: ${spec.name}`);
      names.add(spec.name);
    }
    this.specs = all;
    this.metrics.registerMcpTools([...names]);
  }

  /**
   * The public catalogue (GET /mcp/capabilities): name, title, description, tier
   * and permission of every registered capability, sorted by name. Input schemas
   * and data are never included.
   */
  publicCatalogue(): {
    name: string;
    title: string;
    description: string;
    tier: string;
    permission: string;
  }[] {
    return [...this.specs]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((spec) => ({
        name: spec.name,
        title: spec.title,
        description: spec.description,
        tier: spec.tier,
        permission: spec.permission,
      }));
  }

  /** Every spec the registry holds (for the integrator's registry test). */
  all(): readonly McpToolSpec[] {
    return this.specs;
  }

  register(
    server: McpServer,
    principal: McpPrincipal,
    reauthorize: () => Promise<McpPrincipal>,
    bearer?: string,
  ): void {
    const ctx: McpContext = { principal, reauthorize, bearer };
    const allowed = this.specs.filter((spec) =>
      principal.permissions.has(spec.permission),
    );
    for (const spec of allowed.filter((s) => s.firstClass)) {
      server.registerTool(
        spec.name,
        {
          title: spec.title,
          description: describeSpec(spec),
          inputSchema: actionShape(spec),
          annotations: {
            readOnlyHint: spec.tier === 'R',
            destructiveHint: spec.tier === 'D',
            idempotentHint: spec.tier === 'R',
          },
        },
        (args: Record<string, unknown>) => this.call(spec, args, ctx),
      );
    }
  }

  private async call(
    spec: McpToolSpec,
    args: Record<string, unknown>,
    ctx: McpContext,
  ): Promise<ToolResult> {
    // The executor counts the W, A and D calls it takes; everything else is
    // counted here.
    let counted = false;
    try {
      if (!ctx.principal.permissions.has(spec.permission))
        throw new McpToolError('forbidden', `requires ${spec.permission}`);
      // A tool acts only on the station team's programs (gaulatti/alcantara#122).
      if (
        this.programTeams &&
        typeof args.program_id === 'string' &&
        !(await this.programTeams.allowsStation(args.program_id))
      )
        throw new McpToolError('not_found', 'Program not found');
      if (spec.tier !== 'R') {
        if (!this.executor)
          throw new McpToolError(
            'unavailable',
            'Actions are not enabled on this server yet.',
          );
        let actingCtx = ctx;
        if (spec.tier === 'A' || spec.tier === 'D') {
          // No cached decision for what listeners hear or what cannot be undone.
          const fresh = await ctx.reauthorize!();
          if (!fresh.permissions.has(spec.permission))
            throw new McpToolError('forbidden', `requires ${spec.permission}`);
          actingCtx = {
            principal: fresh,
            reauthorize: ctx.reauthorize,
            bearer: ctx.bearer,
          };
        }
        counted = true;
        return ok(await this.executor.execute(spec, args, actingCtx));
      }
      const parsed = z.object(spec.shape).strict().safeParse(args);
      if (!parsed.success)
        throw new McpToolError('invalid', parsed.error.issues[0].message);
      const outcome = await spec.run(parsed.data, ctx);
      this.metrics.recordMcpRequest(spec.name, spec.tier, 'ok');
      return ok(outcome.result);
    } catch (error) {
      if (!counted)
        this.metrics.recordMcpRequest(
          spec.name,
          spec.tier,
          error instanceof McpToolError ? error.code : 'unavailable',
        );
      return refusal(error);
    }
  }

  private builtins(): McpToolSpec[] {
    const whoami: McpToolSpec = {
      name: 'whoami',
      title: 'Who am I',
      description:
        'Confirms the connection and reports the Alcantara permissions Pompeii granted you.',
      permission: ALCANTARA_PERMISSIONS.access,
      tier: 'R',
      firstClass: true,
      shape: {},
      run: (_args, { principal }) =>
        Promise.resolve({
          result: {
            subject: principal.subject,
            principal_id: principal.principalId,
            client: principal.client,
            permissions: [...principal.permissions].sort(),
          },
          audit: {},
        }),
    };
    const listPrograms: McpToolSpec = {
      name: 'list_programs',
      title: 'List programs',
      description:
        'Lists Alcantara programs with their id, type (radio or tv) and song rotation mode.',
      permission: ALCANTARA_PERMISSIONS.program.read,
      tier: 'R',
      firstClass: true,
      shape: {},
      run: async () => {
        const programs = (await this.programs.listPrograms()) as Array<{
          programId: string;
          type: string;
          songSequence?: unknown;
        }>;
        return {
          result: {
            programs: programs.map((program) => ({
              program_id: program.programId,
              type: program.type,
              mode: rotationMode(program.songSequence),
            })),
          },
          audit: { count: programs.length },
        };
      },
    };
    const listCapabilities: McpToolSpec = {
      name: 'list_capabilities',
      title: 'List capabilities',
      description: `Lists every Alcantara action you may run (name, title, description, tier, permission, input schema), paged and searchable. Run one with call_capability. ${UNTRUSTED_NOTE}`,
      permission: ALCANTARA_PERMISSIONS.access,
      tier: 'R',
      firstClass: true,
      shape: {
        query: z.string().max(100).optional(),
        offset: z.number().int().min(0).optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MCP_LIMITS.capabilityPageMax)
          .optional(),
      },
      run: (args, { principal }) => {
        const query = (args.query as string | undefined)?.toLowerCase();
        const offset = (args.offset as number | undefined) ?? 0;
        const limit =
          (args.limit as number | undefined) ??
          MCP_LIMITS.capabilityPageDefault;
        const matches = this.specs.filter(
          (spec) =>
            principal.permissions.has(spec.permission) &&
            (!query ||
              spec.name.includes(query) ||
              spec.title.toLowerCase().includes(query) ||
              spec.description.toLowerCase().includes(query)),
        );
        return Promise.resolve({
          result: {
            total: matches.length,
            offset,
            capabilities: matches.slice(offset, offset + limit).map((spec) => ({
              name: spec.name,
              title: spec.title,
              description: describeSpec(spec),
              tier: spec.tier,
              permission: spec.permission,
              supports_dry_run: spec.dryRun !== undefined,
              needs_confirm: spec.confirmTarget !== undefined,
              input_schema: toJsonSchemaCompat(z.object(actionShape(spec))),
            })),
          },
          audit: { count: matches.length },
        });
      },
    };
    const callCapability: McpToolSpec = {
      name: 'call_capability',
      title: 'Call a capability',
      description:
        'Runs one action found with list_capabilities. Pass its name and arguments (plus dry_run, confirm and idempotency_key where the capability needs them). It runs through exactly the same permission, dry-run, confirmation, rate-limit and audit path as a listed tool.',
      permission: ALCANTARA_PERMISSIONS.access,
      tier: 'R',
      firstClass: true,
      shape: {
        name: z.string().max(100),
        arguments: z.record(z.string(), z.unknown()).optional(),
      },
      run: async (args, ctx) => {
        const spec = this.specs.find(
          (candidate) =>
            candidate.name === args.name &&
            candidate.name !== 'call_capability',
        );
        if (!spec) throw new McpToolError('not_found', 'Unknown capability.');
        const answer = await this.call(
          spec,
          (args.arguments as Record<string, unknown> | undefined) ?? {},
          ctx,
        );
        if (answer.isError) {
          const body = JSON.parse(answer.content[0].text) as {
            error: McpToolError['code'];
            message: string;
            retry_after_seconds?: number;
          };
          throw new McpToolError(
            body.error,
            body.message,
            body.retry_after_seconds,
          );
        }
        return {
          result: JSON.parse(answer.content[0].text) as unknown,
          audit: { target: spec.name },
        };
      },
    };
    return [whoami, listPrograms, listCapabilities, callCapability];
  }
}
