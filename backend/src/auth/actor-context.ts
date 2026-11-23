import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who caused an operator action on air (gaulatti/alcantara#213): the console
 * (the authenticated REST request) or an MCP client (the attribution hook).
 */
export type ActorVia = 'console' | 'mcp';

export interface Actor {
  /** Pompeii's canonical principal; null while unresolved during rollout. */
  principalId: string | null;
  via: ActorVia;
  /** MCP client name; null for the console. */
  client: string | null;
}

/** The three persisted and published attribution fields; all null when automatic. */
export interface ActorFields {
  actorPrincipalId: string | null;
  actorVia: ActorVia | null;
  actorClient: string | null;
}

interface ActorScope {
  actor: Actor;
  /** Cleared when the command that opened the scope has finished. */
  live: boolean;
}

const storage = new AsyncLocalStorage<ActorScope>();

/**
 * The acting identity of the command being handled. Engine and service code
 * reads it once, synchronously at command time, and carries the value with the
 * pending command or event: a timer or a later write must never read it,
 * because Node propagates the store into timers created during the command.
 * To make a late read harmless the scope expires when its command ends, after
 * which `current()` answers null.
 */
export class ActorContext {
  static open(actor: Actor): ActorScope {
    return { actor: { ...actor }, live: true };
  }

  static within<T>(scope: ActorScope, work: () => T): T {
    return storage.run(scope, work);
  }

  static close(scope: ActorScope): void {
    scope.live = false;
  }

  /** Runs `work` as `actor`; the scope expires when `work` settles. */
  static async run<T>(actor: Actor, work: () => Promise<T>): Promise<T> {
    const scope = ActorContext.open(actor);
    try {
      return await ActorContext.within(scope, work);
    } finally {
      ActorContext.close(scope);
    }
  }

  /** The actor of the command in progress, or null (automatic, or expired). */
  static current(): Actor | null {
    const scope = storage.getStore();
    return scope?.live ? { ...scope.actor } : null;
  }

  /** Event fields: the three attribution fields, or nothing when automatic. */
  static eventFields(actor: Actor | null | undefined): Partial<ActorFields> {
    return actor ? ActorContext.toFields(actor) : {};
  }

  static toFields(actor: Actor | null | undefined): ActorFields {
    return {
      actorPrincipalId: actor?.principalId ?? null,
      actorVia: actor?.via ?? null,
      actorClient: actor?.client ?? null,
    };
  }
}
