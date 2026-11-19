import { z } from 'zod';
import type { McpToolSpec } from './contract';
import { MCP_ACTION_LIMITS } from './mcp.constants';

/** Appended to the description of every A and D spec the registry shows. */
export const MCP_IDEMPOTENCY_NOTE =
  'idempotency_key is required; the key and its stored outcome are held in memory for 10 minutes and do not survive a backend restart, so a retry after a restart runs again.';

const shapes = new WeakMap<McpToolSpec, z.ZodRawShape>();

/**
 * The arguments a spec accepts as advertised and parsed: its domain shape plus
 * the framework fields. dry_run exists only where the spec has a dry run and
 * confirm only where it has a confirm target; idempotency_key is required for
 * every W, A and D spec. R specs keep their own shape.
 */
export function actionShape(spec: McpToolSpec): z.ZodRawShape {
  if (spec.tier === 'R') return spec.shape;
  let shape = shapes.get(spec);
  if (!shape) {
    shape = {
      ...spec.shape,
      ...(spec.dryRun ? { dry_run: z.boolean().optional() } : {}),
      ...(spec.confirmTarget
        ? { confirm: z.string().max(MCP_ACTION_LIMITS.confirmMax).optional() }
        : {}),
      idempotency_key: z
        .string()
        .min(MCP_ACTION_LIMITS.idempotencyKeyMin)
        .max(MCP_ACTION_LIMITS.idempotencyKeyMax)
        .regex(/^[A-Za-z0-9._:-]+$/),
    };
    shapes.set(spec, shape);
  }
  return shape;
}

/** The description the registry shows: A and D carry the idempotency note. */
export function describeSpec(spec: McpToolSpec): string {
  return spec.tier === 'A' || spec.tier === 'D'
    ? `${spec.description} ${MCP_IDEMPOTENCY_NOTE}`
    : spec.description;
}
