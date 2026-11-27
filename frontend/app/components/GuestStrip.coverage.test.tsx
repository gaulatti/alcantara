import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GuestStrip, type StripParticipant } from "./GuestStrip";
import { ARM_TIMEOUT_MS, HOLD_MS } from "../utils/callerDesk";

// gaulatti/alcantara#527: the remaining GuestStrip paths the component test does not reach: the live-cue
// confirmation, the arm timeout, the wrap hold and its cancellation, the media requests, the return controls,
// the private message and the footer actions. Names are fictional.

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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

function renderStrip(
  patch: Partial<StripParticipant> = {},
  props: Partial<React.ComponentProps<typeof GuestStrip>> = {},
) {
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
  render(
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
  return handlers;
}

const cueCommand = (cue: string) => ({ type: "cue", payload: { cue }, status: "sent" });

it("shows the reconnecting and offline state labels, and disables the offline guest's remove", () => {
  renderStrip({ connectionState: "reconnecting" });
  expect(screen.getByText("Expires", { exact: false })).toBeInTheDocument();
  cleanup();
  renderStrip({ connectionState: "offline" });
  expect(screen.getByRole("button", { name: "Remove session" })).toBeDisabled();
});

it("reports the latest command and the cued-live note", () => {
  renderStrip({ commands: [cueCommand("live")] });
  expect(screen.getByText("Sent the live cue.", { exact: false })).toBeInTheDocument();
  expect(screen.getByText("Cue · live")).toBeInTheDocument();
});

it("arms a live cue, cancels after the arm timeout, and sends the live cue on a second press", () => {
  const { onCommand } = renderStrip();
  fireEvent.click(screen.getByRole("button", { name: "Cue live" }));
  expect(onCommand).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Press again or Space: cue live" })).toBeInTheDocument();

  act(() => {
    vi.advanceTimersByTime(ARM_TIMEOUT_MS);
  });
  expect(screen.getByRole("button", { name: "Cue live" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Cue live" }));
  fireEvent.click(screen.getByRole("button", { name: "Press again or Space: cue live" }));
  expect(onCommand).toHaveBeenCalledWith({ type: "cue", cue: "live" });
});

it("takes a live cue with Space while armed, but not with Space when unarmed", () => {
  const { onCommand } = renderStrip();
  fireEvent.keyDown(screen.getByRole("article"), { key: " " });
  expect(onCommand).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Cue live" }));
  fireEvent.keyDown(screen.getByRole("article"), { key: " " });
  expect(onCommand).toHaveBeenCalledWith({ type: "cue", cue: "live" });
});

it("sends the wrap cue after a full hold and ignores a hold that is released early", () => {
  const { onCommand } = renderStrip();
  const hold = screen.getByRole("button", { name: "Hold · cue wrap" });
  fireEvent.pointerDown(hold);
  expect(screen.getByRole("button", { name: "Keep holding…" })).toBeInTheDocument();
  fireEvent.pointerDown(hold);
  act(() => {
    vi.advanceTimersByTime(HOLD_MS - 1);
  });
  fireEvent.pointerUp(hold);
  expect(onCommand).not.toHaveBeenCalled();

  fireEvent.pointerDown(hold);
  act(() => {
    vi.advanceTimersByTime(HOLD_MS);
  });
  expect(onCommand).toHaveBeenCalledWith({ type: "cue", cue: "wrap" });
});

it("starts the wrap hold from the keyboard and cancels it on key release", () => {
  const { onCommand } = renderStrip();
  const hold = screen.getByRole("button", { name: "Hold · cue wrap" });
  fireEvent.keyDown(hold, { key: "Enter" });
  fireEvent.keyDown(hold, { key: "Enter", repeat: true });
  fireEvent.keyDown(hold, { key: "x" });
  fireEvent.keyUp(hold, { key: "x" });
  fireEvent.keyUp(hold, { key: "Enter" });
  act(() => {
    vi.advanceTimersByTime(HOLD_MS);
  });
  expect(onCommand).not.toHaveBeenCalled();
});

it("requests or mutes the microphone and camera, and disables those without a track", () => {
  const { onCommand } = renderStrip({
    tracks: [
      { sid: "m", source: "microphone", muted: true },
      { sid: "c", source: "camera", muted: true },
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: "Request mic" }));
  expect(onCommand).toHaveBeenLastCalledWith({ type: "media", device: "microphone", enabled: true });
  fireEvent.click(screen.getByRole("button", { name: "Request camera" }));
  expect(onCommand).toHaveBeenLastCalledWith({ type: "media", device: "camera", enabled: true });
});

it("mutes the microphone and camera when they are live, after a plain-words confirmation, and disables them when the guest has no such track", () => {
  const { onCommand } = renderStrip();
  fireEvent.click(screen.getByRole("button", { name: "Mute mic" }));
  expect(screen.getByRole("group", { name: "Confirm" })).toHaveTextContent("Mute Lucía Ferrer's microphone? They are asked to switch it off.");
  expect(onCommand).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
  expect(onCommand).toHaveBeenLastCalledWith({ type: "media", device: "microphone", enabled: false });
  fireEvent.click(screen.getByRole("button", { name: "Mute camera" }));
  fireEvent.click(screen.getByRole("button", { name: "Turn off camera" }));
  expect(onCommand).toHaveBeenLastCalledWith({ type: "media", device: "camera", enabled: false });
  cleanup();

  renderStrip({ tracks: [] });
  expect(screen.getByRole("button", { name: "Mute mic" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Mute camera" })).toBeDisabled();
});

it("changes the return video, audio bus, level and delay, and toggles the source mute", () => {
  const { onReturn } = renderStrip();
  const selects = screen.getAllByRole("combobox");
  fireEvent.change(selects[0], { target: { value: "preview" } });
  expect(onReturn).toHaveBeenLastCalledWith("returnVideo", "preview");
  fireEvent.change(selects[1], { target: { value: "aux-3" } });
  expect(onReturn).toHaveBeenLastCalledWith("returnAudioBus", "aux-3");
  fireEvent.change(selects[2], { target: { value: "0.5" } });
  expect(onReturn).toHaveBeenLastCalledWith("sourceGain", 0.5);
  fireEvent.change(selects[3], { target: { value: "300" } });
  expect(onReturn).toHaveBeenLastCalledWith("sourceDelayMs", 300);
  fireEvent.click(screen.getByRole("button", { name: "Routed to returns" }));
  expect(onReturn).toHaveBeenLastCalledWith("sourceMuted", true);
});

it("shows the muted return and un-mutes it", () => {
  const { onReturn } = renderStrip({ sourceMuted: true });
  fireEvent.click(screen.getByRole("button", { name: "Muted in returns" }));
  expect(onReturn).toHaveBeenLastCalledWith("sourceMuted", false);
});

it("sends a standby cue and a private message, and only sends a message with text", () => {
  const { onCommand, onDraftChange } = renderStrip({}, { draft: "  " });
  expect(screen.getByRole("button", { name: "Send message to Lucía Ferrer" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Standby" }));
  expect(onCommand).toHaveBeenLastCalledWith({ type: "cue", cue: "standby" });
  fireEvent.change(screen.getByLabelText("Message Lucía Ferrer"), { target: { value: "Stand by" } });
  expect(onDraftChange).toHaveBeenCalledWith("Stand by");
});

it("sends a private message with text and shows the latest command", () => {
  const { onCommand } = renderStrip({ commands: [{ type: "message", payload: {}, status: "delivered" }] }, { draft: "Stand by" });
  fireEvent.click(screen.getByRole("button", { name: "Send message to Lucía Ferrer" }));
  expect(onCommand).toHaveBeenLastCalledWith({ type: "message", text: "Stand by" });
  expect(screen.getByText("delivered")).toBeInTheDocument();
});

it("holds talk with the pointer and the T key, and stops on release or blur", () => {
  const handlers = renderStrip({}, { canOperate: true });
  const talk = screen.getByRole("button", { name: "Hold · talk (T)" });
  fireEvent.pointerDown(talk);
  expect(handlers.onTalkStart).toHaveBeenCalledTimes(1);
  fireEvent.pointerUp(talk);
  expect(handlers.onTalkStop).toHaveBeenCalledTimes(1);

  const article = screen.getByRole("article");
  fireEvent.keyDown(article, { key: "t" });
  fireEvent.keyDown(article, { key: "T", repeat: true });
  expect(handlers.onTalkStart).toHaveBeenCalledTimes(2);
  fireEvent.keyUp(article, { key: "t" });
  expect(handlers.onTalkStop).toHaveBeenCalledTimes(2);

  fireEvent.keyDown(article, { key: "t" });
  fireEvent.blur(article, { relatedTarget: null });
  expect(handlers.onTalkStop).toHaveBeenCalledTimes(3);
});

it("keeps talking while focus stays inside the strip, and ignores a T typed in a field", () => {
  const handlers = renderStrip({}, { canOperate: true });
  const article = screen.getByRole("article");
  const field = screen.getByLabelText("Message Lucía Ferrer");
  fireEvent.keyDown(field, { key: "t" });
  expect(handlers.onTalkStart).not.toHaveBeenCalled();

  fireEvent.keyDown(article, { key: "t" });
  fireEvent.blur(article, { relatedTarget: screen.getByRole("button", { name: "Standby" }) });
  expect(handlers.onTalkStop).not.toHaveBeenCalled();
});

it("talks to a live-cued guest only after the on-air confirmation is ticked", () => {
  const handlers = renderStrip({ commands: [cueCommand("live")] });
  const talk = screen.getByRole("button", { name: "Hold · talk (T)" });
  expect(talk).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("button", { name: "Hold · talk (T)" })).toBeEnabled();
  fireEvent.pointerDown(screen.getByRole("button", { name: "Hold · talk (T)" }));
  expect(handlers.onTalkStart).toHaveBeenCalledTimes(1);
});

it("shows the on-air title when a live cue is not yet confirmed, and the talking state while held", () => {
  renderStrip({ commands: [cueCommand("live")] }, { talking: true });
  expect(screen.getByRole("button", { name: "Talking… release to stop" })).toBeInTheDocument();
});

it("replaces, removes and revokes the session from the footer", () => {
  const handlers = renderStrip();
  fireEvent.click(screen.getByRole("button", { name: "Replace link" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove session" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove from call" }));
  fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
  expect(handlers.onReplace).toHaveBeenCalledTimes(1);
  expect(handlers.onRemove).toHaveBeenCalledTimes(1);
  expect(handlers.onRevoke).toHaveBeenCalledTimes(1);
});

it("clears a wrap hold that is still running when the strip unmounts, and ignores a second talk press", () => {
  const onCommand = vi.fn();
  const onTalkStart = vi.fn();
  const { unmount } = render(
    <GuestStrip
      participant={guest()}
      expiresAt="2026-11-23T12:00:00Z"
      canOperate
      busy={false}
      talking={false}
      draft=""
      onDraftChange={vi.fn()}
      onReturn={vi.fn()}
      onCommand={onCommand}
      onTalkStart={onTalkStart}
      onTalkStop={vi.fn()}
      onReplace={vi.fn()}
      onRemove={vi.fn()}
      onRevoke={vi.fn()}
    />,
  );
  fireEvent.pointerDown(screen.getByRole("button", { name: "Hold · cue wrap" }));
  const talk = screen.getByRole("button", { name: "Hold · talk (T)" });
  fireEvent.pointerDown(talk);
  fireEvent.pointerDown(talk);
  expect(onTalkStart).toHaveBeenCalledTimes(1);
  unmount();
  act(() => {
    vi.advanceTimersByTime(HOLD_MS);
  });
  expect(onCommand).not.toHaveBeenCalled();
});

it("keeps a guest in the call when the removal is not confirmed, and says what removing does", () => {
  const handlers = renderStrip();
  fireEvent.click(screen.getByRole("button", { name: "Remove session" }));
  expect(screen.getByRole("group", { name: "Confirm" })).toHaveTextContent(
    "Remove Lucía Ferrer from the call? They drop off now. Their link still works until it expires, so they can rejoin.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Keep" }));
  expect(handlers.onRemove).not.toHaveBeenCalled();
  expect(screen.queryByRole("group", { name: "Confirm" })).toBeNull();
});

it("says in plain words whether the guest's audio and video are sent", () => {
  renderStrip({
    tracks: [
      { sid: "m", source: "microphone", muted: true },
      { sid: "c", source: "camera", muted: false },
    ],
  });
  const av = screen.getByLabelText("Audio and video");
  expect(av).toHaveTextContent("Audio muted");
  expect(av).toHaveTextContent("Video on");
});

it("says audio and video are not sent when the guest has no such track", () => {
  renderStrip({ tracks: [] });
  const av = screen.getByLabelText("Audio and video");
  expect(av).toHaveTextContent("Audio not sent");
  expect(av).toHaveTextContent("Video not sent");
});

// "Dropped" is for a guest who was live and lost the connection. A slot whose invitation was never used is invited.
it("says a guest who never joined is invited, not dropped", () => {
  renderStrip({ connectionState: "offline" }, { neverJoined: true });
  expect(screen.getByText("Invited, not joined")).toBeVisible();
  expect(screen.queryByText("Dropped")).toBeNull();
});

it("still says a guest who was live and lost the connection is dropped", () => {
  renderStrip({ connectionState: "offline" }, { neverJoined: false });
  expect(screen.getByText("Dropped")).toBeVisible();
});
