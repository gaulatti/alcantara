import { expect, it } from "vitest";
import * as segments from "./index";

it("exposes the segment factories, fetchers and the playlist engine", () => {
  for (const name of [
    "createArticlesSegment", "fetchArticles", "createWeatherSegment", "fetchWeatherData",
    "createEarthquakeSegment", "fetchEarthquakes", "createMarketsSegment", "fetchMarketData", "usePlaylistEngine",
  ]) expect(typeof (segments as any)[name]).toBe("function");
});
