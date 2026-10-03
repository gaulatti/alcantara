import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import { runSceneSaveDrain } from "../utils/sceneSaveDrain";
// Exercise the actual control route's save and TAKE callbacks.
const source = ts.createSourceFile(
  "control.tsx",
  readFileSync("app/routes/control.tsx", "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function routeCallback(name: string, bindings: Record<string, unknown>) {
  let expression: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === name &&
      node.initializer
    ) {
      expression = ts.isCallExpression(node.initializer)
        ? node.initializer.arguments[0]
        : node.initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!expression) throw new Error(`Missing ${name}`);
  const js = ts.transpileModule(`(${expression.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(bindings), `return ${js}`)(
    ...Object.values(bindings),
  );
}
afterEach(() => vi.restoreAllMocks());
it("saves repeated scene edits and preserves the latest edit after failure", async () => {
  const pending = { current: null as any };
  const slot = { current: null as Promise<void> | null };
  const persist = vi.fn(async (_id: number, _props: unknown) => undefined);
  const bindings: Record<string, any> = {
    runSceneSaveDrain,
    sceneAttributeSaveDrainPromiseRef: slot,
    pendingSceneAttributeSaveRef: pending,
    sceneAttributeRetryTimerRef: { current: null },
    sceneAttributeRetryDelayMsRef: { current: 800 },
    selectedSceneRef: { current: 80 },
    sceneEditorAutosaveSignatureRef: { current: "" },
    sceneEditorRevisionRef: { current: 2 },
    sceneEditorDirtyRef: { current: true },
    setIsSavingSceneAttributes: vi.fn(),
    setSceneAttributeSaveError: vi.fn(),
    persistSceneAttributes: persist,
  };
  let flush: () => Promise<void>;
  bindings.flushQueuedSceneAttributeSaves = () => flush();
  flush = routeCallback("flushQueuedSceneAttributeSaves", bindings);
  const payload = (revision: number, show: boolean) => ({
    sceneId: 80,
    props: { player: { show } },
    revision,
    signature: `${revision}`,
  });
  pending.current = payload(1, false);
  await flush();
  pending.current = payload(2, true);
  await flush();
  expect(persist.mock.calls).toEqual([
    [80, { player: { show: false } }],
    [80, { player: { show: true } }],
  ]);
  expect(slot.current).toBeNull();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  let reject!: (error: Error) => void;
  persist.mockImplementationOnce(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  pending.current = payload(3, false);
  const failedSave = flush();
  pending.current = payload(4, true);
  reject(new Error("Network unavailable"));
  await expect(failedSave).rejects.toThrow("Network unavailable");
  expect(pending.current.revision).toBe(4);
  await flush();
  expect(persist).toHaveBeenLastCalledWith(80, { player: { show: true } });
  expect(slot.current).toBeNull();
});
it("never activates Program when saving Preview fails, and makes the error visible", async () => {
  const requestSceneTake = vi.fn();
  const setTakeError = vi.fn();
  const takeInFlightRef = { current: false };
  const take = routeCallback("takeStagedSceneLive", {
    selectedSceneRef: { current: 80 },
    activeProgramIdRef: { current: "main" },
    takeInFlightRef,
    setTakeBusy: vi.fn(),
    setTakeError,
    flushSceneAttributeAutosaveForScene: vi.fn(async () => {
      throw new Error("Scene save failed");
    }),
    isSceneAssigned: () => true,
    requestSceneTake,
    selectedTransitionId: "cut",
  });
  await take();
  expect(requestSceneTake).not.toHaveBeenCalled();
  expect(setTakeError).toHaveBeenLastCalledWith("Scene save failed");
  expect(takeInFlightRef.current).toBe(false);
});
