import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, expect, it } from "vitest";
import { MediaLibraryPage } from "./MediaLibraryPage";

// gaulatti/alcantara#404 (MediaLibraryPage, from the full-run table): the library's section tabs. With no limit every
// section is offered; with a limit only those sections are; picking a tab navigates to that section's address.

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

afterEach(() => {
  cleanup();
});

it("offers every section when none is limited, and navigates to the picked section", async () => {
  render(
    <MemoryRouter initialEntries={["/media?type=IMAGE"]}>
      <MediaLibraryPage activeSection="images">
        <Where />
      </MediaLibraryPage>
    </MemoryRouter>,
  );
  for (const label of ["Images", "Audio", "Video", "Labels"]) {
    expect(await screen.findByRole("tab", { name: label })).toBeInTheDocument();
  }
  fireEvent.click(screen.getByRole("tab", { name: "Audio" }));
  expect(screen.getByTestId("where")).toHaveTextContent("/media?type=AUDIO");
});

it("offers only the sections it is limited to", async () => {
  render(
    <MemoryRouter initialEntries={["/media?view=labels"]}>
      <MediaLibraryPage activeSection="labels" visibleSections={["labels", "audio"]}>
        <Where />
      </MediaLibraryPage>
    </MemoryRouter>,
  );
  expect(await screen.findByRole("tab", { name: "Labels" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Audio" })).toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: "Images" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "Video" })).toBeNull();
});

it("places the page's actions beside its heading", async () => {
  render(
    <MemoryRouter initialEntries={["/media?type=IMAGE"]}>
      <MediaLibraryPage activeSection="images" actions={<button type="button">Upload files</button>}>
        <Where />
      </MediaLibraryPage>
    </MemoryRouter>,
  );
  expect(await screen.findByRole("button", { name: "Upload files" })).toBeInTheDocument();
});
