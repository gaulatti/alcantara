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
import Overlay from "./overlay";
import SlideshowFixture from "./slideshow-fixture";
import FillerFixture from "./filler-fixture";
import SimilarityFixture from "./similarity-fixture";
import BroadcastLayoutExample from "./layout-demo";
import SongIntroFixture from "./song-intro-fixture";
import MediaFixture from "./media-fixture";
import RecordingFixture from "./recording-fixture";
import AccessFixture from "./access-fixture";

// The visual fixture routes: each opens its fictional states with the real
// components, as a reviewer sees them.

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows the broadcast overlay's welcome chyron", () => {
  render(<Overlay />);
  expect(screen.getByText("Bienvenidos a Modoradio")).toBeInTheDocument();
});

it("shows the slideshow fixture frames", () => {
  const { container } = render(<SlideshowFixture />);
  expect(
    container.querySelector('[data-visual-fixture="slideshow-preload"]'),
  ).toBeInTheDocument();
});

it("shows both filler legs with their media names", () => {
  render(<FillerFixture />);
  expect(screen.getByRole("heading", { name: "Program filler" })).toBeVisible();
  expect(
    screen.getByRole("region", { name: "Television filler" }),
  ).toBeVisible();
  expect(screen.getByRole("region", { name: "Radio filler" })).toBeVisible();
});

it("shows every song-similarity state", () => {
  render(<SimilarityFixture />);
  for (const label of [
    "Off, nothing analyzed",
    "Shadow with decisions",
    "On, whole-catalog fallback",
    "Upload rejected",
  ]) {
    expect(screen.getByText(label)).toBeVisible();
  }
  expect(
    screen.getByText("opening: vector must have 1280 dimensions"),
  ).toBeInTheDocument();
});

it("shows chyron messages on demand in the layout demo", async () => {
  render(<BroadcastLayoutExample />);
  expect(screen.getByText("Broadcast Layout Demo")).toBeVisible();
  for (const [button, text] of [
    ["Show Title Message", "LAS INTROS DEL FESTIVAL DE SANREMO"],
    ["Show Now Playing", "Ahora suena: Beautiful Song - Amazing Artist"],
    ["Show Breaking News", "ULTIMA HORA: Noticia importante en desarrollo"],
  ]) {
    fireEvent.click(screen.getByRole("button", { name: button }));
    expect(await screen.findByText(text)).toBeInTheDocument();
  }
  fireEvent.click(screen.getByRole("button", { name: "Hide Chyron" }));
  await waitFor(() =>
    expect(
      screen.queryByText("ULTIMA HORA: Noticia importante en desarrollo"),
    ).not.toBeInTheDocument(),
  );
});

it("contains the layout demo's 1920x1080 stage in a frame, so its fixed widgets cannot cover the sidebar", () => {
  render(<BroadcastLayoutExample />);
  const frame = screen.getByTestId("layout-demo-frame");
  const stage = screen.getByTestId("layout-demo-stage");
  // The frame clips the stage, and the stage's transform makes the frame the containing block
  // of the position:fixed QR widget.
  expect(frame).toHaveClass("overflow-hidden", "w-full");
  expect(stage.style.transform).toMatch(/^scale\(/);
  expect(stage.style.width).toBe("1920px");
  expect(stage.style.height).toBe("1080px");
  expect(frame.contains(document.querySelector(".qr-widget"))).toBe(true);
  expect(frame.contains(screen.getByText("Broadcast Layout Demo"))).toBe(true);
});

it("shows every song-intro editor state", () => {
  render(<SongIntroFixture />);
  for (const label of [
    "Unassigned",
    "Assigned",
    "Previewing",
    "Validation error",
    "Removal",
  ]) {
    expect(screen.getByText(label)).toBeVisible();
  }
  expect(
    screen.getByText("Instant is already assigned as a song intro"),
  ).toBeInTheDocument();
});

it("shows the radio media surface with capabilities and labels", () => {
  render(
    <MemoryRouter>
      <MediaFixture />
    </MemoryRouter>,
  );
  const opener = screen.getByText("Morning opener").closest("article")!;
  expect(within(opener).getByText("Instant")).toBeVisible();
  expect(within(opener).getByText("Station IDs")).toBeVisible();
  const bed = screen.getByText("Weather bed").closest("article")!;
  expect(within(bed).getByText("Unlabeled")).toBeVisible();
});

it.each([
  ["active", "active"],
  ["complete", "complete"],
  ["finalizing", "finalizing"],
  ["failed", "failed"],
  ["disabled", "disabled"],
  ["nonsense", "active"],
])("opens the recording fixture in the %s state", (requested, shown) => {
  const { container } = render(
    <MemoryRouter initialEntries={[`/fixture?state=${requested}`]}>
      <RecordingFixture />
    </MemoryRouter>,
  );
  expect(
    container.querySelector(`[data-visual-fixture="${shown}"]`),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Program recording" }),
  ).toBeVisible();
});

it("opens the recording fixture as active without a state", () => {
  const { container } = render(
    <MemoryRouter initialEntries={["/fixture"]}>
      <RecordingFixture />
    </MemoryRouter>,
  );
  expect(
    container.querySelector('[data-visual-fixture="active"]'),
  ).toBeInTheDocument();
});

it.each([
  ["manager", ["My tokens", "Token switch", "People", "History"]],
  ["member", ["My tokens", "History"]],
])("opens the access fixture as a %s", async (state, tabs) => {
  render(
    <MemoryRouter initialEntries={[`/access-fixture?state=${state}`]}>
      <AccessFixture />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(
      tabs,
    ),
  );
  expect(screen.getByText("Studio laptop")).toBeInTheDocument();
});

it("opens the access fixture with the service not available yet, and a manager by default", async () => {
  const { unmount } = render(
    <MemoryRouter initialEntries={["/access-fixture?state=unavailable"]}>
      <AccessFixture />
    </MemoryRouter>,
  );
  expect(
    await screen.findByText("Access is not available yet"),
  ).toBeInTheDocument();
  unmount();
  render(
    <MemoryRouter initialEntries={["/access-fixture?state=nonsense"]}>
      <AccessFixture />
    </MemoryRouter>,
  );
  expect(await screen.findByRole("tab", { name: "People" })).toBeInTheDocument();
});
