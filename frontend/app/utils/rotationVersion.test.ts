import { describe, expect, it } from "vitest";

import { createRotationVersion } from "./rotationVersion";

// A save of the rotation sends the version the console loaded, and none it did not.
describe("the console's rotation version", () => {
  const send = (version: ReturnType<typeof createRotationVersion>) => {
    let sent: string | null | undefined;
    return version
      .save(async (held) => {
        sent = held;
        return null;
      })
      .then(() => sent);
  };

  it("sends null until a load succeeds, and again once forgotten", async () => {
    const version = createRotationVersion();
    expect(await send(version)).toBeNull();
    version.read(undefined);
    version.read({});
    version.read({ songQueue: [] });
    expect(await send(version)).toBeNull();
    version.read({ songSequence: null, sequenceVersion: "v1" });
    expect(await send(version)).toBe("v1");
    version.read({ songSequence: null });
    expect(await send(version)).toBe("v1");
    version.forget();
    expect(await send(version)).toBeNull();
  });

  it("sends none to a backend that gives none", async () => {
    const version = createRotationVersion();
    version.read({ songSequence: null });
    expect(await send(version)).toBeUndefined();
  });

  it("runs saves one at a time, each following the one before", async () => {
    const version = createRotationVersion();
    version.read({ sequenceVersion: "v1" });
    const sent: unknown[] = [];
    const save = (stored: string) =>
      version.save(async (held) => {
        sent.push(held);
        return { sequenceVersion: stored };
      });
    // Three edits made before the first save is answered.
    await Promise.all([save("v2"), save("v3"), save("v4")]);
    expect(sent).toEqual(["v1", "v2", "v3"]);
  });

  it("does not move an edit past someone else's change", async () => {
    const version = createRotationVersion();
    version.read({ sequenceVersion: "v1" });
    await version.save(async () => ({ sequenceVersion: "v2" }));
    version.read({ sequenceVersion: "theirs" });
    expect(await send(version)).toBe("theirs");
  });

  it("sends the version now held when the rotation returns to one it already saved from", async () => {
    const version = createRotationVersion();
    version.read({ sequenceVersion: "manual" });
    await version.save(async () => ({ sequenceVersion: "autoplay" }));
    version.read({ sequenceVersion: "autoplay" });
    // The rotation ran out, or was stopped: the engine left it manual again and said so.
    version.read({ sequenceVersion: "manual" });
    expect(await send(version)).toBe("manual");
  });

  it("goes on after a refused save", async () => {
    const version = createRotationVersion();
    version.read({ sequenceVersion: "v1" });
    await expect(
      version.save(async () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    expect(await send(version)).toBe("v1");
  });
});
