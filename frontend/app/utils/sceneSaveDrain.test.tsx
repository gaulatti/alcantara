import { expect, it, vi } from "vitest";
import { runSceneSaveDrain } from "./sceneSaveDrain";

it("persists a second edit after the previous save completes", async () => {
  const slot = { current: null as Promise<void> | null };
  const persist = vi.fn(async (_metadata: unknown) => undefined);
  await runSceneSaveDrain(
    slot,
    () => persist({ show: false }),
    () => undefined,
  );
  expect(slot.current).toBeNull();
  await runSceneSaveDrain(
    slot,
    () => persist({ show: true }),
    () => undefined,
  );
  expect(persist.mock.calls).toEqual([[{ show: false }], [{ show: true }]]);
  expect(slot.current).toBeNull();
});

it("shares an in-flight save and releases failed saves for retry", async () => {
  const slot = { current: null as Promise<void> | null };
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_, fail) => {
    reject = fail;
  });
  const settled = vi.fn();
  const first = runSceneSaveDrain(slot, () => pending, settled);
  const duplicate = vi.fn(async () => undefined);
  expect(runSceneSaveDrain(slot, duplicate, settled)).toBe(first);
  expect(duplicate).not.toHaveBeenCalled();
  reject(new Error("Save unavailable"));
  await expect(first).rejects.toThrow("Save unavailable");
  expect(slot.current).toBeNull();
  await runSceneSaveDrain(slot, duplicate, settled);
  expect(duplicate).toHaveBeenCalledTimes(1);
  expect(settled).toHaveBeenCalledTimes(2);
});
