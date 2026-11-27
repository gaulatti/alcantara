import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RadioMonitorProvider, useRadioMonitor } from "./RadioMonitor";
import { RadioOutputPlayer } from "./RadioOutputPlayer";

// gaulatti/alcantara#879: with Mic on air on the desk beside Listen, speakers playing the broadcast into an open
// microphone would feed back to air. The monitor is muted while the microphone is open.
const mic = vi.hoisted(() => ({ value: { state: "off" as "off" | "starting" | "on" } }));
vi.mock("./HostMicOnAir", () => ({ useHostMic: () => mic.value }));

afterEach(() => {
  cleanup();
  mic.value = { state: "off" };
  vi.unstubAllGlobals();
});

let preListening!: (active: boolean) => void;
function Probe() {
  preListening = useRadioMonitor()!.setPreListening;
  return null;
}
const desk = () => (
  <RadioMonitorProvider programId="radio one">
    <Probe />
    <RadioOutputPlayer programId="radio one" />
  </RadioMonitorProvider>
);

it("mutes Listen from the press until the microphone is off, and says why", () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  const view = render(desk());
  const monitor = () => view.container.querySelector("audio")!;
  expect(monitor().muted).toBe(false);
  for (const state of ["starting", "on"] as const) {
    mic.value = { state };
    view.rerender(desk());
    expect(monitor().muted).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("Muted while your mic is live");
  }
  // A pre-listen ending must not open the speakers into a live microphone.
  act(() => preListening(true));
  act(() => preListening(false));
  expect(monitor().muted).toBe(true);
  mic.value = { state: "off" };
  view.rerender(desk());
  expect(monitor().muted).toBe(false);
  expect(screen.getByRole("status")).not.toHaveTextContent("Muted while your mic is live");
});

it("stays muted for a pre-listen when the microphone goes off during it", () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  mic.value = { state: "on" };
  const view = render(desk());
  act(() => preListening(true));
  mic.value = { state: "off" };
  view.rerender(desk());
  expect(view.container.querySelector("audio")!.muted).toBe(true);
});
