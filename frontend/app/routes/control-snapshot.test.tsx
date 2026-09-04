import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { normalizeProgramState, readControlUpdateVersion, resolveControlUpdateTopicFromType } from '../utils/broadcast';

// Execute the actual route callbacks without mounting unrelated audio engines.
const source = ts.createSourceFile('control.tsx', readFileSync('app/routes/control.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name: string, bindings: Record<string, unknown>) {
  let expression: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) expression = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!expression) throw new Error(`Missing route callback: ${name}`);
  const js = ts.transpileModule(`(${expression.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), `return ${js}`)(...Object.values(bindings));
}

function harness(connected = false) {
  const latestControlVersionByTopicRef = { current: { state: -1 } };
  const accept = callback('shouldApplyControlUpdatePayload', { latestControlVersionByTopicRef, readControlUpdateVersion, resolveControlUpdateTopicFromType });
  const sync = vi.fn();
  const handle = callback('handleProgramEvent', {
    isProgramRealtimeConnected: connected, activeProgramId: 'test-tv',
    shouldApplyControlUpdatePayload: accept, normalizeProgramState,
    syncProgramStateAndStagedScene: sync,
  });
  return { accept, handle, sync };
}

const scene = { id: 65, name: 'Test active scene' };
const state = { programId: 'test-tv', version: 7, activeSceneId: 65, activeScene: scene, stagedSceneId: 65, stagedScene: scene, scenes: Array.from({ length: 12 }, (_, i) => ({ sceneId: i + 65, scene: { id: i + 65, name: `Scene ${i}` } })) };
const snapshot = { type: 'program_state_snapshot', programId: 'test-tv', version: 7, state };

describe('Control initial SSE snapshot', () => {
  it('hydrates all scenes and monitors before equal-version reconciliation is discarded', () => {
    const { handle, accept, sync } = harness();
    handle(snapshot);
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ activeScene: scene, stagedScene: scene, scenes: state.scenes }));
    expect(sync.mock.calls[0][0].scenes).toHaveLength(12);
    expect(accept(state, 'state')).toBe(false);
    handle(snapshot);
    expect(sync).toHaveBeenCalledTimes(1);
  });
  it('ignores another program without consuming the current version', () => {
    const { handle, sync } = harness();
    handle({ ...snapshot, programId: 'other' });
    expect(sync).not.toHaveBeenCalled();
    handle(snapshot);
    expect(sync).toHaveBeenCalledTimes(1);
  });
  it('leaves SSE inactive while WebSocket is connected', () => {
    const { handle, sync } = harness(true);
    handle(snapshot);
    expect(sync).not.toHaveBeenCalled();
  });
});
