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
