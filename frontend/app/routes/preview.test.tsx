import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Preview from "./preview";
import { OVERLAY_COMPONENTS } from "../models/components";

// The component preview page: one button per overlay component, each opening
// its own stage. The overlay components are owned by their own tickets, so
// they are stand-ins that show the props the page gives them.

vi.mock("../components", () => {
  const show = (name: string) => (props: Record<string, unknown>) => (
    <div data-testid={name}>
      {name} {JSON.stringify(props)}
    </div>
  );
  return {
    BroadcastLayout: show("BroadcastLayout"),
    ChyronHolder: show("ChyronHolder"),
    ClockWidget: show("ClockWidget"),
    Header: show("Header"),
    LiveIndicator: show("LiveIndicator"),
    QRCodeWidget: show("QRCodeWidget"),
    Ticker: show("Ticker"),
    RelojLoopClock: show("RelojLoopClock"),
    RelojDigitalLoopClock: show("RelojDigitalLoopClock"),
    RelojClone: show("RelojClone"),
    ModoItalianoGiorgiaClock: show("ModoItalianoGiorgiaClock"),
    ModoItalianoGiorgiaChyron: show("ModoItalianoGiorgiaChyron"),
    ModoItalianoGiorgiaPodcastPlayer: show("ModoItalianoGiorgiaPodcastPlayer"),
    ModoItalianoGiorgiaArtistBumper: show("ModoItalianoGiorgiaArtistBumper"),
  };
});

let resize: ResizeObserverCallback | null = null;
const disconnect = vi.fn();

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resize = null;
});

const open = (id: string) => {
  const name = OVERLAY_COMPONENTS.find(
    (component) => component.id === id,
  )!.name;
  fireEvent.click(screen.getByText(name, { selector: "p" }).closest("button")!);
};

it("lists every overlay component and opens the ticker first", () => {
  render(<Preview />);
  for (const component of OVERLAY_COMPONENTS) {
    expect(screen.getByText(component.description!)).toBeInTheDocument();
  }
  expect(screen.getByText("Ticker Preview")).toBeVisible();
  expect(screen.getByTestId("Ticker")).toHaveTextContent(
    '"hashtag":"#ProgramHashtag"',
  );
});

it.each([
  ["clock-widget", "Clock Widget Preview", "ClockWidget"],
  ["qr-code", "QR Code Widget Preview", "QRCodeWidget"],
  ["live-indicator", "Live Indicator Preview", "LiveIndicator"],
  ["header", "Header Component Preview", "Header"],
])("previews the %s widget on its stage", (id, caption, testId) => {
  render(<Preview />);
  open(id);
  expect(screen.getByText(caption)).toBeVisible();
  expect(screen.getByTestId(testId)).toBeInTheDocument();
});

it.each([
  ["reloj-loop-clock", "RelojLoopClock"],
  ["reloj-clone", "RelojClone"],
  ["modoitaliano-giorgia-clock", "ModoItalianoGiorgiaClock"],
  ["modoitaliano-giorgia-chyron", "ModoItalianoGiorgiaChyron"],
])("previews %s", (id, testId) => {
  render(<Preview />);
  open(id);
  expect(screen.getByTestId(testId)).toBeInTheDocument();
});

it("previews the digital loop clock with its catalog defaults", () => {
  render(<Preview />);
  open("reloj-digital-loop-clock");
  const defaults = OVERLAY_COMPONENTS.find(
    (component) => component.id === "reloj-digital-loop-clock",
  )!.defaultProps!;
  expect(screen.getByTestId("RelojDigitalLoopClock")).toHaveTextContent(
    `"timezone":${JSON.stringify(defaults.timezone)}`,
  );
});

it("scales the full-frame podcast player and bumper to the preview width", () => {
  render(<Preview />);
  open("modoitaliano-giorgia-podcast-player");
  const stage = () =>
    screen.getByTestId("ModoItalianoGiorgiaPodcastPlayer").parentElement!;
  expect(stage().style.transform).toBe("scale(1)");
  // The preview area is measured; an empty measurement changes nothing.
  act(() => resize?.([], {} as ResizeObserver));
  expect(stage().style.transform).toBe("scale(1)");
  act(() =>
    resize?.(
      [{ contentRect: { width: 960 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    ),
  );
  expect(stage().style.transform).toBe("scale(0.5)");

  open("modoitaliano-giorgia-artist-bumper");
  expect(
    screen.getByTestId("ModoItalianoGiorgiaArtistBumper").parentElement!.style
      .transform,
  ).toBe("scale(0.5)");
  expect(
    screen.getByTestId("ModoItalianoGiorgiaArtistBumper"),
  ).toHaveTextContent('"artist":"Giorgia"');
});

it("edits and toggles the chyron, and hides it when switching component", () => {
  render(<Preview />);
  open("chyron");
  const input = screen.getByPlaceholderText("Enter chyron text");
  expect(input).toHaveValue("LAS INTROS DEL FESTIVAL DE SANREMO");
  fireEvent.change(input, { target: { value: "Ultima ora" } });
  expect(screen.getByTestId("ChyronHolder")).toHaveTextContent('"show":false');
  fireEvent.click(screen.getByText("Show Chyron").closest("button")!);
  expect(screen.getByTestId("ChyronHolder")).toHaveTextContent(
    '{"text":"Ultima ora","show":true}',
  );
  fireEvent.click(screen.getByText("Hide Chyron").closest("button")!);
  fireEvent.click(screen.getByText("Show Chyron").closest("button")!);
  open("ticker");
  open("chyron");
  expect(screen.getByTestId("ChyronHolder")).toHaveTextContent('"show":false');
});

it("explains components that have no preview here", () => {
  render(<Preview />);
  open("logo-widget");
  expect(screen.getByText("Select a component to preview")).toBeVisible();
});

it("goes back to the control panel", () => {
  const location = { href: "/preview" };
  vi.stubGlobal("location", location);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: location,
  });
  render(<Preview />);
  fireEvent.click(screen.getByText("Back to Control Panel").closest("button")!);
  expect(location.href).toBe("/");
});

it("stops measuring when the page closes", () => {
  const view = render(<Preview />);
  view.unmount();
  expect(disconnect).toHaveBeenCalled();
});
