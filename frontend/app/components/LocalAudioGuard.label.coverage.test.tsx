import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HeadphonesToggle } from "./LocalAudioGuard";
import { resetLocalAudio } from "../utils/localAudio";

// The calls status bar's headphone toggle reads as its own label, and changing it sets headphone monitoring.

vi.mock("./HostMicOnAir", () => ({ useHostMic: () => ({ state: "off" }) }));

afterEach(() => {
  cleanup();
  resetLocalAudio();
});

it("reads as the label it is given, and sets headphone monitoring when changed", () => {
  render(<HeadphonesToggle label="Headphones" />);
  const box = screen.getByRole("checkbox", { name: "Headphones" }) as HTMLInputElement;
  expect(box.checked).toBe(false);
  fireEvent.click(box);
  expect(box.checked).toBe(true);
  fireEvent.click(box);
  expect(box.checked).toBe(false);
});
