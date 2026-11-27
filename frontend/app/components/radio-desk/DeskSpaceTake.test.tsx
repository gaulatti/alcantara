import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DeskGuestCue } from "./DeskGuestCue";
import { RadioTransport } from "./RadioTransport";

// gaulatti/alcantara#879: on the radio desk Space is Take. With a song cued in the transport and a guest's live cue
// armed, a Space press on a guest cue button must not take the song, and must not cue the guest either; only the
// second press of the cue button sends it. Fictional names only.

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../services/api", () => ({ authFetch: (...args: unknown[]) => mocks.fetch(...args) }));
vi.mock("../../hooks/useFeatures", () => ({ useFeatures: () => ({ loading: false, hasPermission: () => true }) }));

const next = { itemId: "s2", via: "rotation", title: "Copper Season", artist: "The Paper Hours", durationMs: 241_000 } as const;
const guest = { identity: "guest-a1", name: "Fictional Anna", connectionState: "connected" as const, cueState: "standby" as const };

beforeEach(() => {
  mocks.fetch.mockReset().mockResolvedValue(new Response("{}", { status: 200 }));
  // jsdom has no ResizeObserver; the buttons' tooltips ask for one.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function desk() {
  const onTake = vi.fn(async () => undefined);
  render(
    <>
      <RadioTransport next={next as never} onTake={onTake} onTakeOffAir={vi.fn()} />
      <DeskGuestCue guest={guest} programId="main" onChanged={vi.fn()} />
    </>,
  );
  // Cue the song in the transport (N), so Space would take it.
  fireEvent.keyDown(window, { key: "n" });
  return onTake;
}

it("does not take the cued song when Space lands on an armed guest cue", async () => {
  const onTake = desk();
  fireEvent.click(screen.getByRole("button", { name: "Cue live" }));
  const armed = screen.getByRole("button", { name: "Press again: cue live" });
  armed.focus();
  fireEvent.keyDown(armed, { key: " " });
  expect(onTake).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
  // The second press of the cue button is what sends it.
  fireEvent.click(armed);
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
  expect(onTake).not.toHaveBeenCalled();
});

it("does not take the cued song on a Space press on Standby or the wrap hold", () => {
  const onTake = desk();
  for (const name of ["Standby", /Hold · cue wrap/]) {
    const button = screen.getByRole("button", { name });
    button.focus();
    fireEvent.keyDown(button, { key: " " });
    fireEvent.keyUp(button, { key: " " });
  }
  expect(onTake).not.toHaveBeenCalled();
});

it("still takes the cued song with Space anywhere else on the desk", async () => {
  const onTake = desk();
  fireEvent.keyDown(document.body, { key: " " });
  await waitFor(() => expect(onTake).toHaveBeenCalledTimes(1));
});
