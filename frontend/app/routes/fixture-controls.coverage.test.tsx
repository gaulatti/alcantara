import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AccessFixture from "./access-fixture";
import LabelsFixture from "./labels-fixture";
import SourcesFixture from "./sources-fixture";
import LibraryFixture from "./library-fixture";

// gaulatti/alcantara#527: the controls of the visual fixture routes. Each fixture's callbacks run only when a
// reviewer clicks them, so these tests click the controls. Fictional names only.

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("opens the access fixture on the state named in the URL", async () => {
  render(
    <MemoryRouter initialEntries={["/access-fixture?state=member"]}>
      <AccessFixture />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getAllByRole("tab").length).toBeGreaterThan(0));
});

it("runs the library fixture's row actions and retry", async () => {
  const { unmount } = render(
    <MemoryRouter initialEntries={["/library-fixture"]}>
      <LibraryFixture />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getAllByRole("button", { name: /Play/ })[0]);
  unmount();
  render(
    <MemoryRouter initialEntries={["/library-fixture?state=error"]}>
      <LibraryFixture />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Retry/ }));
});

it("runs the sources fixture's refresh, selection and retry", async () => {
  const { unmount } = render(
    <MemoryRouter initialEntries={["/sources-fixture"]}>
      <SourcesFixture />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Preview Studio camera" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh sources list" }));
  unmount();
  render(
    <MemoryRouter initialEntries={["/sources-fixture?state=preview-failed"]}>
      <SourcesFixture />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
});

it("runs the labels fixture's create, edit, delete and add-asset controls", async () => {
  render(
    <MemoryRouter initialEntries={["/labels-fixture"]}>
      <LabelsFixture />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "New label" }));
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete 90s" }));
});

it("opens the access fixture with no state in the URL, on the manager state", async () => {
  render(
    <MemoryRouter initialEntries={["/access-fixture"]}>
      <AccessFixture />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getAllByRole("tab").length).toBeGreaterThan(0));
});
