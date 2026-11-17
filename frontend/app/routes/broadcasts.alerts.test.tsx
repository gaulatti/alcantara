import { cleanup, render, screen } from "@testing-library/react";
import { AxiosError } from "axios";
import { afterEach, expect, it, vi } from "vitest";
import Broadcasts from "./broadcasts";

// gaulatti/alcantara#203: the broadcasts page renders its AlertContainer only
// after loading, so the alert for a failed first load is raised before the
// container mounts. Bleecker 0.1.45 shows it once the container mounts.

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("../services/api", async (original) => ({
  ...(await original<typeof import("../services/api")>()),
  api,
}));
vi.mock("../hooks/useFeatures", () => ({
  useFeatures: () => ({ loading: false, hasPermission: () => true }),
}));
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => ["news tv"],
}));
vi.mock("../components/ProgramFillerPanel", () => ({
  ProgramFillerPanel: () => null,
}));

afterEach(cleanup);

it("shows the error when the first load fails", async () => {
  api.get.mockRejectedValue(
    new AxiosError("Request failed", "ERR_BAD_RESPONSE", undefined, undefined, {
      status: 500,
      data: {},
      statusText: "",
      headers: {},
      config: {} as never,
    }),
  );
  render(<Broadcasts />);
  expect(
    await screen.findByText("Server error. Please try again later."),
  ).toBeInTheDocument();
  expect(
    screen.getAllByText("Server error. Please try again later."),
  ).toHaveLength(1);
});
