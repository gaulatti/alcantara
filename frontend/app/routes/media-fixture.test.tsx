import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import MediaFixture from "./media-fixture";

// gaulatti/alcantara#404 (media fixture page, outside the #404 list): the visual fixture of the media library renders its
// examples, and its search narrows them.

vi.mock("@gaulatti/bleecker", async (original) => {
  const kit = await import("../../test/routeKit");
  return kit.nativeSelect(original as () => Promise<typeof import("@gaulatti/bleecker")>);
});

afterEach(cleanup);

it("renders the media library fixture, and its search narrows the examples", () => {
  render(
    <MemoryRouter>
      <MediaFixture />
    </MemoryRouter>,
  );
  const table = within(screen.getByRole("table"));
  expect(table.getByText("Harbor Lights", { selector: "p" })).toBeInTheDocument();
  expect(table.getByText("Northbound", { selector: "p" })).toBeInTheDocument();
  const search = screen.getByPlaceholderText("Search audio media…");
  fireEvent.change(search, { target: { value: "harbor" } });
  expect(table.getByText("Harbor Lights", { selector: "p" })).toBeInTheDocument();
  expect(table.queryByText("Northbound", { selector: "p" })).toBeNull();
});

it("selects and deselects a row of the fixture's library", () => {
  render(
    <MemoryRouter>
      <MediaFixture />
    </MemoryRouter>,
  );
  const box = screen.getByRole("checkbox", { name: "Select Harbor Lights" });
  fireEvent.click(box);
  expect(box).toBeChecked();
  fireEvent.click(box);
  expect(box).not.toBeChecked();
});

it("narrows the fixture's library to a capability", () => {
  render(
    <MemoryRouter>
      <MediaFixture />
    </MemoryRouter>,
  );
  fireEvent.click(
    within(screen.getByRole("group", { name: "Capability" })).getByRole("button", { name: "Instant" }),
  );
  const table = within(screen.getByRole("table"));
  expect(table.getByText("Morning opener", { selector: "p" })).toBeInTheDocument();
  expect(table.queryByText("Harbor Lights", { selector: "p" })).toBeNull();
});
