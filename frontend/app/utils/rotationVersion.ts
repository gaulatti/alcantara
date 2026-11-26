/**
 * The version of the rotation the console holds, which every save sends: the backend refuses a save made from another
 * one. `null` until a load succeeds. A backend that gives no version leaves it `undefined`, and none is sent.
 */
export function createRotationVersion() {
  let held: string | null | undefined = null;
  // The versions this console's own saves started from, and what the last of them stored.
  const own = new Set<string>();
  let latest: string | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const read = (source: unknown): void => {
    if (!source || typeof source !== "object") return;
    const { songSequence, sequenceVersion } = source as {
      songSequence?: unknown;
      sequenceVersion?: unknown;
    };
    if (typeof sequenceVersion === "string") held = sequenceVersion;
    else if (songSequence !== undefined && held === null) held = undefined;
  };

  return {
    /** Takes the version from a load, a save's answer or a realtime message. */
    read,
    /** A load failed, or another program is shown: what the console holds was loaded from nowhere. */
    forget(): void {
      held = null;
      own.clear();
      latest = undefined;
    },
    /**
     * Runs one save at a time. A save sends the version the console held when the edit was made, except that an edit
     * made before this console's own earlier save was answered follows that save.
     */
    save<T>(run: (version: string | null | undefined) => Promise<T>): Promise<T> {
      const made = held;
      const next = queue.then(async () => {
        const version =
          typeof made === "string" && own.has(made) ? latest : made;
        const answer = await run(version);
        const stored = (answer as { sequenceVersion?: unknown } | null)
          ?.sequenceVersion;
        if (typeof stored === "string" && typeof version === "string") {
          own.add(version);
          if (typeof made === "string") own.add(made);
          own.delete(stored);
          latest = stored;
        }
        return answer;
      });
      queue = next.catch(() => {});
      return next;
    },
  };
}
