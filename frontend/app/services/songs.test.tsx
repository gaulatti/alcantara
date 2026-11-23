import { afterEach, expect, it, vi } from "vitest";
import { apiUrl } from "../utils/apiBaseUrl";
import { fetchSongCatalog, fetchSongsPage } from "./songs";

// gaulatti/alcantara#184, group G5: the song catalog client against a
// stubbed network.
afterEach(() => vi.unstubAllGlobals());

function network(body: unknown, init: ResponseInit = {}) {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(body), init));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("reads the whole catalog in one unpaged request", async () => {
  const fetch = network({ data: [{ id: 1, title: "Song" }], total: 1 });
  await expect(fetchSongCatalog()).resolves.toEqual([{ id: 1, title: "Song" }]);
  expect(fetch).toHaveBeenCalledWith(apiUrl("/songs?limit=0"));
});

it("pages the catalog with only the filters that are set", async () => {
  const page = { data: [], total: 0, page: 2 };
  let fetch = network(page);
  await expect(fetchSongsPage()).resolves.toEqual(page);
  expect(fetch).toHaveBeenCalledWith(apiUrl("/songs"));

  fetch = network(page);
  await fetchSongsPage({
    search: "love song",
    enabled: false,
    sortBy: "title",
    sortOrder: "desc",
    page: 2,
    limit: 25,
    programId: "radio",
  });
  expect(fetch).toHaveBeenCalledWith(
    apiUrl(
      "/songs?search=love+song&enabled=false&sortBy=title&sortOrder=desc&page=2&limit=25&programId=radio",
    ),
  );

  // Empty values are left out, and enabled=true is sent.
  fetch = network(page);
  await fetchSongsPage({ search: "", enabled: true, page: 0, limit: 0 });
  expect(fetch).toHaveBeenCalledWith(apiUrl("/songs?enabled=true"));
});

it("reports a refused request by its status", async () => {
  network({}, { status: 500 });
  await expect(fetchSongCatalog()).rejects.toThrow("HTTP 500");
  await expect(fetchSongsPage({ page: 1 })).rejects.toThrow("HTTP 500");
});
