import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fac = vi.hoisted(() => ({ getColor: vi.fn() }));
vi.mock("fast-average-color", () => ({ FastAverageColor: class { getColor = fac.getColor; } }));

type Mod = typeof import("./WeatherSegment");
let mod: Mod;

const NOW = new Date("2030-06-01T12:00:00Z").getTime();
const body = (code: number, temp = 50.4) => ({
  current: { temperature_2m: temp, weather_code: code },
  daily: { temperature_2m_max: [temp + 10.2], temperature_2m_min: [temp - 10.2] },
});
const ok = (data: any) => ({ ok: true, json: async () => data });

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
  fac.getColor.mockReset().mockReturnValue({ hex: "#445566" });
  mod = await import("./WeatherSegment");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchWeatherData", () => {
  it("builds the four regions, converts conditions from weather codes and rounds temperatures", async () => {
    const codes = [0, 1, 2, 3, 55, 80, 97, 45];
    let n = 0;
    const fetchMock = vi.fn().mockImplementation(async () => ok(body(codes[n++ % codes.length])));
    vi.stubGlobal("fetch", fetchMock);
    const data = await mod.fetchWeatherData();
    expect(data.map((r) => r.region)).toEqual(["North America", "Europe", "South America", "Asia"]);
    expect(fetchMock).toHaveBeenCalledTimes(24);
    expect(fetchMock.mock.calls[0][0]).toContain("latitude=40.7128&longitude=-74.006");
    const flat = data.flatMap((r) => r.cities);
    expect(new Set(flat.map((c) => c.condition))).toEqual(new Set(["sunny", "cloudy", "rainy"]));
    expect(flat[0]).toEqual({ name: "New York", temp: 50, condition: "sunny", high: 61, low: 40 });
  });

  it("skips cities that fail and regions left with no city", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("latitude=40.7128")) return { ok: false };
      if (url.includes("latitude=35.6762")) throw new Error("net");
      if (url.includes("latitude=48.8566")) throw new Error("net");
      const asia = ["37.5665", "31.2304", "22.3193", "13.7563", "-6.2088"].some((l) => url.includes(`latitude=${l}`));
      return asia ? { ok: false } : ok(body(0));
    });
    vi.stubGlobal("fetch", fetchMock);
    const data = await mod.fetchWeatherData();
    expect(data.map((r) => r.region)).toEqual(["North America", "Europe", "South America"]);
    expect(data[0].cities.map((c) => c.name)).not.toContain("New York");
    expect(error).toHaveBeenCalledWith("Failed to fetch weather for Paris:", expect.any(Error));
  });

  it("serves from the cache for an hour and refetches afterwards", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(body(0)));
    vi.stubGlobal("fetch", fetchMock);
    const first = await mod.fetchWeatherData();
    vi.setSystemTime(NOW + 59 * 60_000);
    expect(await mod.fetchWeatherData()).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(24);
    vi.setSystemTime(NOW + 61 * 60_000);
    expect(await mod.fetchWeatherData()).not.toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(48);
  });
});

describe("createWeatherSegment", () => {
  const city = (name: string, condition: any, temp = 68) => ({ name, temp, condition, high: temp + 14, low: temp - 18 });
  const regions = [
    { region: "North America", cities: [city("A", "sunny"), city("B", "rainy"), city("C", "windy"), city("D", "cloudy")] },
    { region: "Europe", cities: [city("E", "sunny")] },
    { region: "Mystery", cities: [city("F", "cloudy")] },
  ];

  it("counts two items per region, or eight while loading", () => {
    expect(mod.createWeatherSegment(regions).itemCount).toBe(6);
    const segment = mod.createWeatherSegment([]);
    expect(segment).toMatchObject({ id: "weather", durationMsPerItem: 5000, itemCount: 8 });
  });

  it("shows a loading slide without data", () => {
    render(<>{mod.createWeatherSegment([]).render(0, 0)}</>);
    expect(document.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("renders a region in Fahrenheit then Celsius with a fade between, wrapping around the regions", () => {
    const segment = mod.createWeatherSegment(regions);
    const { container, rerender } = render(<>{segment.render(0, 25)}</>);
    expect(screen.getAllByText("68°F")).toHaveLength(4);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(container.querySelectorAll("svg")).toHaveLength(4);
    expect(container.querySelector<HTMLElement>(".bg-white.transition-all")!.style.width).toBe("25%");
    expect(container.querySelector("img")).not.toBeNull();
    rerender(<>{segment.render(1, 50)}</>);
    const fading = container.querySelector<HTMLElement>("span.text-5xl")!;
    expect(fading.style.opacity).toBe("0");
    act(() => void vi.advanceTimersByTime(300));
    expect(screen.getAllByText("20°C")).toHaveLength(4);
    expect(container.querySelector<HTMLElement>("span.text-5xl")!.style.opacity).toBe("1");
    rerender(<>{segment.render(2, 0)}</>);
    expect(screen.getByText("E")).toBeInTheDocument();
    rerender(<>{segment.render(6, 0)}</>);
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("has a background for every named region", () => {
    const named = ["North America", "Europe", "South America", "Asia"].map((region) => ({ region, cities: [city(region, "sunny")] }));
    const segment = mod.createWeatherSegment(named);
    for (let i = 0; i < 4; i++) {
      const { container, unmount } = render(<>{segment.render(i * 2, 0)}</>);
      expect(container.querySelector("img")).not.toBeNull();
      unmount();
    }
  });
  it("omits the background image for a region without one", () => {
    const { container } = render(<>{mod.createWeatherSegment(regions).render(4, 0)}</>);
    expect(screen.getByText("F")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("clears the pending unit change when it unmounts", () => {
    const segment = mod.createWeatherSegment(regions);
    const { rerender, unmount } = render(<>{segment.render(0, 0)}</>);
    rerender(<>{segment.render(1, 0)}</>);
    unmount();
    act(() => void vi.advanceTimersByTime(500));
  });

  it("uses the dominant colour of the loaded background, and the default on failure", () => {
    const { container } = render(<>{mod.createWeatherSegment(regions).render(0, 0)}</>);
    fireEvent.load(container.querySelector("img")!);
    expect(container.querySelector<HTMLElement>(".mix-blend-multiply")!.style.background).toContain("#445566");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fac.getColor.mockImplementation(() => {
      throw new Error("tainted");
    });
    fireEvent.load(container.querySelector("img")!);
    expect(error).toHaveBeenCalledWith("Error getting average color", expect.any(Error));
    expect(container.querySelector<HTMLElement>(".mix-blend-multiply")!.style.background).toContain("#1e40af");
  });

  it("prefetches fresh data into the owner, or does nothing without a callback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(body(0)));
    vi.stubGlobal("fetch", fetchMock);
    const onDataUpdate = vi.fn();
    await mod.createWeatherSegment([], onDataUpdate).prefetch!();
    expect(onDataUpdate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ region: "Asia" })]));
    fetchMock.mockClear();
    await mod.createWeatherSegment([]).prefetch!();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
