import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAllMediaLabels } from "./mediaLabels";

// gaulatti/alcantara#404 (media labels service, from the full-run table): every page of the label list is
// read once, labels are kept by id and sorted by name, and a page that does not match the contract, or a
// failed page, stops the read with an error instead of a partial list.

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("./api", () => ({ authFetch }));

type Label = { id: string; name: string };

const page = (data: unknown, totalPages: unknown) =>
  new Response(JSON.stringify({ data, meta: { totalPages } }), { status: 200 });

afterEach(() => {
  authFetch.mockReset();
});

describe("fetchAllMediaLabels", () => {
  it("reads every page, keeps each label once by id, and sorts them by name", async () => {
    authFetch
      .mockResolvedValueOnce(page([{ id: "b", name: "Beta" }, { id: "a", name: "Alpha" }], 2))
      .mockResolvedValueOnce(page([{ id: "b", name: "Beta" }, { id: "c", name: "Gamma" }], 2));
    const labels = await fetchAllMediaLabels<Label>();
    expect(authFetch).toHaveBeenNthCalledWith(1, "/media-labels?page=1&limit=200");
    expect(authFetch).toHaveBeenNthCalledWith(2, "/media-labels?page=2&limit=200");
    expect(labels.map((label) => label.id)).toEqual(["a", "b", "c"]);
  });

  it("reads one page when there is only one", async () => {
    authFetch.mockResolvedValueOnce(page([], 1));
    await expect(fetchAllMediaLabels<Label>()).resolves.toEqual([]);
    expect(authFetch).toHaveBeenCalledTimes(1);
  });

  it("stops with the HTTP status when a page is refused", async () => {
    authFetch.mockResolvedValueOnce(new Response("down", { status: 503 }));
    await expect(fetchAllMediaLabels<Label>()).rejects.toThrow("Failed to load labels: HTTP 503");
  });

  it.each([
    ["the data is not a list", { data: "nope", meta: { totalPages: 1 } }],
    ["the page count is missing", { data: [], meta: {} }],
    ["the page count is not a whole number", { data: [], meta: { totalPages: 1.5 } }],
    ["the page count is negative", { data: [], meta: { totalPages: -1 } }],
  ])("refuses a response where %s, rather than a partial list", async (_, body) => {
    authFetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
    await expect(fetchAllMediaLabels<Label>()).rejects.toThrow("Invalid media labels response");
  });
});
