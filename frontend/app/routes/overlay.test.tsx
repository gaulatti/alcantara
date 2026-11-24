import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Overlay, { mergeMarks, overlayMarks, programMarks } from "./overlay";

// gaulatti/alcantara#404 (overlay route, outside the #404 list): the overlay's marks come from the URL, fall back to the
// program's active scene when the URL names a program, and the explicit marks win over the program's.

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

it("reads the marks and the program from the URL, trimming and dropping empty logos", () => {
  expect(
    overlayMarks("?program=main&callsign=%20WXYZ%20&subtitle=Live&chyron=News&logo=a.png&logo=%20&logo=b.png"),
  ).toEqual({ program: "main", callsign: "WXYZ", subtitle: "Live", chyron: "News", logos: ["a.png", "b.png"] });
});

it("takes the program's marks from its active scene, from text or an object of metadata", () => {
  expect(programMarks(undefined)).toEqual({ callsign: "", subtitle: "", chyron: "", logos: [] });
  expect(
    programMarks({ chyronText: " Breaking ", metadata: JSON.stringify({ "toni-logo": { callsign: " 88.1 ", subtitle: "FM" } }) }),
  ).toEqual({ callsign: "88.1", subtitle: "FM", chyron: "Breaking", logos: [] });
  expect(programMarks({ metadata: { "toni-logo": { callsign: "Object" } } })).toMatchObject({ callsign: "Object" });
  expect(programMarks({ metadata: "not json" })).toEqual({ callsign: "", subtitle: "", chyron: "", logos: [] });
  expect(programMarks({ metadata: "[1,2]" })).toEqual({ callsign: "", subtitle: "", chyron: "", logos: [] });
});

it("prefers the explicit marks over the program's, field by field, and keeps the program's logos when none are given", () => {
  const program = { callsign: "P", subtitle: "PS", chyron: "PC", logos: ["p.png"] };
  expect(mergeMarks({ callsign: "E", subtitle: "", chyron: "", logos: [] }, program)).toEqual({
    callsign: "E",
    subtitle: "PS",
    chyron: "PC",
    logos: ["p.png"],
  });
  expect(mergeMarks({ callsign: "", subtitle: "", chyron: "", logos: ["e.png"] }, program).logos).toEqual(["e.png"]);
});

it("loads the named program's active scene for its marks, and refreshes them", async () => {
  window.history.replaceState({}, "", "/overlay?program=main");
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
    Response.json({ activeScene: { chyronText: "On air", metadata: {} } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<Overlay />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/program/main/state");
});

it("does not load a program when the URL names none", async () => {
  window.history.replaceState({}, "", "/overlay?callsign=WXYZ");
  const fetchMock = vi.fn(async () => Response.json({}));
  vi.stubGlobal("fetch", fetchMock);
  render(<Overlay />);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("falls back to no program marks when the program state cannot be read", async () => {
  window.history.replaceState({}, "", "/overlay?program=main");
  const fetchMock = vi.fn(async () => new Response("down", { status: 500 }));
  vi.stubGlobal("fetch", fetchMock);
  const { container } = render(<Overlay />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(container.firstChild).toBeTruthy();
});

it("shows the logos named in the URL", () => {
  window.history.replaceState({}, "", "/overlay?callsign=WXYZ&logo=a.png&logo=b.png");
  const { container } = render(<Overlay />);
  expect(container.innerHTML).toContain("a.png");
});
