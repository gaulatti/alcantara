import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { RadioOutputPlayer } from "./RadioOutputPlayer";
import { RadioMonitorProvider, useRadioMonitor } from "./RadioMonitor";

// gaulatti/alcantara#287: the listener audio belongs to the persistent layout, so it keeps playing
// while the operator moves between console pages.

let grants = 0;
let transport: MockInstance<typeof fetch>;
const ticketFor = (programId: string) => async () =>
  new Response(
    JSON.stringify({
      streamPath: `/radio/${encodeURIComponent(programId)}/monitor-audio?ticket=grant-${++grants}`,
      expiresInMs: 600000,
    }),
    { status: 201 },
  );

beforeEach(() => {
  grants = 0;
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const programId = decodeURIComponent(String(input).split("/radio/")[1].split("/")[0]);
    return ticketFor(programId)();
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Two console pages under one persistent provider: one shows the player, one does not. */
function Console({ programId = "station" }: { programId?: string }) {
  const [page, setPage] = useState<"control" | "songs">("control");
  return (
    <RadioMonitorProvider programId={programId}>
      <button onClick={() => setPage(page === "control" ? "songs" : "control")}>Go {page === "control" ? "songs" : "control"}</button>
      {page === "control" ? <RadioOutputPlayer programId={programId} /> : <p>Songs page</p>}
    </RadioMonitorProvider>
  );
}
const audios = () => document.querySelectorAll("audio");

it("keeps one audio element, owned by the provider, and playing across pages", async () => {
  render(<Console />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Listen" })).toBeEnabled());
  expect(audios()).toHaveLength(1);
  const audio = audios()[0];
  fireEvent.click(screen.getByRole("button", { name: "Listen" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Listening to broadcast"));
  const source = audio.getAttribute("src");
  expect(source).toContain("grant-1");
  vi.mocked(HTMLMediaElement.prototype.pause).mockClear();

  fireEvent.click(screen.getByRole("button", { name: "Go songs" }));
  expect(screen.getByText("Songs page")).toBeInTheDocument();
  expect(audios()[0]).toBe(audio);
  expect(audio.isConnected).toBe(true);
  expect(audio.getAttribute("src")).toBe(source);
  expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
  expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Go control" }));
  expect(screen.getByRole("status")).toHaveTextContent("Listening to broadcast");
  expect(screen.getByRole("button", { name: "Stop listening" })).toBeInTheDocument();
  expect(audios()).toHaveLength(1);
  expect(audios()[0]).toBe(audio);
  expect(transport).toHaveBeenCalledTimes(1);
});

it("asks for a monitor grant only while a player is on screen", async () => {
  render(<Console />);
  await waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Go songs" }));
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Go control" }));
  await waitFor(() => expect(transport).toHaveBeenCalledTimes(2));

  cleanup();
  transport.mockClear();
  render(
    <RadioMonitorProvider programId="station">
      <p>No player here</p>
    </RadioMonitorProvider>,
  );
  await act(async () => {});
  expect(transport).not.toHaveBeenCalled();
});

it("does not renew the grant for audio that is already playing when the player leaves", async () => {
  render(<Console />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Listen" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Listen" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Listening to broadcast"));
  fireEvent.click(screen.getByRole("button", { name: "Go songs" }));
  await act(async () => {});
  expect(transport).toHaveBeenCalledTimes(1);
});

it("stops the stream when the program changes, and prepares the new program's grant", async () => {
  const { rerender } = render(<Console programId="station" />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Listen" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Listen" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Listening to broadcast"));
  const audio = audios()[0];
  rerender(<Console programId="other" />);
  expect(audios()[0]).toBe(audio);
  expect(audio).not.toHaveAttribute("src");
  expect(screen.getByRole("status")).not.toHaveTextContent("Listening");
  await waitFor(() => expect(screen.getByRole("button", { name: "Listen" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Listen" }));
  expect(audio.getAttribute("src")).toContain("/radio/other/monitor-audio");
  expect(audios()).toHaveLength(1);
});

it("stops the audio when the persistent layout goes away, as on sign-out", async () => {
  const view = render(<Console />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Listen" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Listen" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Listening to broadcast"));
  const audio = audios()[0];
  view.unmount();
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  expect(audio).not.toHaveAttribute("src");
});

it("lets anything under the provider stop the stream, and reports the shared state", async () => {
  function Probe() {
    const monitor = useRadioMonitor()!;
    return (
      <>
        <output aria-label="state">{monitor.state}</output>
        <button onClick={monitor.stop}>Stop from outside</button>
      </>
    );
  }
  render(
    <RadioMonitorProvider programId="station">
      <Probe />
      <RadioOutputPlayer programId="station" />
    </RadioMonitorProvider>,
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "Listen" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Listen" }));
  await waitFor(() => expect(screen.getByLabelText("state")).toHaveTextContent("playing"));
  fireEvent.click(screen.getByRole("button", { name: "Stop from outside" }));
  expect(screen.getByLabelText("state")).toHaveTextContent("stopped");
  expect(audios()[0]).not.toHaveAttribute("src");
});

it("has no shared monitor outside the layout, and a fixture URL keeps its own audio element", async () => {
  function Outside() {
    return <output aria-label="monitor">{String(useRadioMonitor())}</output>;
  }
  render(<Outside />);
  expect(screen.getByLabelText("monitor")).toHaveTextContent("null");
  cleanup();
  render(
    <RadioMonitorProvider programId="station">
      <RadioOutputPlayer listenerUrl="https://radio.example/stream" />
    </RadioMonitorProvider>,
  );
  expect(audios()).toHaveLength(2);
  await act(async () => {});
  expect(transport).not.toHaveBeenCalled();
});

it("renews the monitor grant five seconds before it expires", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    render(<Console />);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600_000 - 5_000);
    expect(transport).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
