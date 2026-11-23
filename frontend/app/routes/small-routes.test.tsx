import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import ControlLegacyRoute from "./control-legacy";
import RundownPage, { meta as flightMeta } from "./flight";
import LegacyRadioLog, { meta as radioLogMeta } from "./radio-log";
import RadioOutput from "./radio-output";
import ProtectedLayout from "./protected";
import Logout from "./logout";

// The thin routes: redirects, the protected layout and sign-out. Each renders
// what its owning component or provider supplies, so those are stand-ins here.

const { dispatch, setSelectedProgram } = vi.hoisted(() => ({
  dispatch: vi.fn(),
  setSelectedProgram: vi.fn(),
}));
vi.mock("react-redux", () => ({ useDispatch: () => dispatch }));
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => ["main", setSelectedProgram],
}));
vi.mock("../components/RundownWorkspace", () => ({
  RundownWorkspace: ({ programType }: { programType: string | null }) => (
    <p>Rundown for {programType ?? "unknown"} program</p>
  ),
}));
vi.mock("../components/common/ProtectedRoute", () => ({
  default: ({ children }: { children: ReactNode }) => (
    <section aria-label="Signed-in area">{children}</section>
  ),
}));
vi.mock("../hooks/useFeatures", () => ({
  FeaturesProvider: ({ children }: { children: ReactNode }) => (
    <section aria-label="Features">{children}</section>
  ),
}));
vi.mock("../contexts/ConsolePreferencesContext", () => ({
  ConsolePreferencesProvider: ({ children }: { children: ReactNode }) => (
    <section aria-label="Console preferences">{children}</section>
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function Where() {
  const location = useLocation();
  return (
    <p>
      At {location.pathname}
      {location.hash}
    </p>
  );
}

function renderAt(path: string, routes: ReactNode) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        {routes}
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

it("sends the old control page to the console home", () => {
  renderAt(
    "/control-legacy",
    <Route path="/control-legacy" element={<ControlLegacyRoute />} />,
  );
  expect(screen.getByText("At /")).toBeVisible();
});

it("sends the old radio log to the rundown, under the rundown title", () => {
  renderAt(
    "/radio-log",
    <Route path="/radio-log" element={<LegacyRadioLog />} />,
  );
  expect(screen.getByText("At /flight")).toBeVisible();
  expect(radioLogMeta()).toEqual([{ title: "Rundown - Alcantara" }]);
});

it("opens the rundown for the program type the console layout provides", () => {
  render(
    <MemoryRouter initialEntries={["/flight"]}>
      <Routes>
        <Route element={<Outlet context={{ programType: "radio" }} />}>
          <Route path="/flight" element={<RundownPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  expect(screen.getByText("Rundown for radio program")).toBeVisible();
  expect(flightMeta()).toEqual([{ title: "Rundown - Alcantara" }]);
});

it("returns an old monitor link to that station's radio desk", () => {
  renderAt(
    "/radio-output/night-radio",
    <Route path="/radio-output/:programId" element={<RadioOutput />} />,
  );
  expect(setSelectedProgram).toHaveBeenCalledWith("night-radio");
  expect(screen.getByText("At /#radio-monitor")).toBeVisible();
});

it("returns a monitor link without a station to the radio desk", () => {
  renderAt(
    "/radio-output",
    <Route path="/radio-output" element={<RadioOutput />} />,
  );
  expect(setSelectedProgram).toHaveBeenCalledWith("");
  expect(screen.getByText("At /#radio-monitor")).toBeVisible();
});

it("puts protected pages inside the sign-in guard, features and console preferences", () => {
  renderAt(
    "/inside",
    <Route element={<ProtectedLayout />}>
      <Route path="/inside" element={<p>Console page</p>} />
    </Route>,
  );
  const guard = screen.getByRole("region", { name: "Signed-in area" });
  const features = within(guard).getByRole("region", { name: "Features" });
  const preferences = within(features).getByRole("region", {
    name: "Console preferences",
  });
  expect(within(preferences).getByText("Console page")).toBeVisible();
});

it("signs out, marks the session as checked and goes to sign-in", () => {
  renderAt("/logout", <Route path="/logout" element={<Logout />} />);
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(
    dispatch.mock.calls.map(([action]) => (action as { type: string }).type),
  ).toEqual(["LOGOUT", "SET_AUTH_LOADED"]);
  expect(screen.getByText("At /login")).toBeVisible();
});

it("shows that sign-out is in progress", () => {
  render(
    <MemoryRouter>
      <Logout />
    </MemoryRouter>,
  );
  expect(screen.getByText("Signing you out...")).toBeVisible();
});
