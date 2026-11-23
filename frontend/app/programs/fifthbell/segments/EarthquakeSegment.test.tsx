import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEarthquakeSegment, fetchEarthquakes } from "./EarthquakeSegment";

const fac = vi.hoisted(() => ({ getColor: vi.fn() }));
vi.mock("fast-average-color", () => ({ FastAverageColor: class { getColor = fac.getColor; } }));

const NOW = new Date("2030-06-01T12:00:00Z").getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const quake = (over: any = {}) => ({
  id: 1,
  magnitude: 5.04,
  depth: 10.4,
  timestamp: ago(30 * MIN),
  latitude: 10.123,
  longitude: -20.456,
  datapoints: [{ source: "USGS" }],
  ...over,
});
const respond = (body: any, ok = true) => vi.fn().mockResolvedValue({ ok, json: async () => body });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fac.getColor.mockReset().mockReturnValue({ hex: "#112233" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchEarthquakes", () => {
  it("keeps recent M4.5+ quakes, newest first, at most six", async () => {
    const data = [
      quake({ id: 1, magnitude: 4.4 }),
      quake({ id: 2, timestamp: ago(25 * HOUR) }),
      ...[10, 20, 30, 40, 50, 60, 70].map((m, i) => quake({ id: 10 + i, timestamp: ago((i + 1) * MIN * m) })),
    ];
    vi.stubGlobal("fetch", respond(data));
    const result = await fetchEarthquakes();
    expect(result).toHaveLength(6);
    expect(result.map((q) => q.id)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(result.map((q) => q.timestamp)).toEqual([...result.map((q) => q.timestamp)].sort((a, b) => b - a));
  });
  it("rounds values and prefers the first detailed place, falling back to local place then coordinates", async () => {
    vi.stubGlobal(
      "fetch",
      respond([
        quake({ id: 1, datapoints: [{ source: "A", additionalData: { place: "Near X" } }, { source: "A", additionalData: { place: "Other" } }, { source: "B" }] }),
        quake({ id: 2, datapoints: [{ source: "A", additionalData: { localPlace: "Local Y" } }, { source: "B", additionalData: { localPlace: "Z" } }] }),
        quake({ id: 3, datapoints: [{ source: "A", additionalData: {} }] }),
      ]),
    );
    const [a, b, c] = await fetchEarthquakes();
    expect(a).toMatchObject({ magnitude: 5, depth: 10, location: "Near X", detailedPlace: "Near X", sources: ["A", "B"], lat: 10.123, lng: -20.456 });
    expect(b.location).toBe("Local Y");
    expect(c).toMatchObject({ location: "10.12°, -20.46°", detailedPlace: "" });
  });
  it("words the age in the requested language", async () => {
    const ages = [30 * 1000, 1 * MIN, 5 * MIN, 1 * HOUR, 3 * HOUR];
    vi.stubGlobal("fetch", respond(ages.map((age, i) => quake({ id: i, timestamp: ago(age) }))));
    const times = (await fetchEarthquakes("en")).map((q) => q.time);
    expect(new Set(times).size).toBe(5);
    vi.stubGlobal("fetch", respond([quake({ timestamp: ago(30 * HOUR) }), quake({ id: 2, timestamp: ago(60 * HOUR) })].map((q) => ({ ...q, timestamp: q.timestamp }))));
    const days = await fetchEarthquakes("es");
    expect(days).toHaveLength(0);
  });
  it("words a quake exactly a day old as a day ago, and the age ladder in Spanish", async () => {
    vi.stubGlobal("fetch", respond([quake({ timestamp: ago(24 * HOUR) })]));
    const [day] = await fetchEarthquakes("en");
    expect(day.time).toMatch(/day/i);
    expect(day.time).not.toMatch(/days/i);
    vi.stubGlobal("fetch", respond([1, 2].map((h) => quake({ id: h, timestamp: ago(h * HOUR) }))));
    const hours = await fetchEarthquakes("es");
    expect(hours).toHaveLength(2);
    expect(hours[0].time).not.toBe(hours[1].time);
  });
  it("returns an empty list when the request is refused or fails", async () => {
    vi.stubGlobal("fetch", respond([], false));
    expect(await fetchEarthquakes()).toEqual([]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect(await fetchEarthquakes()).toEqual([]);
    expect(error).toHaveBeenCalledWith("Failed to fetch earthquake data:", expect.any(Error));
  });
});

describe("createEarthquakeSegment", () => {
  const data = (magnitude: number, over: any = {}) => ({
    id: Math.round(magnitude * 10),
    magnitude,
    location: `Place ${magnitude}`,
    depth: 12,
    time: "5 minutes ago",
    timestamp: NOW,
    lat: 1.234,
    lng: 5.678,
    sources: ["USGS", "EMSC"],
    ...over,
  });

  it("describes a one-item segment and shows loading while there is no data", () => {
    const segment = createEarthquakeSegment([]);
    expect(segment).toMatchObject({ id: "earthquakes", itemCount: 1, durationMsPerItem: 10000 });
    render(<>{segment.render(0, 0)}</>);
    expect(screen.getByText(/./, { selector: ".animate-pulse" })).toBeInTheDocument();
  });

  it("renders each quake with its magnitude colour intensity, details and the progress bar", () => {
    const quakes = [data(4.7), data(5.5), data(7.2), data(9.5, { sources: [] })];
    const { container } = render(<>{createEarthquakeSegment(quakes, undefined, "it").render(0, 40)}</>);
    expect(screen.getByText("M4.7")).toBeInTheDocument();
    expect(screen.getByText("M9.5")).toBeInTheDocument();
    expect(screen.getByText("Place 5.5")).toHaveAttribute("title", "Place 5.5");
    expect(screen.getAllByText("1.23°, 5.68°")).toHaveLength(4);
    expect(screen.getAllByText("USGS, EMSC")).toHaveLength(3);
    const cards = container.querySelectorAll<HTMLElement>(".grid-cols-\\[auto_1fr\\]");
    expect(cards[0].style.backgroundColor).toContain("34, 197, 94");
    expect(cards[1].style.backgroundColor).toContain("234, 179, 8");
    expect(cards[2].style.backgroundColor).toContain("220, 38, 38");
    expect(parseFloat(cards[3].style.animationDelay)).toBeCloseTo(0.15);
    expect(container.querySelector<HTMLElement>(".bg-white.transition-all")!.style.width).toBe("40%");
  });

  it("takes the background colour from the loaded image, and keeps the default if that fails", () => {
    const { container } = render(<>{createEarthquakeSegment([data(5)]).render(0, 0)}</>);
    const img = container.querySelector("img")!;
    fireEvent.load(img);
    expect(container.querySelector<HTMLElement>(".mix-blend-multiply")!.style.background).toContain("#112233");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fac.getColor.mockImplementation(() => {
      throw new Error("tainted");
    });
    fireEvent.load(img);
    expect(error).toHaveBeenCalledWith("Error getting average color", expect.any(Error));
    expect(container.querySelector<HTMLElement>(".mix-blend-multiply")!.style.background).toContain("#7c2d12");
  });

  it("prefetches fresh data into the owner, or does nothing without a callback", async () => {
    vi.stubGlobal("fetch", respond([quake()]));
    const onDataUpdate = vi.fn();
    await createEarthquakeSegment([], onDataUpdate).prefetch!();
    await waitFor(() => expect(onDataUpdate).toHaveBeenCalledWith([expect.objectContaining({ id: 1 })]));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await createEarthquakeSegment([]).prefetch!();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
