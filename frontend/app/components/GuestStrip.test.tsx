import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuestStrip, type StripParticipant } from "./GuestStrip";
import {
  ARM_TIMEOUT_MS,
  HOLD_MS,
  deskSlots,
  elapsed,
  latestCue,
  stripState,
} from "../utils/callerDesk";

// gaulatti/alcantara#301: one guest as a channel strip, with arm-then-take,
// hold-to-wrap and hold-to-talk timing. Names are fictional.

vi.mock("@gaulatti/bleecker", async (original) => {
  const actual = await original<typeof import("@gaulatti/bleecker")>();
  return {
    ...actual,
    Select: ({ options, onChange, value, ...props }: { options: { value: string; label: string }[]; onChange: (v: string) => void; value: string }) => (
      <select {...props} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
});

const guest = (patch: Partial<StripParticipant> = {}): StripParticipant => ({
  identity: "guest-lucia",
  name: "Lucía Ferrer",
  slotNumber: 1,
  connectionState: "connected",
  returnVideo: "program",
  returnAudioBus: "master",
  sourceGain: 0.8,
  sourceMuted: false,
  sourceDelayMs: 120,
  tracks: [
    { sid: "m", source: "microphone", muted: false },
    { sid: "c", source: "camera", muted: false },
  ],
  commands: [],
  ...patch,
});

function strip(patch: Partial<StripParticipant> = {}, props: Partial<React.ComponentProps<typeof GuestStrip>> = {}) {
  const handlers = {
    onCommand: vi.fn(),
    onReturn: vi.fn(),
    onTalkStart: vi.fn(),
    onTalkStop: vi.fn(),
    onReplace: vi.fn(),
    onRemove: vi.fn(),
    onRevoke: vi.fn(),
    onDraftChange: vi.fn(),
  };
  const view = render(
    <GuestStrip
      participant={guest(patch)}
      expiresAt="2026-11-23T12:00:00Z"
      canOperate
      busy={false}
      talking={false}
      draft=""
      {...handlers}
      {...props}
    />,
  );
  return { ...handlers, view, card: screen.getByRole("article") };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("caller desk helpers", () => {
  it("reads the newest cue and ignores other commands and unknown cues", () => {
    expect(latestCue([])).toBeNull();
    expect(
      latestCue([
        { type: "message", payload: {} },
        { type: "cue", payload: { cue: "wrap" } },
        { type: "cue", payload: { cue: "live" } },
      ]),
    ).toBe("wrap");
    expect(latestCue([{ type: "cue", payload: { cue: "loud" } }])).toBeNull();
  });
  it("names a strip from its connection and cue, never claiming the output", () => {
    expect(stripState("connected", "live")).toBe("cued-live");
    expect(stripState("connected", "standby")).toBe("connected");
    expect(stripState("connected", null)).toBe("connected");
    expect(stripState("reconnecting", "live")).toBe("reconnecting");
    expect(stripState("offline", null)).toBe("offline");
  });
  it("lays out six slots, matching guests to invitations by id", () => {
    const slots = deskSlots(
      [
        { id: "a", slotNumber: 1, status: "active" },
        { id: "old", slotNumber: 2, status: "revoked" },
        { id: "c", slotNumber: 3, status: "available" },
      ],
      [
        { invitationId: "a", slotNumber: 1 },
        { invitationId: "ghost", slotNumber: 3 },
      ],
    );
    expect(slots).toHaveLength(6);
    expect(slots.map((slot) => [slot.slot, slot.invitation?.id ?? null, slot.participant?.invitationId ?? null])).toEqual([
      [1, "a", "a"],
      [2, null, null],
      [3, "c", null],
      [4, null, null],
      [5, null, null],
      [6, null, null],
    ]);
  });
  it("formats an elapsed time", () => {
    const now = Date.parse("2026-11-22T12:02:41Z");
    expect(elapsed("2026-11-22T12:00:00Z", now)).toBe("2:41");
    expect(elapsed("2026-11-22T12:05:00Z", now)).toBe("0:00");
    expect(elapsed(null, now)).toBe("—");
    expect(elapsed("not a date", now)).toBe("—");
  });
});

describe("GuestStrip", () => {
  it("shows what is not measured yet, and a connected guest's controls", () => {
    const { card } = strip();
    expect(card).toHaveAttribute("data-state", "connected");
    expect(within(card).getByText("Live")).toBeVisible();
    expect(within(card).getByText("Meter not measured yet")).toBeVisible();
    expect(within(card).getByText("Cue · none sent")).toBeVisible();
    expect(within(card).queryByRole("checkbox")).toBeNull();
  });

  it("keeps the cue-live and wrap buttons the same width when cue live is armed", () => {
    const { card } = strip();
    const cueLive = () => within(card).getByRole("button", { name: /Cue live|Press again or Space/ });
    const wrap = () => within(card).getByRole("button", { name: /Hold · cue wrap/ });
    // The colour changes when armed; the width and the no-wrap do not.
    expect(cueLive().className).toContain("min-w-[13rem] whitespace-nowrap");
    expect(wrap().className).toContain("whitespace-nowrap");
    fireEvent.click(cueLive());
    expect(cueLive().className).toContain("min-w-[13rem] whitespace-nowrap");
    expect(wrap().className).toContain("whitespace-nowrap");
  });

  it("disarms the live cue after a while, and sends it with Space while armed", () => {
    const { card, onCommand } = strip();
    fireEvent.click(within(card).getByRole("button", { name: "Cue live" }));
    expect(within(card).getByRole("button", { name: /Press again or Space/ })).toHaveAttribute("aria-pressed", "true");
    act(() => {
      vi.advanceTimersByTime(ARM_TIMEOUT_MS);
    });
    expect(within(card).getByRole("button", { name: "Cue live" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.keyDown(card, { key: " " });
    expect(onCommand).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole("button", { name: "Cue live" }));
    fireEvent.keyDown(card, { key: " " });
    expect(onCommand).toHaveBeenCalledWith({ type: "cue", cue: "live" });
  });

  it("sends the wrap cue only after a full hold, by pointer or by Enter or Space", () => {
    const { card, onCommand } = strip();
    const wrap = within(card).getByRole("button", { name: /Hold · cue wrap/ });
    fireEvent.pointerDown(wrap);
    expect(wrap).toHaveTextContent("Keep holding…");
    fireEvent.pointerDown(wrap);
    act(() => {
      vi.advanceTimersByTime(HOLD_MS - 1);
    });
    fireEvent.pointerLeave(wrap);
    act(() => {
      vi.advanceTimersByTime(HOLD_MS);
    });
    expect(onCommand).not.toHaveBeenCalled();
    fireEvent.keyDown(wrap, { key: "Enter" });
    fireEvent.keyDown(wrap, { key: "Enter", repeat: true });
    act(() => {
      vi.advanceTimersByTime(HOLD_MS);
    });
    expect(onCommand).toHaveBeenCalledWith({ type: "cue", cue: "wrap" });
    fireEvent.keyUp(wrap, { key: "Enter" });
    fireEvent.keyDown(wrap, { key: " " });
    fireEvent.keyUp(wrap, { key: " " });
    fireEvent.keyDown(wrap, { key: "a" });
    fireEvent.keyUp(wrap, { key: "a" });
    act(() => {
      vi.advanceTimersByTime(HOLD_MS);
    });
    expect(onCommand).toHaveBeenCalledTimes(1);
  });

  it("talks while T is held in the strip, but not from a field, and stops when focus leaves", () => {
    const { card, onTalkStart, onTalkStop } = strip({}, { draft: "x" });
    fireEvent.keyDown(within(card).getByLabelText("Message Lucía Ferrer"), { key: "t" });
    expect(onTalkStart).not.toHaveBeenCalled();
    fireEvent.keyDown(card, { key: "T" });
    fireEvent.keyDown(card, { key: "t", repeat: true });
    expect(onTalkStart).toHaveBeenCalledTimes(1);
    fireEvent.blur(card, { relatedTarget: null });
    expect(onTalkStop).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(card, { key: "t" });
    expect(onTalkStop).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(card, { key: "t" });
    fireEvent.blur(card, { relatedTarget: within(card).getByRole("button", { name: "Standby" }) });
    expect(onTalkStop).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(card, { key: "x" });
    fireEvent.keyUp(card, { key: "T" });
    expect(onTalkStop).toHaveBeenCalledTimes(2);
  });

  it("names a talking strip and sends the routing, media and message actions", () => {
    const { card, onReturn, onCommand, onReplace, onRemove, onRevoke, onDraftChange } = strip(
      { tracks: [{ sid: "m", source: "microphone", muted: true }, { sid: "c", source: "camera", muted: true }], sourceMuted: true },
      { talking: true, draft: "On in 10" },
    );
    expect(within(card).getByRole("button", { name: /Talking… release to stop/ })).toBeEnabled();
    fireEvent.click(within(card).getByRole("button", { name: /Muted in returns/ }));
    expect(onReturn).toHaveBeenCalledWith("sourceMuted", false);
    fireEvent.click(within(card).getByRole("button", { name: /Request mic/ }));
    fireEvent.click(within(card).getByRole("button", { name: /Request camera/ }));
    expect(onCommand).toHaveBeenCalledWith({ type: "media", device: "microphone", enabled: true });
    expect(onCommand).toHaveBeenCalledWith({ type: "media", device: "camera", enabled: true });
    // Muting asks first, in plain words (see the coverage file).
    fireEvent.change(within(card).getByLabelText("Message Lucía Ferrer"), { target: { value: "Now" } });
    expect(onDraftChange).toHaveBeenCalledWith("Now");
    fireEvent.click(within(card).getByRole("button", { name: "Send message to Lucía Ferrer" }));
    expect(onCommand).toHaveBeenCalledWith({ type: "message", text: "On in 10" });
    fireEvent.click(within(card).getByRole("button", { name: /Remove session/ }));
    fireEvent.click(within(card).getByRole("button", { name: "Remove from call" }));
    expect(onRemove).toHaveBeenCalled();
    for (const [name, handler] of [[/Replace link/, onReplace], [/Revoke/, onRevoke]] as const) {
      fireEvent.click(within(card).getByRole("button", { name }));
      expect(handler).toHaveBeenCalled();
    }
  });

  it("marks a reconnecting guest amber and keeps cue and talk closed", () => {
    const { card } = strip({ connectionState: "reconnecting" });
    expect(card).toHaveAttribute("data-state", "reconnecting");
    expect(within(card).getByRole("button", { name: "Cue live" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: /Hold · talk/ })).toBeDisabled();
  });
});

// gaulatti/alcantara#875: the cue line follows the cue that holds, and the cue buttons never move under a finger.
describe("the cue line", () => {
  const live = [{ type: "cue", payload: { cue: "live" }, status: "delivered" }];
  const line = (card: HTMLElement) => card.querySelector(".guest-strip-cue")!.textContent;

  it("reads the stored state over the command history", () => {
    expect(line(strip({ commands: live, cueState: "rejoined" }).card)).toBe("Off air · rejoined, cue again");
    cleanup();
    expect(line(strip({ commands: [], cueState: "live" }).card)).toBe("Cue · live");
    cleanup();
    expect(line(strip({ commands: live, cueState: "wrap" }).card)).toBe("Cue · wrap sent");
    cleanup();
    expect(line(strip({ commands: live, cueState: null }).card)).toBe("Cue · none sent");
    cleanup();
    // A backend that does not send it yet: the history.
    expect(line(strip({ commands: live }).card)).toBe("Cue · live");
  });

  it("keeps the cue buttons above everything that comes and goes", () => {
    const { card } = strip({ returnReaching: "healthy", cueState: "live" });
    const button = within(card).getByRole("button", { name: "Standby" });
    for (const later of [".call-path", ".guest-strip-status", ".guest-strip-av"]) {
      const element = card.querySelector(later);
      if (element) expect(button.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(card.querySelector(".guest-strip-status")).toHaveTextContent("Hears the studio");
    expect(card.querySelector(".guest-strip-head")!.nextElementSibling).toContainElement(button);
  });

  it("keeps the status line's place when there is nothing to say", () => {
    expect(strip().card.querySelector(".guest-strip-status")).toBeEmptyDOMElement();
  });
});
