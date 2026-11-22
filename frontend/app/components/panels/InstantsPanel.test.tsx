import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { InstantItem } from "../../models/broadcast";
import { InstantsPanel } from "./InstantsPanel";

// gaulatti/alcantara#184, group G7: the cartwall of instants on the console.

afterEach(cleanup);

const instant = (id: number, name: string, enabled = true): InstantItem => ({
  id,
  name,
  enabled,
  audioUrl: `https://audio.test/${id}.mp3`,
  volume: 1,
  position: id,
});

function cartwall(props: Partial<Parameters<typeof InstantsPanel>[0]> = {}) {
  const onSearchChange = vi.fn();
  const onTrigger = vi.fn();
  render(
    <InstantsPanel
      isLoading={false}
      instants={[]}
      search=""
      playback={{}}
      onSearchChange={onSearchChange}
      onTrigger={onTrigger}
      {...props}
    />,
  );
  return { onSearchChange, onTrigger };
}

it("says when the catalog is loading or empty, and passes searches up", () => {
  const { onSearchChange } = cartwall({ isLoading: true });
  expect(screen.getByText("Loading instants...")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Search cartwall"), {
    target: { value: "app" },
  });
  expect(onSearchChange).toHaveBeenCalledWith("app");
  cleanup();
  cartwall();
  expect(screen.getByText("No instants in catalog.")).toBeInTheDocument();
});

it("plays a cart, numbered and with its Ctrl shortcut, and not a disabled one", () => {
  const { onTrigger } = cartwall({
    instants: [instant(10, "Applause"), instant(11, "Horn", false)],
  });
  const applause = screen.getByRole("button", { name: "Applause" });
  expect(applause).toHaveTextContent("01");
  expect(within(applause).getByText("Ctrl+Q")).toBeInTheDocument();
  fireEvent.click(applause);
  expect(onTrigger).toHaveBeenCalledWith(10);
  const horn = screen.getByRole("button", { name: "Horn" });
  expect(horn).toBeDisabled();
  expect(within(horn).getByText("Ctrl+E")).toBeInTheDocument();
});

it("shows carts past the nineteenth without a shortcut", () => {
  const instants = Array.from({ length: 27 }, (_, index) =>
    instant(index + 1, `Cart ${index + 1}`),
  );
  cartwall({ instants });
  const last = screen.getByRole("button", { name: "Cart 27" });
  expect(last).toHaveTextContent("27");
  expect(last.textContent).not.toMatch(/Ctrl\+/);
  expect(last.querySelector("svg")).not.toBeNull();
  expect(
    within(screen.getByRole("button", { name: "Cart 19" })).getByText("Ctrl+M"),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Cart 20" }).textContent,
  ).not.toMatch(/Ctrl\+/);
});

it("filters by name and keeps each cart's own number and shortcut", () => {
  cartwall({
    instants: [
      instant(1, "Applause"),
      instant(2, "Laugh track"),
      instant(3, "Big laugh"),
    ],
    search: "  LAUGH ",
  });
  expect(screen.queryByRole("button", { name: "Applause" })).toBeNull();
  const big = screen.getByRole("button", { name: "Big laugh" });
  expect(big).toHaveTextContent("03");
  expect(within(big).getByText("Ctrl+Y")).toBeInTheDocument();
  expect(screen.getAllByRole("button")).toHaveLength(2);
  cleanup();
  cartwall({ instants: [instant(1, "Applause")], search: "drum" });
  expect(screen.getByText("No instants match “drum”.")).toBeInTheDocument();
});

it("marks a playing cart, sweeping over its length or pulsing when the length is unknown", () => {
  cartwall({
    instants: [instant(1, "Applause"), instant(2, "Horn"), instant(3, "Drum")],
    playback: {
      1: { startedAtMs: 1000, endsAtMs: 4000 },
      2: { startedAtMs: 1000, endsAtMs: 1050 },
      3: { startedAtMs: 1000, endsAtMs: null },
    },
  });
  const applause = screen.getByRole("button", { name: "Applause · playing" });
  expect(applause).toHaveAttribute("data-playing", "true");
  expect(within(applause).getByText("PLAYING")).toBeInTheDocument();
  const animation = (name: string) =>
    (
      screen
        .getByRole("button", { name })
        .querySelector("[style]") as HTMLElement
    ).style.animation;
  expect(animation("Applause · playing")).toMatch(/ 3000ms linear forwards$/);
  // A very short clip still sweeps for at least 200 ms.
  expect(animation("Horn · playing")).toMatch(/ 200ms linear forwards$/);
  expect(animation("Drum · playing")).toMatch(/ 1400ms ease-in-out infinite$/);
});
