import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  controlServer,
  stubConsoleBrowser,
  type ControlServer,
} from "../../test/controlKit";

// gaulatti/alcantara#195: the on-air page shows a slideshow's pictures from
// the media label or media group the scene names, in their saved order, and
// keeps showing what it was given when the library cannot be read.

vi.mock("../hooks/useSSE", () => ({ useSSE: () => ({ isConnected: false }) }));

import ProgramRoute from "./program";

let server: ControlServer;

const scene = (slideshow: Record<string, unknown>) => ({
  id: 7,
  name: "Fictional photo scene",
  layoutId: 1,
  metadata: JSON.stringify({ slideshow }),
  layout: { id: 1, name: "Photos", componentType: "slideshow" },
});
const programState = (slideshow: Record<string, unknown>) => ({
  id: 1,
  programId: "main",
  type: "tv",
  activeSceneId: 7,
  activeScene: scene(slideshow),
  fadeToBlack: false,
  scenes: [],
  mediaGroups: [],
});

const defaults = (slideshow: Record<string, unknown>) => ({
  "GET /program/main/state": () => Response.json(programState(slideshow)),
  "GET /program/main/audio-bus": () =>
    Response.json({ songSequence: null, songQueue: [] }),
  "GET /program/broadcast-settings": () => Response.json({}),
  "GET /program/main/scene-instant": () => Response.json({ isPlaying: false }),
  "GET /program/main/stingers": () => Response.json([]),
});

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"],
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  stubConsoleBrowser();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openPage(slideshow: Record<string, unknown>) {
  server = controlServer(defaults(slideshow));
  const view = render(
    <MemoryRouter initialEntries={["/program/main"]}>
      <Routes>
        <Route path="/program/:id" element={<ProgramRoute />} />
      </Routes>
    </MemoryRouter>,
  );
  return view;
}

const settle = () => act(() => vi.advanceTimersByTimeAsync(1000));
const pictures = (container: HTMLElement) =>
  [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));

it("shows a media label's pictures in their saved order and skips blank ones", async () => {
  const view = await openPage({ labelId: "label-a" });
  server.answer("GET /media-labels/label-a/images", () =>
    Response.json({
      id: "label-a",
      images: [
        { position: 2, imageUrl: "/second.jpg" },
        { position: 1, imageUrl: "/first.jpg" },
        { position: 3, imageUrl: "   " },
        { position: 4, imageUrl: null },
      ],
    }),
  );
  await act(() => vi.advanceTimersByTimeAsync(6000));
  expect(server.requests("GET /media-labels/label-a/images")).not.toHaveLength(0);
  expect(pictures(view.container)).toEqual(["/first.jpg", "/second.jpg"]);
});

it("shows a media group's pictures in their saved order, and reads a legacy group as a label too", async () => {
  const view = await openPage({ mediaGroupId: 4 });
  server.answer("GET /media-groups/4", () =>
    Response.json({
      id: 4,
      name: "Fictional group",
      description: null,
      items: [
        { id: 2, mediaGroupId: 4, mediaId: 2, position: 2, media: { id: 2, name: "b", imageUrl: "/b.jpg" } },
        { id: 1, mediaGroupId: 4, mediaId: 1, position: 1, media: { id: 1, name: "a", imageUrl: "/a.jpg" } },
        { id: 3, mediaGroupId: 4, mediaId: 3, position: 3, media: { id: 3, name: "c", imageUrl: "" } },
        { id: 4, mediaGroupId: 4, mediaId: 4, position: 4 },
      ],
    }),
  );
  await act(() => vi.advanceTimersByTimeAsync(6000));
  expect(server.requests("GET /media-groups/4")).not.toHaveLength(0);
  expect(
    server.requests("GET /media-labels/legacy-media-group:4/images"),
  ).not.toHaveLength(0);
  expect(pictures(view.container)).toEqual(["/a.jpg", "/b.jpg"]);
});

it("keeps the scene's own pictures when it names neither a label nor a group", async () => {
  const view = await openPage({ images: ["/own-1.jpg", "/own-2.jpg"] });
  await settle();
  expect(pictures(view.container)).toEqual(["/own-1.jpg", "/own-2.jpg"]);
});

it("keeps the scene's own pictures and logs one line when the group cannot be read", async () => {
  const view = await openPage({ mediaGroupId: 9, images: ["/own.jpg"] });
  server.answer("GET /media-groups/9", () => new Response("no", { status: 500 }));
  await act(() => vi.advanceTimersByTimeAsync(6000));
  expect(pictures(view.container)).toEqual(["/own.jpg"]);
  const logged = vi.mocked(console.error).mock.calls.map((call) => call.join(" "));
  expect(logged.some((line) => line.includes("Failed to load slideshow media groups"))).toBe(true);
});

it("shows nothing for a label that cannot be read", async () => {
  const view = await openPage({ labelId: "label-b" });
  server.answer("GET /media-labels/label-b/images", () => new Response("no", { status: 500 }));
  await act(() => vi.advanceTimersByTimeAsync(6000));
  expect(pictures(view.container)).toEqual([]);
  const logged = vi.mocked(console.error).mock.calls.map((call) => call.join(" "));
  expect(logged.some((line) => line.includes("Failed to load slideshow media labels"))).toBe(true);
});
