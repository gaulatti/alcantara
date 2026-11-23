import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RelojClone from "./RelojClone";
import { LogoWidget } from "./LogoWidget";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2030-06-01T15:00:30Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RelojClone", () => {
  const hands = (c: HTMLElement) => ({
    hour: c.querySelector<HTMLElement>(".hour-hand")!.style.transform,
    minute: c.querySelector<HTMLElement>(".minute-hand")!.style.transform,
    second: c.querySelector<HTMLElement>(".second-hand")!.style.transform,
  });
  it("points the hands at the time in its timezone and keeps ticking", () => {
    const { container } = render(<RelojClone timezone="UTC" />);
    expect(container.querySelectorAll(".number")).toHaveLength(4);
    expect(hands(container)).toEqual({ hour: "rotate(540deg)", minute: "rotate(93deg)", second: "rotate(270deg)" });
    act(() => void vi.advanceTimersByTime(15_000));
    expect(hands(container).second).toBe("rotate(360deg)");
  });
  it("defaults to Buenos Aires time", () => {
    const { container } = render(<RelojClone />);
    expect(hands(container).hour).toBe("rotate(450deg)");
  });
  it("falls back to local time for an unknown timezone", () => {
    const { container } = render(<RelojClone timezone="Not/AZone" />);
    const now = new Date();
    expect(hands(container).second).toBe(`rotate(${(now.getSeconds() / 60) * 360 + 90}deg)`);
  });
  it("follows a broadcast time override, and restarts when it changes", () => {
    const { container, rerender } = render(<RelojClone timeOverride={{ startTime: "03:00", startedAt: "2030-06-01T15:00:00Z" }} />);
    expect(hands(container).hour).toBe("rotate(180deg)");
    expect(hands(container).second).toBe("rotate(270deg)");
    rerender(<RelojClone timeOverride={{ startTime: "06:00", startedAt: "2030-06-01T15:00:00Z" }} />);
    expect(hands(container).hour).toBe("rotate(270deg)");
  });
  it("uses the real time when the override is malformed, and stops ticking when it unmounts", () => {
    const { container, unmount } = render(<RelojClone timezone="UTC" timeOverride={{ startTime: "bad", startedAt: "x" }} />);
    expect(hands(container).hour).toBe("rotate(540deg)");
    unmount();
    act(() => void vi.advanceTimersByTime(5000));
  });
});

describe("LogoWidget", () => {
  const root = (c: HTMLElement) => c.firstElementChild as HTMLElement;
  it("shows a custom logo instead of the bug", () => {
    const { container } = render(<LogoWidget logoUrl="/my.svg" position="top-right" />);
    expect(container.querySelector("img.logo-image")).toHaveAttribute("src", "/my.svg");
    expect(root(container)).toHaveClass("top-right");
    expect(container.querySelector(".logo-big")).toBeNull();
  });
  it("starts as the small white bug at the bottom right", () => {
    const { container } = render(<LogoWidget />);
    expect(root(container)).toHaveClass("bottom-right", "variant-white");
    expect(container.querySelector(".logo-small")).toHaveClass("red-filter", "fade-in");
    expect(container.querySelector(".logo-big")).toHaveClass("fade-out");
  });
  it("cycles white, black, big, red and back to white every other ten seconds", () => {
    const { container } = render(<LogoWidget />);
    const step = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
    step(10_000);
    expect(root(container)).toHaveClass("gradient-active");
    step(10_000);
    expect(root(container)).toHaveClass("variant-black");
    step(100);
    expect(root(container)).not.toHaveClass("gradient-active");
    step(10_000 - 100);
    expect(root(container)).toHaveClass("gradient-active");
    step(10_000);
    expect(root(container)).toHaveClass("resizing");
    expect(container.querySelector(".logo-small")).toHaveClass("fade-out");
    step(800);
    expect(root(container)).toHaveClass("big-mode");
    expect(root(container)).not.toHaveClass("resizing");
    expect(container.querySelector(".logo-big")).toHaveClass("fade-in");
    step(10_000 - 800);
    step(10_000);
    expect(root(container)).not.toHaveClass("big-mode");
    expect(root(container)).toHaveClass("variant-black");
    step(800);
    expect(root(container)).toHaveClass("variant-red");
    expect(container.querySelector(".logo-small")).not.toHaveClass("red-filter");
    step(10_000 - 800);
    step(10_000);
    expect(root(container)).toHaveClass("variant-white");
    step(100);
    expect(root(container)).not.toHaveClass("gradient-active");
  });
  it("stops cycling when it unmounts", () => {
    const { unmount } = render(<LogoWidget />);
    unmount();
    act(() => void vi.advanceTimersByTime(60_000));
  });
});
