import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Earone } from "./Earone";
import { Slideshow } from "./Slideshow";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const step = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe("Earone", () => {
  const metrics = (c: HTMLElement) => [...c.querySelectorAll(".earone-metric-value")].map((n) => n.textContent);
  it("renders nothing without metrics", () => {
    const { container } = render(<Earone />);
    expect(container).toBeEmptyDOMElement();
    const blanks = render(<Earone rank="  " spins={null} />);
    expect(blanks.container).toBeEmptyDOMElement();
  });
  it("formats ranks and spins", () => {
    const { container } = render(<Earone rank={3} spins="12345" label="Chart" />);
    expect(metrics(container)).toEqual(["#3", "12,345"]);
    expect(screen.getByAltText("Chart")).toBeInTheDocument();
    expect(container.textContent).toContain("EN TIEMPO REAL");
  });
  it("keeps text values, and formats large numbers", () => {
    const { container } = render(<Earone rank=" new " spins={1234567} />);
    expect(metrics(container)).toEqual(["#new", "1,234,567"]);
  });
  it("shows dashes for a missing metric, and handles non-finite numbers", () => {
    const { container } = render(<Earone rank={2} spins={Number.NaN} />);
    expect(metrics(container)).toEqual(["#2", "NaN"]);
    cleanup();
    const other = render(<Earone rank={undefined} spins={5} />);
    expect(metrics(other.container)).toEqual(["--", "5"]);
    cleanup();
    const noSpins = render(<Earone rank={7} />);
    expect(metrics(noSpins.container)).toEqual(["#7", "--"]);
  });
  it("fades to new values after 180 ms, and keeps the old ones when it unmounts first", () => {
    const { container, rerender, unmount } = render(<Earone rank={1} spins={10} />);
    rerender(<Earone rank={2} spins={20} />);
    expect(container.querySelector(".earone-metric--transitioning")).not.toBeNull();
    expect(metrics(container)).toEqual(["#1", "10"]);
    step(180);
    expect(container.querySelector(".earone-metric--transitioning")).toBeNull();
    expect(metrics(container)).toEqual(["#2", "20"]);
    rerender(<Earone rank={3} spins={20} />);
    unmount();
    step(500);
  });
  it("still shows the previous values while the new ones are blank", () => {
    const { container, rerender } = render(<Earone rank={1} spins={10} />);
    rerender(<Earone rank={null} spins={null} />);
    expect(metrics(container)).toEqual(["#1", "10"]);
    step(180);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Slideshow", () => {
  const imgs = (c: HTMLElement) => [...c.querySelectorAll("img")] as HTMLImageElement[];
  const load = (...els: HTMLImageElement[]) => els.forEach((e) => fireEvent.load(e));
  const shown = (c: HTMLElement) => imgs(c).filter((i) => i.style.opacity === "1").map((i) => i.getAttribute("src"));

  it("renders nothing without usable images", () => {
    for (const images of [undefined, [], "", " , ", [1, [2], {}], {}, 5]) {
      const { container, unmount } = render(<Slideshow images={images as any} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });
  it("collects image URLs from strings, lists, objects and items, once each", () => {
    const { container } = render(
      <Slideshow
        images={{
          items: [{ url: "a.jpg, b.jpg" }, { url: 4 }, null, [], "x"],
          images: ["b.jpg\nc.jpg", 9],
        }}
      />,
    );
    expect(imgs(container).map((i) => i.getAttribute("src"))).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    cleanup();
    const mixed = render(<Slideshow images={["a.jpg,b.jpg", { url: "c.jpg" }, { nope: 1 }, [1], "a.jpg"] as any} />);
    expect(imgs(mixed.container).map((i) => i.getAttribute("src"))).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    cleanup();
    const text = render(<Slideshow images={"one.jpg\ntwo.jpg"} />);
    expect(imgs(text.container)).toHaveLength(2);
    cleanup();
    const objectOnly = render(<Slideshow images={{ items: "x", images: "y" } as any} />);
    expect(objectOnly.container).toBeEmptyDOMElement();
  });
  it("shows the first image once loaded, switching fades on only after it has painted", () => {
    const { container } = render(<Slideshow images={["a.jpg", "b.jpg"]} />);
    expect(shown(container)).toEqual([]);
    load(imgs(container)[0]);
    expect(shown(container)).toEqual(["a.jpg"]);
    expect(imgs(container)[0].style.transition).toBe("none");
    step(40);
    expect(imgs(container)[0].style.transition).toContain("opacity 900ms");
  });
  it("moves through the loaded images on the interval and keeps the old one underneath while it fades out", () => {
    const { container } = render(<Slideshow images={["a.jpg", "b.jpg", "c.jpg"]} intervalMs={2000} transitionMs={500} />);
    load(...imgs(container));
    step(40);
    step(2000);
    expect(shown(container)).toContain("b.jpg");
    expect(shown(container)).toContain("a.jpg");
    step(500);
    expect(shown(container)).toEqual(["b.jpg"]);
    step(2000);
    expect(shown(container)).toContain("c.jpg");
    step(500);
    expect(shown(container)).toEqual(["c.jpg"]);
    step(2000);
    expect(shown(container)).toEqual(expect.arrayContaining(["a.jpg"]));
  });
  it("cross-fades both images when the frame is not filled", () => {
    const { container } = render(<Slideshow images={["a.jpg", "b.jpg"]} fitMode="contain" intervalMs={1000} />);
    load(...imgs(container));
    step(1000);
    expect(shown(container)).toEqual(["b.jpg"]);
    expect(imgs(container)[0].style.objectFit).toBe("contain");
  });
  it("skips images that failed to load and returns to ones that load later", () => {
    const { container } = render(<Slideshow images={["a.jpg", "b.jpg"]} intervalMs={1000} />);
    load(imgs(container)[0]);
    step(2000);
    expect(shown(container)).toEqual(["a.jpg"]);
    fireEvent.error(imgs(container)[1]);
    fireEvent.load(imgs(container)[1]);
    step(1000);
    expect(shown(container)).toContain("b.jpg");
    fireEvent.error(imgs(container)[0]);
    step(1000);
    expect(shown(container)).toContain("b.jpg");
    fireEvent.error(imgs(container)[0]);
  });
  it("moves to a loaded image when the current one is not loaded", () => {
    const { container } = render(<Slideshow images={["a.jpg", "b.jpg"]} />);
    load(imgs(container)[1]);
    expect(shown(container)).toContain("b.jpg");
    step(900);
    expect(shown(container)).toEqual(["b.jpg"]);
  });
  it("shuffles to a different image each time", () => {
    const random = vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.99).mockReturnValue(0.99);
    const { container } = render(<Slideshow images={["a.jpg", "b.jpg", "c.jpg"]} shuffle="yes" intervalMs={1000} />);
    load(...imgs(container));
    step(1000);
    expect(random).toHaveBeenCalledTimes(2);
    expect(shown(container)).toContain("c.jpg");
  });
  it("prunes loaded images that leave the list and clamps the active index", () => {
    const { container, rerender } = render(<Slideshow images={["a.jpg", "b.jpg", "c.jpg"]} intervalMs={1000} />);
    load(...imgs(container));
    step(2000);
    rerender(<Slideshow images={["a.jpg"]} intervalMs={1000} />);
    expect(shown(container)).toEqual(["a.jpg"]);
    rerender(<Slideshow images={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
  it("applies the motion unless Ken Burns is off, and clamps timing props", () => {
    const { container, rerender } = render(<Slideshow images={["a.jpg", "b.jpg"]} intervalMs={1} transitionMs="99999" kenBurns="no" />);
    load(...imgs(container));
    expect(imgs(container)[0].style.animation).toBe("");
    rerender(<Slideshow images={["a.jpg", "b.jpg"]} intervalMs="abc" transitionMs={5} kenBurns />);
    expect(imgs(container)[0].style.animation).toContain("slideshowKenBurns0");
    expect(imgs(container)[0].style.animation).toContain("5100ms");
    rerender(<Slideshow images={["a.jpg", "b.jpg"]} kenBurns="maybe" shuffle={0} />);
    expect(imgs(container)[0].style.animation).toContain("slideshowKenBurns0");
  });
  it("alternates the motion name on each change and stops on unmount", () => {
    const { container, unmount } = render(<Slideshow images={["a.jpg", "b.jpg"]} intervalMs={1000} transitionMs={200} />);
    load(...imgs(container));
    step(1000);
    expect(imgs(container)[1].style.animation).toContain("slideshowKenBurns1");
    step(200);
    expect(imgs(container)[0].style.animation).toBe("");
    unmount();
    step(5000);
  });
  it("cancels its paint wait when it unmounts first", () => {
    const { container, unmount } = render(<Slideshow images={["a.jpg"]} />);
    load(imgs(container)[0]);
    unmount();
    step(100);
  });
});
