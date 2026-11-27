import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NewVersionPrompt } from "./NewVersionPrompt";

// gaulatti/alcantara#879: an open console is offered a reload once a new build is deployed, never while the host mic is
// open or a guest is live, and it appears once they are not.

const mocks = vi.hoisted(() => ({ deployed: "b8cadd70" as string | null, mic: "off", participants: [] as unknown[] | null, status: 200, running: "b8cadd70" as string | null }));
vi.mock("../utils/buildVersion", () => ({
  runningBuild: () => mocks.running,
  deployedBuild: async () => mocks.deployed,
}));
vi.mock("./HostMicOnAir", () => ({ useHostMic: () => ({ state: mocks.mic }) }));
vi.mock("../services/api", () => ({
  authFetch: async () => {
    if (mocks.status === 0) throw new Error("offline");
    return mocks.status === 200 ? Response.json(mocks.participants === null ? {} : { participants: mocks.participants }) : new Response(null, { status: mocks.status });
  },
}));

const tick = () => act(async () => void (await vi.advanceTimersByTimeAsync(1_000)));

beforeEach(() => {
  vi.useFakeTimers();
  mocks.deployed = "b8cadd70";
  mocks.mic = "off";
  mocks.participants = [];
  mocks.status = 200;
  mocks.running = "b8cadd70";
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("says nothing while the deployed build is this one, then offers a reload once it changes", async () => {
  render(<NewVersionPrompt programId="main" check={1_000} />);
  await tick();
  expect(screen.queryByText("New version")).toBeNull();
  mocks.deployed = "c0ffee12";
  await tick();
  expect(screen.getByRole("status")).toHaveTextContent("New version");
  const reload = vi.fn();
  vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload } as never);
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  expect(reload).toHaveBeenCalled();
});

it("is held back while the host microphone is open or starting, and appears after", async () => {
  mocks.deployed = "c0ffee12";
  mocks.mic = "starting";
  const { rerender } = render(<NewVersionPrompt programId="main" check={1_000} />);
  await tick();
  expect(screen.queryByText("New version")).toBeNull();
  mocks.mic = "on";
  rerender(<NewVersionPrompt programId="main" check={1_000} />);
  expect(screen.queryByText("New version")).toBeNull();
  mocks.mic = "off";
  rerender(<NewVersionPrompt programId="main" check={1_000} />);
  expect(screen.getByText("New version")).toBeVisible();
});

it("is held back while a guest of the show is live, and appears once they are wrapped", async () => {
  mocks.deployed = "c0ffee12";
  mocks.participants = [{ connectionState: "connected", cueState: "live" }];
  render(<NewVersionPrompt programId="main" check={1_000} />);
  await tick();
  expect(screen.queryByText("New version")).toBeNull();
  mocks.participants = [{ connectionState: "connected", cueState: "standby" }];
  await tick();
  expect(screen.getByText("New version")).toBeVisible();
});

it("waits when the guest list cannot be read, but not when the operator may not read it or calls are off", async () => {
  mocks.deployed = "c0ffee12";
  mocks.status = 500;
  render(<NewVersionPrompt programId="main" check={1_000} />);
  await tick();
  expect(screen.queryByText("New version")).toBeNull();
  for (const status of [403, 503]) {
    mocks.status = status;
    await tick();
    expect(screen.getByText("New version")).toBeVisible();
  }
});

it("stays away after Later until the next build, and checks again when the tab comes back", async () => {
  mocks.deployed = "c0ffee12";
  render(<NewVersionPrompt programId="main" check={60_000} />);
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByText("New version")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Not now/ }));
  expect(screen.queryByText("New version")).toBeNull();
  mocks.deployed = "d00d0001";
  await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
  expect(screen.getByText("New version")).toBeVisible();
});

it("waits while the guest list cannot be reached, shows with an empty answer, and ignores a hidden tab", async () => {
  mocks.deployed = "c0ffee12";
  mocks.status = 0;
  render(<NewVersionPrompt programId="main" check={1_000} />);
  await tick();
  expect(screen.queryByText("New version")).toBeNull();
  mocks.status = 200;
  mocks.participants = null;
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.queryByText("New version")).toBeNull();
  await tick();
  expect(screen.getByText("New version")).toBeVisible();
});

it("offers nothing when the running build cannot be read", async () => {
  mocks.running = null;
  mocks.deployed = "c0ffee12";
  render(<NewVersionPrompt programId="main" check={1_000} />);
  await tick();
  expect(screen.queryByText("New version")).toBeNull();
});
