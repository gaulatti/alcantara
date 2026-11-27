import { describe, expect, it } from "vitest";
import { GUEST_RETURN_COPY, guestReturnState } from "./guestReturnCopy";

// The guest's three states for the studio's return (display only): connecting, playing, dropped.
describe("guestReturnState", () => {
  it("is connecting before any return has been heard", () => {
    expect(guestReturnState({ returnFeed: false, everPlayed: false })).toBe("connecting");
    expect(GUEST_RETURN_COPY.connecting).toBe("Connecting you to the studio sound…");
  });

  it("is playing while the return is heard", () => {
    expect(guestReturnState({ returnFeed: true, everPlayed: false })).toBe("playing");
    expect(guestReturnState({ returnFeed: true, everPlayed: true })).toBe("playing");
    expect(GUEST_RETURN_COPY.playing).toBe("You're hearing the studio");
  });

  it("is dropped once a return was heard and has stopped, and says it comes back by itself", () => {
    expect(guestReturnState({ returnFeed: false, everPlayed: true })).toBe("dropped");
    expect(GUEST_RETURN_COPY.dropped).toBe("The studio sound dropped. It will come back by itself.");
  });

  it("never names the internal feed or bus wording a guest should not see", () => {
    for (const copy of Object.values(GUEST_RETURN_COPY)) {
      expect(copy).not.toMatch(/feed|bus|N-1|mix-minus|mixminus/i);
    }
  });
});
