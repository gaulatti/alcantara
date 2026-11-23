import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createArticlesSegment, fetchArticles } from "./ArticlesSegment";

vi.mock("../components/slides/ArticleSlide", () => ({
  ArticleSlide: ({ newsItem, progress }: any) => <div data-testid="slide">{`${newsItem.headline}|${progress}`}</div>,
}));

const NOW = new Date("2030-06-01T12:00:00Z").getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const article = (id: number, over: any = {}) => ({
  id,
  title: `Title ${id}`,
  excerpt: `Excerpt ${id}`,
  slug: `slug-${id}`,
  url: null,
  canonicalUrl: null,
  featured: false,
  featuredImage: { url: `https://img/${id}.jpg` },
  categories: [{ name: "World", slug: "world" }],
  publishedAt: hoursAgo(1),
  status: "published",
  ...over,
});
const feed = (articles: any) => vi.fn().mockResolvedValue({ ok: true, json: async () => ({ articles }) });
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `${i}`, headline: `H${i}`, summary: "", imageUrl: `u${i}`, category: "c", url: "x" }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchArticles", () => {
  it("requests the language feed uncached, keeps published articles with images, and preloads them", async () => {
    const fetchMock = feed([
      article(1),
      article(2, { status: "draft" }),
      article(3, { featuredImage: { url: "" } }),
      article(4, { featuredImage: undefined }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const loaded: string[] = [];
    vi.stubGlobal("Image", class { crossOrigin = ""; set src(v: string) { loaded.push(v); } });
    const result = await fetchArticles("es");
    expect(fetchMock.mock.calls[0][0]).toContain("homepage-current-es.json");
    expect(fetchMock.mock.calls[0][1]).toEqual({ cache: "no-store" });
    expect(result.map((r) => r.id)).toEqual(["1"]);
    expect(loaded).toEqual(["https://img/1.jpg"]);
  });

  it("orders recent featured first, then newest, limited to ten", async () => {
    const data = [
      article(1, { publishedAt: hoursAgo(2) }),
      article(2, { featured: true, publishedAt: hoursAgo(20) }),
      article(3, { featured: true, publishedAt: hoursAgo(3) }),
      article(4, { featured: true, publishedAt: hoursAgo(5) }),
      article(5, { publishedAt: hoursAgo(1) }),
      ...[6, 7, 8, 9, 10, 11, 12].map((id) => article(id, { publishedAt: hoursAgo(30 + id) })),
    ];
    vi.stubGlobal("fetch", feed(data));
    vi.stubGlobal("Image", class { crossOrigin = ""; src = ""; });
    const result = await fetchArticles();
    expect(result).toHaveLength(10);
    expect(result.slice(0, 5).map((r) => r.id)).toEqual(["3", "4", "5", "1", "2"]);
  });

  it("builds the article link from an explicit url, a category and slug in each language, or the slug alone", async () => {
    const data = [
      article(1, { url: "//a//b/?x=1", publishedAt: hoursAgo(1) }),
      article(2, { slug: "/two", publishedAt: hoursAgo(2) }),
      article(3, { categories: [], slug: "three", publishedAt: hoursAgo(3) }),
      article(4, { categories: [], slug: "", canonicalUrl: "canon/path/", publishedAt: hoursAgo(4) }),
      article(5, { categories: [], slug: "", canonicalUrl: null, publishedAt: hoursAgo(5) }),
      article(6, { url: "   ", categories: undefined, slug: 7 as any, canonicalUrl: "", publishedAt: hoursAgo(6) }),
      article(7, { categories: [{ name: "N" }], slug: "seven", publishedAt: hoursAgo(7) }),
    ];
    vi.stubGlobal("fetch", feed(data));
    vi.stubGlobal("Image", class { crossOrigin = ""; src = ""; });
    const en = await fetchArticles("en");
    expect(en.map((r) => r.url)).toEqual([
      "https://fifthbell.com/a/b",
      "https://fifthbell.com/world/two",
      "https://fifthbell.com/three",
      "https://fifthbell.com/canon/path",
      "https://fifthbell.com/",
      "https://fifthbell.com/",
      "https://fifthbell.com/seven",
    ]);
    expect(en[0]).toMatchObject({ headline: "Title 1", summary: "Excerpt 1", category: "World" });
    expect(en[5].category).toBeUndefined();
    const it = await fetchArticles("it");
    expect(it[1].url).toBe("https://fifthbell.com/it/world/two");
  });

  it("falls back to the sample stories when the feed is empty, malformed, refused or unreachable", async () => {
    vi.stubGlobal("Image", class { crossOrigin = ""; src = ""; });
    vi.stubGlobal("fetch", feed([]));
    expect((await fetchArticles()).length).toBe(5);
    vi.stubGlobal("fetch", feed("nope"));
    expect((await fetchArticles()).length).toBe(5);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: "Down" }));
    expect((await fetchArticles()).length).toBe(5);
    expect(error).toHaveBeenCalledWith("Error fetching news items:", expect.objectContaining({ message: "Failed to fetch homepage feed: 503 Down" }));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("net")));
    expect((await fetchArticles()).length).toBe(5);
  });
});

