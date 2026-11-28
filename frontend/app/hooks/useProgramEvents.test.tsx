import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useProgramEvents } from "./useProgramEvents";
import { openProgramEvents, type ProgramEventsOptions } from "../services/programControl";

vi.mock("../services/programControl", () => ({ openProgramEvents: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("reports the stream's state and stops it on unmount", () => {
  const stop = vi.fn();
  let options!: ProgramEventsOptions;
  vi.mocked(openProgramEvents).mockImplementation((given) => {
    options = given;
    return stop;
  });
  const states: string[] = [];
  const messages: unknown[] = [];
  const { unmount } = renderHook(() =>
    useProgramEvents({
      programId: "main",
      onMessage: (data) => messages.push(data),
      onConnectionStateChange: (state) => states.push(state),
    }),
  );
  options.onOpen({ reconnect: false });
  options.onMessage({ n: 1 }, "message");
  options.onError?.(new Error("lost"));
  unmount();
  expect(messages).toEqual([{ n: 1 }]);
  expect(states).toEqual(["connecting", "connected", "disconnected", "disconnected"]);
  expect(stop).toHaveBeenCalledTimes(1);
});

it("opens no stream while disabled and says it is disconnected", () => {
  const states: string[] = [];
  renderHook(() =>
    useProgramEvents({
      programId: "main",
      enabled: false,
      onMessage: () => {},
      onConnectionStateChange: (state) => states.push(state),
    }),
  );
  expect(openProgramEvents).not.toHaveBeenCalled();
  expect(states).toEqual(["disconnected"]);
});
