import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChannelPreListen, type PreFadeSource } from "./ChannelPreListen";

// gaulatti/alcantara#835: pre-fade listen of a mixer channel plays the files on air on this device, and sends nothing.

let played: HTMLAudioElement[];
let paused: HTMLAudioElement[];

beforeEach(() => {
  played = [];
  paused = [];
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    played.push(this as HTMLAudioElement);
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    paused.push(this as HTMLAudioElement);
  });
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const song = (name: string, positionMs: number, volume?: number): PreFadeSource => ({
  key: name,
  url: `https://media.test/${name}.mp3`,
  positionMs: () => positionMs,
  volume,
});
const button = () => screen.getByRole("button", { name: "Pre-listen Music" });

function mount(sources: PreFadeSource[]) {
  const onActive = vi.fn();
  const view = render(<ChannelPreListen channel="song" label="Music" sources={sources} onActive={onActive} />);
  const air = (next: PreFadeSource[]) =>
    view.rerender(<ChannelPreListen channel="song" label="Music" sources={next} onActive={onActive} />);
  return { ...view, onActive, air };
}

it("plays what is on air from where air is, follows the next song, and sends nothing", () => {
  const { air, onActive } = mount([song("one", 42_000)]);
  expect(played).toHaveLength(0);
  fireEvent.click(button());
  expect(button()).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("status")).toHaveTextContent("PFL · this device only");
  expect(onActive).toHaveBeenLastCalledWith("song", true);
  expect(played.map((audio) => audio.src)).toEqual(["https://media.test/one.mp3"]);
  expect(played[0].currentTime).toBe(42);

  // A small difference is left alone, so the sound does not stutter; a large one is lined up again.
  air([song("one", 43_000)]);
  expect(played[0].currentTime).toBe(42);
  // The same element moves; jsdom leaves it paused, as a browser does once a file has stopped, so it plays on.
  air([song("one", 60_000)]);
  expect(played[0].currentTime).toBe(60);
  expect(played).toEqual([played[0], played[0]]);

  air([song("two", 500)]);
  expect(paused).toContain(played[0]);
  const next = played.at(-1)!;
  expect(next.src).toBe("https://media.test/two.mp3");

  air([]);
  expect(paused).toContain(next);
  expect(screen.getByRole("status")).toHaveTextContent("PFL · nothing on air here");
  expect(fetch).not.toHaveBeenCalled();
});

it("stops on Escape, a second press, or leaving the desk", () => {
  const view = mount([song("one", 0, 0.5)]);
  fireEvent.click(button());
  expect(played[0].volume).toBe(0.5);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(paused).toContain(played[0]);
  expect(button()).toHaveAttribute("aria-pressed", "false");
  expect(view.onActive).toHaveBeenLastCalledWith("song", false);

  fireEvent.click(button());
  fireEvent.click(button());
  expect(paused).toContain(played[1]);
  expect(screen.queryByRole("status")).toBeNull();

  fireEvent.click(button());
  view.unmount();
  expect(paused).toContain(played[2]);
});

it("says when the audio cannot be played", async () => {
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(new Error("blocked"));
  mount([song("one", 0)]);
  fireEvent.click(button());
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not be played here");
});
