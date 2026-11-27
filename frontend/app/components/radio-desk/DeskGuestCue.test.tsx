import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOLD_MS } from "../../utils/callerDesk";
import { DeskGuestCue } from "./DeskGuestCue";
import type { DeskGuest } from "./guestChip";

// Admit, Cue live and Wrap from the radio desk (gaulatti/alcantara#879): the Guest calls controls, on the desk.

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), operate: true }));
vi.mock("../../services/api", () => ({ authFetch: (...args: unknown[]) => mocks.fetch(...args) }));
vi.mock("../../hooks/useFeatures", () => ({
  useFeatures: () => ({ loading: false, hasPermission: (permission: string) => mocks.operate && permission === "alcantara:webrtc:operate" }),
}));

const inCall: DeskGuest = { identity: "guest-a1", name: "Fictional Anna", connectionState: "connected", cueState: null, invitationId: "a1" };
const waiting: DeskGuest = { identity: "guest-b2", name: "Fictional Ben", connectionState: "offline", screening: true, invitationId: "b2" };
const ok = () => new Response("{}", { status: 200 });
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

beforeEach(() => {
  mocks.fetch.mockReset().mockResolvedValue(ok());
  mocks.operate = true;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("DeskGuestCue", () => {
  it("lets a waiting guest in with Admit", async () => {
    const onChanged = vi.fn();
    render(<DeskGuestCue guest={waiting} programId="radio one" onChanged={onChanged} />);
    expect(screen.getByText("Waiting to be let in")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cue live/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Admit Fictional Ben" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(mocks.fetch).toHaveBeenCalledWith("/webrtc/invitations/b2/admit", { method: "POST" });
  });

  it("shows why Admit was refused, even when the answer has no readable body", async () => {
    mocks.fetch.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.reject(new Error("gone")) });
    render(<DeskGuestCue guest={waiting} programId="main" onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Admit Fictional Ben" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Request failed (500)");
  });

  it("cues live only on the second press, and says so at once", async () => {
    const onChanged = vi.fn();
    render(<DeskGuestCue guest={inCall} programId="radio one" onChanged={onChanged} />);
    expect(screen.getByText("Cue · none sent")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cue live" }));
    expect(mocks.fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Press again or Space: cue live/ }));
    await waitFor(() => expect(screen.getByText("Cue · live")).toBeInTheDocument());
    expect(mocks.fetch.mock.calls[0][0]).toBe("/webrtc/rooms/radio%20one/participants/guest-a1/control");
    expect(bodyOf(mocks.fetch.mock.calls[0])).toEqual({ type: "cue", cue: "live" });
    expect(onChanged).toHaveBeenCalled();
  });

  it("sends the armed live cue with Space, and stands by at once", async () => {
    render(<DeskGuestCue guest={inCall} programId="main" onChanged={vi.fn()} />);
    const group = screen.getByRole("group", { name: "Cue Fictional Anna" });
    fireEvent.keyDown(group, { key: " " });
    expect(mocks.fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cue live" }));
    fireEvent.keyDown(group, { key: " " });
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    expect(bodyOf(mocks.fetch.mock.calls[0])).toEqual({ type: "cue", cue: "live" });
    fireEvent.click(screen.getByRole("button", { name: "Standby" }));
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    expect(bodyOf(mocks.fetch.mock.calls[1])).toEqual({ type: "cue", cue: "standby" });
  });

  it("wraps only after a full hold", async () => {
    vi.useFakeTimers();
    render(<DeskGuestCue guest={{ ...inCall, cueState: "live" }} programId="main" onChanged={vi.fn()} />);
    const wrap = screen.getByRole("button", { name: /Hold · cue wrap/ });
    fireEvent.pointerDown(wrap);
    act(() => void vi.advanceTimersByTime(HOLD_MS - 1));
    fireEvent.pointerUp(wrap);
    act(() => void vi.advanceTimersByTime(HOLD_MS));
    expect(mocks.fetch).not.toHaveBeenCalled();
    fireEvent.pointerDown(wrap);
    await act(async () => void (await vi.advanceTimersByTimeAsync(HOLD_MS)));
    expect(bodyOf(mocks.fetch.mock.calls[0])).toEqual({ type: "cue", cue: "wrap" });
  });

  it("shows the studio's reason when it refuses, and keeps the stored cue", async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ message: "The guest left the call." }), { status: 409 }));
    render(<DeskGuestCue guest={{ ...inCall, cueState: "standby" }} programId="main" onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Cue live" }));
    fireEvent.click(screen.getByRole("button", { name: /Press again or Space/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The guest left the call.");
    expect(screen.getByText("Cue · standby")).toBeInTheDocument();

    mocks.fetch.mockResolvedValue(new Response("", { status: 503 }));
    fireEvent.click(screen.getByRole("button", { name: "Standby" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Request failed (503)");
    mocks.fetch.mockRejectedValue("offline");
    fireEvent.click(screen.getByRole("button", { name: "Standby" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The studio did not take that.");
  });

  it("follows the stored cue once the list reads a new one", async () => {
    const { rerender } = render(<DeskGuestCue guest={{ ...inCall, cueState: "standby" }} programId="main" onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Cue live" }));
    fireEvent.click(screen.getByRole("button", { name: /Press again or Space/ }));
    await waitFor(() => expect(screen.getByText("Cue · live")).toBeInTheDocument());
    // The next read says the guest rejoined: the stored state wins over the cue the desk sent.
    rerender(<DeskGuestCue guest={{ ...inCall, cueState: "rejoined" }} programId="main" onChanged={vi.fn()} />);
    expect(screen.getByText("Off air · rejoined, cue again")).toBeInTheDocument();
  });

  it("offers nothing to press without the operate permission, or for a guest who is not connected", () => {
    mocks.operate = false;
    render(<DeskGuestCue guest={inCall} programId="main" onChanged={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Cue live" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Hold · cue wrap/ })).toBeDisabled();
    cleanup();
    render(<DeskGuestCue guest={waiting} programId="main" onChanged={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Admit Fictional Ben" })).toBeDisabled();
    cleanup();
    mocks.operate = true;
    render(<DeskGuestCue guest={{ ...inCall, connectionState: "reconnecting" }} programId="main" onChanged={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Standby" })).toBeDisabled();
    cleanup();
    render(<DeskGuestCue guest={{ ...waiting, invitationId: undefined }} programId="main" onChanged={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Admit Fictional Ben" })).toBeDisabled();
  });
});
