import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InstantsPanel } from "../panels";
import { usePreListen } from "./usePreListen";

// gaulatti/alcantara#835: pre-listen plays a sounder on this device and never fires its pad.

type Fake = { src: string; paused: boolean; onended?: () => void; onerror?: () => void };
let players: Fake[];
let refuse: boolean;

beforeEach(() => {
  players = [];
  refuse = false;
  vi.stubGlobal(
    "Audio",
    class {
      paused = false;
      onended?: () => void;
      onerror?: () => void;
      constructor(public src: string) {
        players.push(this);
      }
      play() {
        return refuse ? Promise.reject(new Error("blocked")) : Promise.resolve();
      }
      pause() {
        this.paused = true;
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const instants = [1, 2].map((id) => ({ id, name: `Sting ${id}`, audioUrl: `/sting-${id}.mp3`, volume: 1, enabled: true, position: id }));
const trigger = vi.fn();
const active = vi.fn();

function Desk() {
  const preListen = usePreListen(active);
  return (
    <>
      <output>{preListen.playing?.name ?? "off"}</output>
      <p>{preListen.error}</p>
      <InstantsPanel
        isLoading={false}
        instants={instants}
        search=""
        playback={{}}
        onSearchChange={() => {}}
        onTrigger={trigger}
        preListen={{ activeId: preListen.playing?.id ?? null, onToggle: preListen.toggle }}
      />
    </>
  );
}
const button = (n: number) => screen.getByRole("button", { name: `Pre-listen Sting ${n}` });
const now = () => screen.getByRole("status").textContent;

it("plays one sounder here at a time and never triggers its pad", () => {
  render(<Desk />);
  fireEvent.click(button(1));
  expect(players[0].src).toBe("/sting-1.mp3");
  expect(button(1)).toHaveAttribute("aria-pressed", "true");
  expect(active).toHaveBeenLastCalledWith(true);
  fireEvent.click(button(2));
  expect(players[0].paused).toBe(true);
  expect(now()).toBe("Sting 2");
  fireEvent.click(button(2));
  expect(players[1].paused).toBe(true);
  expect(now()).toBe("off");
  expect(active).toHaveBeenLastCalledWith(false);
  expect(trigger).not.toHaveBeenCalled();
});

it("stops on Esc, at the end of the file and when the desk is left", () => {
  const view = render(<Desk />);
  fireEvent.click(button(1));
  fireEvent.keyDown(window, { key: "a" });
  expect(now()).toBe("Sting 1");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(now()).toBe("off");
  fireEvent.click(button(1));
  act(() => players[1].onended!());
  expect(now()).toBe("off");
  // A file already replaced cannot end the one now playing.
  fireEvent.click(button(2));
  act(() => players[1].onended!());
  expect(now()).toBe("Sting 2");
  view.unmount();
  expect(players[2].paused).toBe(true);
  expect(active).toHaveBeenLastCalledWith(false);
});

it("says when a file cannot be played", async () => {
  render(<Desk />);
  fireEvent.click(button(1));
  act(() => players[0].onerror!());
  expect(screen.getByText("Sting 1 could not be played here.")).toBeVisible();
  refuse = true;
  await act(async () => fireEvent.click(button(2)));
  expect(screen.getByText("Sting 2 could not be played here.")).toBeVisible();
  expect(now()).toBe("off");
});
