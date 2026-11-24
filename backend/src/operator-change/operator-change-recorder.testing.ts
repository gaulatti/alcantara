import type { OperatorChangeRecorder } from './operator-change-recorder';

export type RecorderStub = OperatorChangeRecorder & {
  actor: jest.Mock;
  record: jest.Mock;
};

/** A recorder for a spec that is not about operator change records: no actor, nothing stored. */
export function noRecorder(): RecorderStub {
  return {
    actor: jest.fn(() => null),
    record: jest.fn(async () => undefined),
  } as unknown as RecorderStub;
}

export const mcpActor = {
  principalId: 'principal-mcp',
  via: 'mcp' as const,
  client: 'claude-desktop',
};