describe("createArticlesSegment", () => {
  it("counts its articles, or the sample stories while empty", () => {
    expect(createArticlesSegment(items(3))).toMatchObject({ id: "articles", durationMsPerItem: 10000, itemCount: 3 });
    expect(createArticlesSegment([]).itemCount).toBe(5);
  });

  it("renders the sample stories while there are no articles", () => {
    render(<>{createArticlesSegment([]).render(0, 10)}</>);
    expect(screen.getByTestId("slide")).toHaveTextContent("Global Climate Summit Reaches Historic Agreement|10");
  });

  it("cross-fades from the previous story when the item changes, wrapping the index", () => {
    const segment = createArticlesSegment(items(2));
    const { rerender, container } = render(<>{segment.render(0, 5)}</>);
    expect(screen.getAllByTestId("slide")).toHaveLength(1);
    expect(container.querySelector(".animate-slide-transition")).toBeNull();
    rerender(<>{segment.render(0, 80)}</>);
    expect(screen.getByTestId("slide")).toHaveTextContent("H0|80");
    cleanup();
    render(<>{segment.render(3, 0)}</>);
    expect(screen.getByTestId("slide")).toHaveTextContent("H1|0");
  });

  it("holds the previous story under the new one for the transition and then drops it", () => {
    const Keyed = ({ index }: { index: number }) => {
      const items3 = items(3);
      const segment = createArticlesSegment(items3);
      const node = segment.render(index, 20) as any;
      return <>{{ ...node, key: "stable" }}</>;
    };
    const { rerender, container } = render(<Keyed index={0} />);
    rerender(<Keyed index={1} />);
    expect(screen.getAllByTestId("slide").map((n) => n.textContent)).toEqual(["H0|100", "H1|20"]);
    expect(container.querySelector(".animate-slide-transition")).not.toBeNull();
    act(() => void vi.advanceTimersByTime(800));
    expect(screen.getAllByTestId("slide")).toHaveLength(1);
    expect(container.querySelector(".animate-slide-transition")).toBeNull();
  });

  it("cancels a pending transition on unmount", () => {
    const Keyed = ({ index }: { index: number }) => {
      const node = createArticlesSegment(items(3)).render(index, 0) as any;
      return <>{{ ...node, key: "stable" }}</>;
    };
    const { rerender, unmount } = render(<Keyed index={0} />);
    rerender(<Keyed index={2} />);
    unmount();
    act(() => void vi.advanceTimersByTime(1000));
  });

  it("prefetches fresh articles into the owner, or does nothing without a callback", async () => {
    vi.stubGlobal("Image", class { crossOrigin = ""; src = ""; });
    const fetchMock = feed([article(9)]);
    vi.stubGlobal("fetch", fetchMock);
    const onDataUpdate = vi.fn();
    await createArticlesSegment([], onDataUpdate, "it").prefetch!();
    expect(fetchMock.mock.calls[0][0]).toContain("homepage-current-it.json");
    expect(onDataUpdate).toHaveBeenCalledWith([expect.objectContaining({ id: "9" })]);
    fetchMock.mockClear();
    await createArticlesSegment([]).prefetch!();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
