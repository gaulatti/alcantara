import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Overlay from "./overlay";

// The overlay (a browser source with no sign-in) reads the public state for the program named in its URL. The public
// state is projected: it may carry only the fields the renderer reads. This renders the overlay from a full state and
// from that projected state, for a scene with a logo and chyron, and asserts the two draw the same.

const SCENE_METADATA = {
  "toni-logo": { callsign: "Fictional 88.1", subtitle: "Fictional FM" },
};

const fullScene = {
  id: 7,
  name: "Fictional overlay scene",
  layoutId: 1,
  chyronText: "Fictional breaking chyron",
  description: "Fictional description the overlay never reads",
  metadata: JSON.stringify(SCENE_METADATA),
  layout: { id: 1, name: "Fictional layout", componentType: "toni-chyron" },
};

const projectedScene = {
  id: 7,
  chyronText: fullScene.chyronText,
  metadata: fullScene.metadata,
  layout: { componentType: fullScene.layout.componentType },
};

const fullState = {
  id: 1,
  programId: "main",
  type: "tv",
  activeSceneId: 7,
  activeScene: fullScene,
  stagedSceneId: null,
  stagedScene: null,
  fadeToBlack: false,
  scenes: [fullScene],
  mediaGroups: [],
  stingers: [],
  version: 4,
};

const projectedState = {
  activeSceneId: 7,
  activeScene: projectedScene,
  fadeToBlack: false,
  stingers: [],
  version: 4,
};

beforeEach(() => {
  // Only the clock is pinned, so both renders read the same time.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-28T12:00:00Z"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  window.history.replaceState({}, "", "/?program=main");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

async function drawFrom(state: unknown): Promise<string> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/program/main/state")) return Response.json(state);
      return new Response(null, { status: 404 });
    }),
  );
  const view = render(<Overlay />);
  await waitFor(() => expect(view.container.textContent).toContain("Fictional breaking chyron"));
  const html = view.container.innerHTML;
  view.unmount();
  return html;
}

describe("the overlay draws the same from the projected public state as from the full state", () => {
  it("the logo and chyron of the program's active scene", async () => {
    const fromFull = await drawFrom(fullState);
    const fromProjected = await drawFrom(projectedState);
    expect(fromProjected).toBe(fromFull);
    expect(fromFull).toContain("Fictional breaking chyron");
  });
});
