import type React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { RundownWorkspace } from "./RundownWorkspace";
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => ["fixture"],
}));
vi.mock("./ScheduledRundown", () => ({
  default: ({
    onDirtyChange,
    viewSwitch,
  }: {
    onDirtyChange?: (dirty: boolean) => void;
    viewSwitch?: React.ReactNode;
  }) => (
    <>
      <h1>Scheduled rundown</h1>
      {viewSwitch}
      <button onClick={() => onDirtyChange?.(true)}>Edit draft</button>
      <button onClick={() => onDirtyChange?.(false)}>Save draft</button>
    </>
  ),
}));
vi.mock("./ManualRundown", () => ({
  default: () => <h1>Operator rundown</h1>,
}));
let permissions: string[] = [];
vi.mock("../hooks/useFeatures", () => ({
  useFeatures: () => ({ hasPermission: (permission: string) => permissions.includes(permission) }),
}));
vi.mock("./RecipeEditor", () => ({
  default: ({ programId, canManage }: { programId: string; canManage: boolean }) => (
    <h1>
      Recipes of {programId} ({canManage ? "editable" : "read only"})
    </h1>
  ),
}));
afterEach(() => {
  cleanup();
  permissions = [];
});
it("opens scheduled radio and operator TV controls at the same workspace", async () => {
  const view = render(
    <MemoryRouter>
      <RundownWorkspace programType="radio" />
    </MemoryRouter>,
  );
  expect(await screen.findByText("Scheduled rundown")).toBeVisible();
  view.rerender(
    <MemoryRouter>
      <RundownWorkspace programType="tv" />
    </MemoryRouter>,
  );
  expect(await screen.findByText("Operator rundown")).toBeVisible();
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
});
it("keeps unsaved filler previews in the scheduled view until saved", async () => {
  render(
    <MemoryRouter>
      <RundownWorkspace programType="both" />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Edit draft" }));
  expect(await screen.findByRole("button", { name: "Operator cues" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Operator cues" }));
  expect(screen.getByText("Scheduled rundown")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  fireEvent.click(screen.getByRole("button", { name: "Operator cues" }));
  expect(await screen.findByText("Operator rundown")).toBeVisible();
});
it("gives simulcast timing views within one Rundown", async () => {
  render(
    <MemoryRouter>
      <RundownWorkspace programType="both" />
    </MemoryRouter>,
  );
  expect(await screen.findByText("Scheduled rundown")).toBeVisible();
  fireEvent.click(await screen.findByRole("button", { name: "Operator cues" }));
  expect(await screen.findByText("Operator rundown")).toBeVisible();
  expect(screen.getByRole("button", { name: "Operator cues" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
it("shows the workspace loading state until the program type is known", () => {
  render(
    <MemoryRouter>
      <RundownWorkspace programType={null} />
    </MemoryRouter>,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Opening your workspace…",
  );
  expect(screen.queryByText("Scheduled rundown")).not.toBeInTheDocument();
  expect(screen.queryByText("Operator rundown")).not.toBeInTheDocument();
});

it("offers the recipes beside the operator cues to whoever may read them", async () => {
  permissions = ["alcantara:flight:read"];
  render(
    <MemoryRouter>
      <RundownWorkspace programType="tv" />
    </MemoryRouter>,
  );
  expect(await screen.findByText("Operator rundown")).toBeVisible();
  const tabs = screen.getByRole("navigation", { name: "Operator rundown tabs" });
  expect(within(tabs).getByRole("button", { name: "Cues" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(within(tabs).getByRole("button", { name: "Recipes" }));
  expect(await screen.findByText("Recipes of fixture (read only)")).toBeVisible();
  expect(screen.queryByText("Operator rundown")).toBeNull();
  expect(within(tabs).getByRole("button", { name: "Recipes" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(within(tabs).getByRole("button", { name: "Cues" }));
  expect(await screen.findByText("Operator rundown")).toBeVisible();
});

it("lets whoever may manage flights edit the recipes", async () => {
  permissions = ["alcantara:flight:read", "alcantara:flight:manage"];
  render(
    <MemoryRouter initialEntries={["/flight?tab=recipes"]}>
      <RundownWorkspace programType="tv" />
    </MemoryRouter>,
  );
  expect(await screen.findByText("Recipes of fixture (editable)")).toBeVisible();
});

it("keeps the recipes out of the timed blocks and away from whoever may not read them", async () => {
  permissions = ["alcantara:flight:read"];
  const view = render(
    <MemoryRouter initialEntries={["/flight?tab=recipes"]}>
      <RundownWorkspace programType="radio" />
    </MemoryRouter>,
  );
  expect(await screen.findByText("Scheduled rundown")).toBeVisible();
  expect(screen.queryByRole("navigation", { name: "Operator rundown tabs" })).toBeNull();
  permissions = [];
  view.rerender(
    <MemoryRouter initialEntries={["/flight?tab=recipes"]}>
      <RundownWorkspace programType="tv" />
    </MemoryRouter>,
  );
  expect(await screen.findByText("Operator rundown")).toBeVisible();
  expect(screen.queryByText(/Recipes of/)).toBeNull();
});

it("keeps the view of a simulcast show when switching to the recipes", async () => {
  permissions = ["alcantara:flight:read"];
  render(
    <MemoryRouter initialEntries={["/flight?view=operator"]}>
      <RundownWorkspace programType="both" />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Recipes" }));
  expect(await screen.findByText("Recipes of fixture (read only)")).toBeVisible();
  expect(screen.getByRole("button", { name: "Operator cues" })).toHaveAttribute("aria-pressed", "true");
});
