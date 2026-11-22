import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slideStyles } from "./slides/slideStyles";
import { MarqueeCurtain } from "./MarqueeCurtain";
import { DEFAULT_WORLD_CLOCK_CITIES, WorldClocks } from "./WorldClocks";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2030-06-01T12:00:00Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MarqueeCurtain", () => {
  it("shows the callsign and completes after five seconds", () => {
    const onComplete = vi.fn();
    render(<MarqueeCurtain onComplete={onComplete} />);
    expect(screen.getByText("bell")).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(4999));
    expect(onComplete).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
  it("does not complete once it is gone", () => {
    const onComplete = vi.fn();
    const { unmount } = render(<MarqueeCurtain onComplete={onComplete} />);
    unmount();
    act(() => void vi.advanceTimersByTime(6000));
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe("WorldClocks", () => {
  const cities = [
    { city: "LIMA", timezone: "America/Lima" },
    { city: "Custom Town", timezone: "Asia/Tokyo" },
    { city: "ROME", timezone: "Europe/Rome" },
  ];
  const label = (c: HTMLElement) => c.querySelector<HTMLElement>(".uppercase")!.textContent;
  const clock = (c: HTMLElement) => c.querySelector<HTMLElement>(".text-6xl")!.textContent;

  it("shows the first city's local time, translating known city names", () => {
    const { container } = render(<WorldClocks cities={cities} shuffleCities={false} language="es" widthPx={240} />);
    expect(clock(container)).toBe("07:00");
    expect(label(container)).not.toBe("");
    expect((container.firstElementChild as HTMLElement).style.width).toBe("240px");
  });
  it("defaults to the built-in cities when none are given or the list is empty", () => {
    const { container, unmount } = render(<WorldClocks shuffleCities={false} />);
    expect(label(container)).toBe("NEW YORK");
    expect(DEFAULT_WORLD_CLOCK_CITIES).toHaveLength(25);
    unmount();
    const empty = render(<WorldClocks cities={[]} shuffleCities={false} />);
    expect(label(empty.container)).toBe("NEW YORK");
  });
  it("keeps untranslated names as given", () => {
    const { container } = render(<WorldClocks cities={[{ city: "Custom Town", timezone: "Asia/Tokyo" }]} shuffleCities={false} />);
    expect(label(container)).toBe("Custom Town");
    expect(clock(container)).toBe("21:00");
  });
  it("rotates through the cities with a fade, reshuffling after the last", () => {
    const { container } = render(<WorldClocks cities={cities} shuffleCities={false} rotateIntervalMs={1000} transitionDurationMs={200} language="en" />);
    const root = container.firstElementChild as HTMLElement;
    expect(label(container)).toBe("LIMA");
    act(() => void vi.advanceTimersByTime(1000));
    expect(root.style.opacity).toBe("0");
    act(() => void vi.advanceTimersByTime(200));
    expect(root.style.opacity).toBe("1");
    expect(label(container)).toBe("Custom Town");
    act(() => void vi.advanceTimersByTime(1200));
    expect(label(container)).toBe("ROME");
    act(() => void vi.advanceTimersByTime(1200));
    expect(label(container)).toBe("LIMA");
  });
  it("shuffles the order when asked", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const { container } = render(<WorldClocks cities={cities} shuffleCities rotateIntervalMs={1000} />);
    expect(label(container)).not.toBe("");
    expect(random).toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1000 + 300));
    act(() => void vi.advanceTimersByTime(1300));
    act(() => void vi.advanceTimersByTime(1300));
  });
  it("ticks its own clock each second unless a time is supplied", () => {
    const { container, rerender } = render(<WorldClocks cities={[cities[0]]} shuffleCities={false} />);
    act(() => void vi.advanceTimersByTime(60_000));
    expect(clock(container)).toBe("07:01");
    rerender(<WorldClocks cities={[cities[0]]} shuffleCities={false} currentTime={new Date("2030-06-01T20:30:00Z")} />);
    expect(clock(container)).toBe("15:30");
  });
  it("shows the broadcast override clock, or the real time when the override is malformed", () => {
    const { container, rerender } = render(
      <WorldClocks cities={[cities[0]]} shuffleCities={false} currentTime={new Date("2030-06-01T12:00:00Z")} timeOverride={{ startTime: "09:30", startedAt: "2030-06-01T11:59:00Z" }} />,
    );
    expect(clock(container)).toBe("09:31");
    rerender(<WorldClocks cities={[cities[0]]} shuffleCities={false} currentTime={new Date("2030-06-01T12:00:00Z")} timeOverride={{ startTime: "nope", startedAt: "x" }} />);
    expect(clock(container)).toBe("07:00");
  });
  it("clears its timers when it unmounts mid-fade", () => {
    const { unmount } = render(<WorldClocks cities={cities} shuffleCities={false} rotateIntervalMs={500} transitionDurationMs={300} />);
    act(() => void vi.advanceTimersByTime(500));
    unmount();
    act(() => void vi.advanceTimersByTime(2000));
  });
});

describe("slide styles", () => {
  it("defines the animations the slides use", () => {
    for (const name of ["animate-slide-transition", "animate-slide-up", "animate-fade-in-delay", "animate-scale-in", "kenburns"]) expect(slideStyles).toContain(name);
  });
});
