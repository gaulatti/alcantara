import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FillerVersionSummary } from "../../models/filler";
import { RadioFillerStatus, radioFillerLines } from "./RadioFillerStatus";

// The radio desk's program filler line (gaulatti/alcantara#126). Fictional versions, built here.
const version = (id: string, status: FillerVersionSummary["status"] = "ready"): FillerVersionSummary => ({
  version: id,
  checksum: "c",
  status,
  reason: null,
  config: { sources: [], mode: "ordered" },
  createdAt: "2026-11-27T10:00:00.000Z",
  preparedAt: "2026-11-27T10:01:00.000Z",
});
const answer = (status: number, body: unknown = {}) =>
  vi.fn(async (_input: RequestInfo | URL) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response);

describe("the program filler lines", () => {
  it("says which version is on air and which is prepared for the next fallback start", () => {
    expect(radioFillerLines({ active: version("filler-radio-a"), pending: version("filler-radio-b") })).toEqual([
      "On air: filler-radio-a.",
      "Prepared next: filler-radio-b, used from the next Start with fallback.",
    ]);
    expect(radioFillerLines({ active: null, pending: version("filler-radio-b") })).toEqual([
      "Prepared: filler-radio-b, used at the next Start with fallback.",
    ]);
    expect(radioFillerLines({ active: version("filler-radio-a", "failed"), pending: null })).toEqual([
      "On air: filler-radio-a (failed).",
    ]);
  });

  it("says when nothing is prepared, and when a rename left the show without one", () => {
    expect(radioFillerLines({ active: null, pending: null })).toEqual(["No program filler: the recovery playlist applies."]);
    expect(radioFillerLines({ active: null, pending: null, needsPreparing: true })).toEqual([
      "No program filler is prepared since the show was renamed: prepare one in Configure.",
    ]);
  });
});

describe("RadioFillerStatus", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the program's radio leg and shows it, and reads again when the recovery state changes", async () => {
    const fetch = answer(200, { programId: "station a", legs: { radio: { active: null, pending: version("filler-radio-b") } } });
    vi.stubGlobal("fetch", fetch);
    const view = render(<RadioFillerStatus programId="station a" refreshKey="" />);
    expect(await screen.findByText("Prepared: filler-radio-b, used at the next Start with fallback.")).toBeTruthy();
    expect(String(fetch.mock.calls[0][0])).toMatch(/\/broadcast\/programs\/station%20a\/fillers$/);
    fetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ legs: { radio: { active: version("filler-radio-b"), pending: null } } }) }) as Response);
    view.rerender(<RadioFillerStatus programId="station a" refreshKey="filler-radio-b" />);
    expect(await screen.findByText("On air: filler-radio-b.")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("shows nothing for a program with no radio leg, a backend without the endpoint, or a caller who may not read it", async () => {
    for (const fetch of [answer(200, { legs: { television: { active: null, pending: null } } }), answer(404), answer(403)]) {
      vi.stubGlobal("fetch", fetch);
      const view = render(<RadioFillerStatus programId="p" />);
      await waitFor(() => expect(fetch).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(view.container.textContent).toBe("");
      view.unmount();
    }
  });

  it("says the status is unavailable when the read fails", async () => {
    for (const fetch of [answer(500), vi.fn(async () => Promise.reject(new TypeError("offline")))]) {
      vi.stubGlobal("fetch", fetch);
      const view = render(<RadioFillerStatus programId="p" />);
      expect(await screen.findByText("Program filler status unavailable.")).toBeTruthy();
      view.unmount();
    }
  });
});
