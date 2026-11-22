import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fac = vi.hoisted(() => ({ getColor: vi.fn() }));
vi.mock("fast-average-color", () => ({ FastAverageColor: class { getColor = fac.getColor; } }));

type Mod = typeof import("./MarketsSegment");
let mod: Mod;
const NOW = new Date("2030-06-01T12:34:00Z").getTime();
const stock = (symbol: string, price: number, pct: number, change = pct) => ({ symbol, name: `${symbol} Inc`, price, change, changesPercentage: pct });
const ok = (data: any) => ({ ok: true, json: async () => data });

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fac.getColor.mockReset().mockReturnValue({ hex: "#778899" });
  mod = await import("./MarketsSegment");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchMarketData", () => {
  it("keeps priced, sane movers, biggest move first, at most six, and remembers the update time", async () => {
    expect(mod.getLastUpdateTime()).toBe("--:--");
    const data = [
      stock("PENNY", 0.5, 50),
      stock("WILD", 10, 250),
      ...[1, -2, 3, -4, 5, -6, 7].map((p, i) => stock(`S${i}`, 10 + i, p)),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok(data)));
    const result = await mod.fetchMarketData();
    expect(result.map((r) => r.symbol)).toEqual(["S6", "S5", "S4", "S3", "S2", "S1"]);
    expect(result[0]).toEqual({ symbol: "S6", name: "S6 Inc", price: 16, change: 7, changePercent: 7 });
    expect(mod.getLastUpdateTime()).toMatch(/\d{2}:\d{2}/);
  });

  it("serves from the cache for fifteen minutes and then refetches", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok([stock("A", 5, 1)]));
    vi.stubGlobal("fetch", fetchMock);
    const first = await mod.fetchMarketData();
    vi.setSystemTime(NOW + 14 * 60_000);
    expect(await mod.fetchMarketData()).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + 16 * 60_000);
    await mod.fetchMarketData();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns an empty list on failure with no cache, and the stale cache otherwise", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await mod.fetchMarketData()).toEqual([]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect(await mod.fetchMarketData()).toEqual([]);
    expect(error).toHaveBeenCalledWith("[MarketsSegment] Failed to fetch market data:", expect.any(Error));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok([stock("A", 5, 1)])));
    const fresh = await mod.fetchMarketData();
    vi.setSystemTime(NOW + 20 * 60_000);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await mod.fetchMarketData()).toBe(fresh);
    vi.setSystemTime(NOW + 40 * 60_000);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect(await mod.fetchMarketData()).toBe(fresh);
  });
});

describe("createMarketsSegment", () => {
  const rows = [
    { symbol: "UP", name: "Up Inc", price: 12.5, change: 1.25, changePercent: 11.5 },
    { symbol: "DOWN", name: "Down Inc", price: 8, change: -0.5, changePercent: -6.1 },
    { symbol: "FLAT", name: "Flat Inc", price: 3, change: 0, changePercent: 0 },
    { symbol: "HUGE", name: "Huge Inc", price: 3, change: 300, changePercent: 500 },
  ];

  it("describes a one-item segment", () => {
    expect(mod.createMarketsSegment(rows)).toMatchObject({ id: "markets", itemCount: 1, durationMsPerItem: 10000 });
  });
  it("shows loading without data", () => {
    render(<>{mod.createMarketsSegment([]).render(0, 0)}</>);
    expect(document.querySelector(".animate-pulse")).not.toBeNull();
  });
  it("renders prices, signed changes, tinted rows and progress", () => {
    const { container } = render(<>{mod.createMarketsSegment(rows, undefined, "es").render(0, 60)}</>);
    expect(screen.getByText("$12.50")).toBeInTheDocument();
    expect(screen.getByText("+1.25")).toBeInTheDocument();
    expect(screen.getByText("-0.50")).toBeInTheDocument();
    expect(screen.getByText(/\+11\.50%/)).toBeInTheDocument();
    expect(screen.getByText(/-6\.10%/)).toBeInTheDocument();
    const cards = container.querySelectorAll<HTMLElement>(".grid-cols-2.items-center");
    expect(cards[0].style.backgroundColor).toContain("34, 197, 94");
    expect(cards[1].style.backgroundColor).toContain("239, 68, 68");
    expect(cards[3].style.backgroundColor).toContain("0.5");
    expect(container.querySelector<HTMLElement>(".bg-white.transition-all")!.style.width).toBe("60%");
    expect(container.querySelectorAll(".text-green-400")).toHaveLength(3);
    expect(container.querySelectorAll(".text-red-400")).toHaveLength(1);
  });
  it("uses the dominant colour of the loaded background, and the default on failure", () => {
    const { container } = render(<>{mod.createMarketsSegment(rows).render(0, 0)}</>);
    fireEvent.load(container.querySelector("img")!);
    expect(container.querySelector<HTMLElement>(".mix-blend-multiply")!.style.background).toContain("#778899");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fac.getColor.mockImplementation(() => {
      throw new Error("tainted");
    });
    fireEvent.load(container.querySelector("img")!);
    expect(error).toHaveBeenCalledWith("Error getting average color", expect.any(Error));
    expect(container.querySelector<HTMLElement>(".mix-blend-multiply")!.style.background).toContain("#065f46");
  });
  it("prefetches fresh data into the owner, or does nothing without a callback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok([stock("A", 5, 1)]));
    vi.stubGlobal("fetch", fetchMock);
    const onDataUpdate = vi.fn();
    await mod.createMarketsSegment([], onDataUpdate).prefetch!();
    expect(onDataUpdate).toHaveBeenCalledWith([expect.objectContaining({ symbol: "A" })]);
    fetchMock.mockClear();
    await mod.createMarketsSegment([]).prefetch!();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
