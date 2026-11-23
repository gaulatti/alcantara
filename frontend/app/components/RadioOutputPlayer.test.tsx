import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RadioOutputPlayer } from "./RadioOutputPlayer";

const url = "https://radio.example/stream";
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("listens only on explicit action, uses the exact producer URL and stops the connection locally", async () => {
  const { container } = render(<RadioOutputPlayer listenerUrl={url} />);
  const audio = container.querySelector("audio")!;
  expect(audio).not.toHaveAttribute("src");
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Listen" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Listening to broadcast",
    ),
  );
  expect(audio).toHaveAttribute("src", url);
  fireEvent.change(screen.getByRole("slider", { name: "Monitor volume" }), {
    target: { value: "0.3" },
  });
  expect(audio.volume).toBe(0.3);
  fireEvent.click(screen.getByRole("button", { name: "Stop listening" }));
  expect(audio).not.toHaveAttribute("src");
  expect(screen.getByRole("status")).toHaveTextContent("Monitor stopped");
});

it("reports playback failures and ignores a pending play after Stop or a station change", async () => {
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
    new Error("unavailable"),
  );
  const { rerender } = render(<RadioOutputPlayer listenerUrl={url} />);
  fireEvent.click(screen.getByRole("button", { name: "Listen" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("could not be played"),
  );
  let resolve!: () => void;
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Listen" }));
  fireEvent.click(screen.getByRole("button", { name: "Stop listening" }));
  resolve();
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Monitor stopped"),
  );
  rerender(<RadioOutputPlayer listenerUrl="https://other.example/live" />);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("disconnects on a station change and keeps network errors visible for retry", async () => {
  const { container, rerender, unmount } = render(
    <RadioOutputPlayer listenerUrl={url} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Listen" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Listening to broadcast",
    ),
  );
  const audio = container.querySelector("audio")!;
  fireEvent.error(audio);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "listener stream is unavailable",
  );
  fireEvent.click(screen.getByRole("button", { name: "Listen" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Listening to broadcast",
    ),
  );
  rerender(<RadioOutputPlayer listenerUrl="https://other.example/live" />);
  expect(audio).not.toHaveAttribute("src");
  expect(screen.getByRole("status")).toHaveTextContent("Monitor stopped");
  fireEvent.click(screen.getByRole("button", { name: "Listen" }));
  await waitFor(() =>
    expect(audio).toHaveAttribute("src", "https://other.example/live"),
  );
  unmount();
  expect(audio).not.toHaveAttribute("src");
});

it("prepares a protected monitor grant without manual configuration, plays within the click and renews after Stop", async () => {
  let grant = 0;
  const transport = vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          streamPath: `/radio/station/monitor-audio?ticket=grant-${++grant}`,
          expiresInMs: 60000,
        }),
        { status: 201 },
      ),
  );
  const { container, rerender } = render(
    <RadioOutputPlayer programId="station" />,
  );
  expect(screen.getByRole("button", { name: "Listen" })).toBeDisabled();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Listen" })).toBeEnabled(),
  );
  expect(transport).toHaveBeenCalledWith(
    expect.stringContaining("/radio/station/monitor-ticket"),
    expect.objectContaining({ method: "POST" }),
  );
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Listen" }));
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  expect(container.querySelector("audio")).toHaveAttribute(
    "src",
    expect.stringContaining("/radio/station/monitor-audio?ticket=grant-1"),
  );
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Listening to broadcast",
    ),
  );
  expect(transport).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Stop listening" }));
  await waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Listen" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Listen" }));
  expect(container.querySelector("audio")).toHaveAttribute(
    "src",
    expect.stringContaining("grant-2"),
  );
  rerender(<RadioOutputPlayer programId="other-station" />);
  expect(container.querySelector("audio")).not.toHaveAttribute("src");
});

