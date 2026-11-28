import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ManualRundown from "./ManualRundown";
import { fetchFlightSequences } from "../services/flight";
import { RUNDOWN_FORBIDDEN } from "../utils/rundownForbidden";

vi.mock("../hooks/useProgramEvents", () => ({ useProgramEvents: () => {} }));
vi.mock("../utils/globalProgram", () => ({ useGlobalProgramId: () => ["main"] }));
vi.mock("../services/flight", async (original) => ({
  ...(await original<typeof import("../services/flight")>()),
  fetchFlightSequences: vi.fn(),
}));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("says the account may not see the rundown instead of offering to create one", async () => {
  vi.mocked(fetchFlightSequences).mockRejectedValue(new Error(RUNDOWN_FORBIDDEN));
  render(<ManualRundown />);
  await screen.findByText("Rundowns are not available");
  expect(screen.getByText(RUNDOWN_FORBIDDEN)).toBeVisible();
  expect(screen.queryByText("No rundowns yet")).toBeNull();
  expect(screen.queryByRole("button", { name: /New rundown|Create rundown/ })).toBeNull();
});

it("keeps quiet about a refusal that arrives after the rundown closed", async () => {
  let refuse!: (reason: Error) => void;
  vi.mocked(fetchFlightSequences).mockReturnValue(new Promise((_, reject) => (refuse = reject)));
  const { unmount } = render(<ManualRundown />);
  unmount();
  refuse(new Error(RUNDOWN_FORBIDDEN));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText("Rundowns are not available")).toBeNull();
});
