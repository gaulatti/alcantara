import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HeadphonesToggle, LocalAudioGuard } from "./LocalAudioGuard";
import { usePreListen } from "./radio-desk/usePreListen";
import { resetLocalAudio } from "../utils/localAudio";

const mic = vi.hoisted(() => ({ value: { state: "off" as "off" | "starting" | "on" } }));
vi.mock("./HostMicOnAir", () => ({ useHostMic: () => mic.value }));

const made: HTMLAudioElement[] = [];
class FakeAudio {
  muted = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    made.push(this as unknown as HTMLAudioElement);
  }
  play() {
    return Promise.resolve();
  }
  pause() {}
}

afterEach(() => {
  cleanup();
  resetLocalAudio();
  window.localStorage.clear();
  made.length = 0;
  mic.value = { state: "off" };
  vi.unstubAllGlobals();
});

function Pad() {
  const { toggle } = usePreListen();
  return <button onClick={() => toggle({ id: 1, name: "Sting", audioUrl: "/sting.mp3" })}>Pre-listen</button>;
}
const desk = () => (
  <>
    <LocalAudioGuard />
    <HeadphonesToggle />
    <Pad />
  </>
);

it("mutes a sounder pre-listen while the mic is live, until the operator says headphones", () => {
  vi.stubGlobal("Audio", FakeAudio);
  mic.value = { state: "on" };
  render(desk());
  fireEvent.click(screen.getByRole("button", { name: "Pre-listen" }));
  expect(made[0].muted).toBe(true);
  const toggle = screen.getByRole("checkbox", { name: "I'm on headphones: keep pre-fade" });
  expect(toggle).not.toBeChecked();
  act(() => void fireEvent.click(toggle));
  expect(toggle).toBeChecked();
  expect(made[0].muted).toBe(false);
  expect(window.localStorage.getItem("alcantara.preFadeOnHeadphones")).toBe("yes");
});

it("leaves a pre-listen audible with the mic off, and mutes it when the mic is pressed", () => {
  vi.stubGlobal("Audio", FakeAudio);
  const view = render(desk());
  fireEvent.click(screen.getByRole("button", { name: "Pre-listen" }));
  expect(made[0].muted).toBe(false);
  mic.value = { state: "starting" };
  view.rerender(desk());
  expect(made[0].muted).toBe(true);
});
