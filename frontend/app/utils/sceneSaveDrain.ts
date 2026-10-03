/** Share in-flight saves, then release the queue on both success and failure. */
export function runSceneSaveDrain(
  slot: { current: Promise<void> | null },
  drain: () => Promise<void>,
  onSettled: () => void,
): Promise<void> {
  if (slot.current) return slot.current;
  const tracked = drain().finally(() => {
    if (slot.current === tracked) slot.current = null;
    onSettled();
  });
  slot.current = tracked;
  return tracked;
}