it("shows connection failures and offers retry without a listener URL field", async () => {
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}", { status: 503 }));
  render(<RadioOutputPlayer programId="station" />);
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("could not connect"),
  );
  expect(screen.getByRole("button", { name: "Listen" })).toBeDisabled();
  transport.mockResolvedValue(
    new Response(
      JSON.stringify({
        streamPath: "/radio/station/monitor-audio?ticket=retry",
        expiresInMs: 60000,
      }),
      { status: 201 },
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Listen" })).toBeEnabled(),
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

it("refreshes an expired idle grant instead of sending it to native audio", async () => {
  let grant = 0;
  const transport = vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          streamPath: `/radio/station/monitor-audio?ticket=grant-${++grant}`,
          expiresInMs: 60000,
        }),
        { status: 201 },
      ),
  );
  const { container } = render(<RadioOutputPlayer programId="station" />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Listen" })).toBeEnabled(),
  );
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61000);
  fireEvent.click(screen.getByRole("button", { name: "Listen" }));
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  expect(container.querySelector("audio")).not.toHaveAttribute("src");
  expect(screen.getByRole("alert")).toHaveTextContent("connection expired");
  await waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Listen" })).toBeEnabled(),
  );
  clock.mockRestore();
  fireEvent.click(screen.getByRole("button", { name: "Listen" }));
  expect(container.querySelector("audio")).toHaveAttribute(
    "src",
    expect.stringContaining("grant-2"),
  );
});

it("refreshes on return to an idle tab and keeps active audio intact on return", async () => {
  let grant = 0;
  const transport = vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          streamPath: `/radio/station/monitor-audio?ticket=grant-${++grant}`,
          expiresInMs: 60000,
        }),
        { status: 201 },
      ),
  );
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const { container } = render(<RadioOutputPlayer programId="station" />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Listen" })).toBeEnabled(),
  );
  fireEvent(document, new Event("visibilitychange"));
  await waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Listen" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Listen" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Listening to broadcast",
    ),
  );
  fireEvent(document, new Event("visibilitychange"));
  expect(transport).toHaveBeenCalledTimes(2);
  expect(container.querySelector("audio")).toHaveAttribute(
    "src",
    expect.stringContaining("grant-2"),
  );
});

it("follows the native audio element's waiting and playing events only while a stream is attached", async () => {
  const { container } = render(<RadioOutputPlayer listenerUrl={url} />);
  const audio = container.querySelector("audio")!;
  // Before Listen there is no stream: native events do not change the status.
  fireEvent.waiting(audio);
  fireEvent.playing(audio);
  fireEvent.error(audio);
  expect(screen.getByRole("status")).toHaveTextContent("Monitor stopped");
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Listen" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Listening to broadcast",
    ),
  );
  fireEvent.waiting(audio);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Connecting to broadcast…",
  );
  fireEvent.playing(audio);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Listening to broadcast",
  );
});

it("does nothing on Listen when no listener stream is configured", () => {
  const { container } = render(<RadioOutputPlayer />);
  fireEvent.click(screen.getByRole("button", { name: "Listen" }));
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  expect(container.querySelector("audio")).not.toHaveAttribute("src");
  expect(screen.getByRole("status")).toHaveTextContent("Monitor stopped");
});

it("drops a play failure that arrives after the listener already stopped", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(
    () =>
      new Promise<void>((_done, fail) => {
        reject = fail;
      }),
  );
  render(<RadioOutputPlayer listenerUrl={url} />);
  fireEvent.click(screen.getByRole("button", { name: "Listen" }));
  fireEvent.click(screen.getByRole("button", { name: "Stop listening" }));
  reject(new Error("aborted"));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Monitor stopped"),
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

it("focuses the monitor when the page is opened at its anchor", () => {
  window.location.hash = "#radio-monitor";
  try {
    render(<RadioOutputPlayer listenerUrl={url} />);
    expect(document.activeElement).toHaveAttribute("id", "radio-monitor");
  } finally {
    window.location.hash = "";
  }
});

it("ignores a return to the tab while it is still hidden, and a grant that lands after unmount", async () => {
  let answer!: (response: Response) => void;
  const transport = vi.spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise<Response>((done) => {
        answer = done;
      }),
  );
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const { unmount } = render(<RadioOutputPlayer programId="station" />);
  fireEvent(document, new Event("visibilitychange"));
  expect(transport).toHaveBeenCalledTimes(1);
  unmount();
  answer(
    new Response(
      JSON.stringify({
        streamPath: "/radio/station/monitor-audio?ticket=late",
        expiresInMs: 60000,
      }),
      { status: 201 },
    ),
  );
  await new Promise((settle) => setTimeout(settle, 0));
  expect(transport).toHaveBeenCalledTimes(1);
});
