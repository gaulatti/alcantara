import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ProgramsAdmin from "./programs";

// gaulatti/alcantara#205: saving a show with an empty ID explains why in a
// complete sentence, and sends nothing.

vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => ["news", vi.fn()],
}));

let network: ReturnType<typeof vi.fn>;
beforeEach(() => {
  network = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/media-groups")) return Response.json({ data: [] });
    return Response.json([]);
  });
  vi.stubGlobal("fetch", network);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("refuses a show without an ID with a complete message", async () => {
  render(
    <MemoryRouter>
      <ProgramsAdmin />
    </MemoryRouter>,
  );
  fireEvent.click(
    (await screen.findAllByRole("button", { name: /Create show/ }))[0],
  );
  const dialog = await screen.findByRole("dialog", { name: "Create show" });
  fireEvent.change(within(dialog).getByPlaceholderText("main"), {
    target: { value: "   " },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create show" }));
  expect(
    await within(dialog).findByText("Program ID is required."),
  ).toBeInTheDocument();
  expect(network.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
    false,
  );
});
