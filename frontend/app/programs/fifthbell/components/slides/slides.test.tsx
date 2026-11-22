import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fac = vi.hoisted(() => ({ getColor: vi.fn() }));
vi.mock("fast-average-color", () => ({ FastAverageColor: class { getColor = fac.getColor; } }));

import { ArticleSlide } from "./ArticleSlide";
import { CallsignSlide } from "./CallsignSlide";

const NOW = new Date("2030-06-01T16:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  fac.getColor.mockReset().mockReturnValue({ hex: "#123456" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CallsignSlide", () => {
  const audioRef = { current: null };
  it("starts with the big bell, then settles into the corner bell and reveals the New York time", () => {
    const { container } = render(<CallsignSlide currentTime={NOW} audioRef={audioRef} />);
    const blocks = () => [...container.querySelectorAll<HTMLElement>("[style*='opacity']")];
    expect(blocks()[0].style.opacity).toBe("1");
    const time = container.querySelector<HTMLElement>(".animate-fade-in-delay")!;
    expect(time.style.opacity).toBe("0");
    expect(time.textContent).toBe("12:00:00");
    act(() => void vi.advanceTimersByTime(2000));
    expect(blocks()[0].style.opacity).toBe("0");
    expect(time.style.opacity).toBe("0");
    act(() => void vi.advanceTimersByTime(500));
    expect(time.style.opacity).toBe("1");
    expect(screen.getByText("bell")).toBeInTheDocument();
  });
  it("ticks every second and follows a new current time", () => {
    const { container, rerender } = render(<CallsignSlide currentTime={NOW} audioRef={audioRef} />);
    act(() => void vi.advanceTimersByTime(3000));
    expect(container.querySelector(".animate-fade-in-delay")!.textContent).toBe("12:00:03");
    rerender(<CallsignSlide currentTime={new Date("2030-06-01T17:30:00Z")} audioRef={audioRef} />);
    expect(container.querySelector(".animate-fade-in-delay")!.textContent).toBe("13:30:00");
  });
  it("tints the background from the loaded image, keeping the default on failure", () => {
    const { container } = render(<CallsignSlide currentTime={NOW} audioRef={audioRef} />);
    fireEvent.load(container.querySelector("img")!);
    expect(container.querySelector<HTMLElement>(".mix-blend-multiply")!.style.background).toContain("#123456");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fac.getColor.mockImplementation(() => {
      throw new Error("tainted");
    });
    fireEvent.load(container.querySelector("img")!);
    expect(error).toHaveBeenCalledWith("Error getting average color", expect.any(Error));
    expect(container.querySelector<HTMLElement>(".mix-blend-multiply")!.style.background).toContain("#b21100");
  });
  it("stops its timers when it unmounts", () => {
    const { unmount } = render(<CallsignSlide currentTime={NOW} audioRef={audioRef} />);
    unmount();
    act(() => void vi.advanceTimersByTime(5000));
  });
});

describe("ArticleSlide", () => {
  const item = { id: "1", headline: "Big news", summary: "Details", imageUrl: "https://img/a.jpg", category: "World", url: "https://fifthbell.com/a?b=1" };
  it("shows the story, category, progress and a QR code for its link", () => {
    const { container } = render(<ArticleSlide newsItem={item} progress={35} />);
    expect(screen.getByText("Big news")).toBeInTheDocument();
    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.getByText("World")).toBeInTheDocument();
    expect(screen.getByAltText("Article QR code")).toHaveAttribute("src", `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(item.url)}`);
    expect(screen.getByAltText("Big news")).toHaveAttribute("src", item.imageUrl);
    expect(container.querySelector<HTMLElement>(".bg-white.transition-all")!.style.width).toBe("35%");
  });
  it("omits the category and falls back to a placeholder image", () => {
    render(<ArticleSlide newsItem={{ ...item, category: undefined, imageUrl: "" }} progress={0} />);
    expect(screen.queryByText("World")).toBeNull();
    expect(screen.getByAltText("Big news").getAttribute("src")).toContain("picsum.photos/seed/fallback");
  });
  it("uses the dominant colour of the loaded image for the tint and the category chip, or keeps the default on failure", () => {
    const { container } = render(<ArticleSlide newsItem={item} progress={0} />);
    fireEvent.load(container.querySelector("img")!);
    expect(container.querySelector<HTMLElement>(".mix-blend-multiply")!.style.background).toContain("#123456");
    expect(screen.getByText("World")).toHaveStyle({ backgroundColor: "#123456" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fac.getColor.mockImplementation(() => {
      throw new Error("tainted");
    });
    fireEvent.load(container.querySelector("img")!);
    expect(error).toHaveBeenCalledWith("Error getting average color", expect.any(Error));
  });
});
