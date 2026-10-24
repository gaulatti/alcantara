import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearCachedEvents,
  fetchEvents,
  getCachedEvents,
  getLastFetchTime,
  hasEventChanges,
  type Event,
  type EventPost,
} from "./events";

const post = (
  uuid: string,
  overrides: Record<string, unknown> = {},
): EventPost => ({
  id: 1,
  uuid,
  content: "Reported update",
  source: "newsroom",
  uri: "https://news.example.invalid/story",
  hash: uuid,
  author: "Fixture reporter",
  createdAt: "2026-10-24T10:00:00Z",
  relevance: 10,
  match_score: 1,
  ...overrides,
});
const event = (
  uuid: string,
  overrides: Record<string, unknown> = {},
): Event => ({
  id: 1,
  uuid,
  title: `Event ${uuid}`,
  summary: "Verified fixture summary",
  status: "open",
  created_at: "2026-10-24T10:00:00Z",
  updated_at: "2026-10-24T10:00:00Z",
  posts_count: 1,
  posts: [post(`${uuid}-post`)],
  ...overrides,
});

beforeEach(() => {
  clearCachedEvents();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-24T12:00:00Z"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ events: [], total: 0 })),
  );
});
afterEach(() => {
  clearCachedEvents();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const deliver = (events: Event[]) =>
  vi
    .mocked(fetch)
    .mockResolvedValueOnce(Response.json({ events, total: events.length }));

it("has no cache before an actual successful request and records the completed fetch time", async () => {
  expect(getCachedEvents()).toBeNull();
  expect(getLastFetchTime()).toBeNull();
  const first = event("first");
  deliver([first]);
  await expect(fetchEvents()).resolves.toEqual([first]);
  expect(fetch).toHaveBeenCalledWith("https://api.monitor.gaulatti.com/events");
  expect(getCachedEvents()).toEqual([first]);
  expect(getLastFetchTime()).toEqual(new Date("2026-10-24T12:00:00Z"));
  clearCachedEvents();
  expect(getCachedEvents()).toBeNull();
  expect(getLastFetchTime()).toBeNull();
});

it.each([" ES-mx ", "es", "ES"] as const)(
  "normalizes the preferred language %s in the actual request URL",
  async (language) => {
    deliver([event("spanish", { language: "es" })]);
    await fetchEvents({
      language: language as never,
      allowedLanguages: ["es"],
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.monitor.gaulatti.com/events?language=es",
    );
  },
);

it.each([null, 42, "", " ", "fr", "xx-ZZ"])(
  "does not invent a requested language for unsupported input %j",
  async (language) => {
    await fetchEvents({ language: language as never });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.monitor.gaulatti.com/events",
    );
  },
);

it.each([
  { language: "es-MX" },
  { lang: " ES " },
  { locale: "es-CL" },
  { language: 42, lang: "es" },
  { language: "fr", locale: "es" },
  { posts: [post("es-post", { language: "es" })] },
  { posts: [post("es-post", { lang: "es-AR" })] },
  { posts: [post("es-post", { locale: "es" })] },
  {
    posts: [
      post("unknown", { language: "fr" }),
      post("es-post", { language: "es" }),
    ],
  },
])(
  "filters by explicit event or post language metadata %j",
  async (metadata) => {
    const spanish = event("spanish", metadata);
    const english = event("english", { language: "en" });
    const unknown = event("unknown", { language: "unsupported", posts: [] });
    deliver([spanish, english, unknown]);
    await expect(fetchEvents({ allowedLanguages: ["es"] })).resolves.toEqual([
      spanish,
      unknown,
    ]);
  },
);

it("keeps authoritative event language ahead of conflicting post languages", async () => {
  deliver([
    event("english", {
      language: "en",
      posts: [post("spanish", { language: "es" })],
    }),
  ]);
  await expect(fetchEvents({ allowedLanguages: ["es"] })).resolves.toEqual([]);
});

it("normalizes and deduplicates the allowed language set without mixing independent cache keys", async () => {
  const first = event("spanish", { language: "es" });
  deliver([first]);
  await fetchEvents({ language: "es", allowedLanguages: ["it", "es", "it"] });
  const second = event("italian", {
    language: "it",
    created_at: "2026-10-24T11:00:00Z",
  });
  deliver([second]);
  await expect(
    fetchEvents({ language: "es", allowedLanguages: ["es", "it"] }),
  ).resolves.toEqual([first, second]);
  deliver([event("english", { language: "en" })]);
  await expect(
    fetchEvents({ language: "en", allowedLanguages: ["en"] }),
  ).resolves.toHaveLength(1);
  expect(getCachedEvents()?.map((item) => item.uuid)).toEqual(["english"]);
  deliver([]);
  await expect(
    fetchEvents({ language: "es", allowedLanguages: ["it", "es"] }),
  ).resolves.toEqual([first, second]);
});

it.each(
  [undefined, null, "es", ["invalid", "", 42]].map((allowed) => [allowed]),
)(
  "treats an absent or unusable allowed-language set %j as unfiltered",
  async (allowed) => {
    const incoming = [
      event("english", { language: "en" }),
      event("italian", { language: "it" }),
    ];
    deliver(incoming);
    await expect(
      fetchEvents({ allowedLanguages: allowed as never }),
    ).resolves.toEqual(incoming);
  },
);

it("merges immutable event identities and post UUIDs while replacing producer updates and sorting relevance", async () => {
  const old = event("same", {
    posts: [
      post("old", { relevance: 4 }),
      post("updated", { relevance: 5, content: "Old wording" }),
    ],
    posts_count: 2,
  });
  const retained = event("retained", { created_at: "2026-10-24T08:00:00Z" });
  deliver([old, retained]);
  await fetchEvents();
  const changed = event("same", {
    title: "Revised event title",
    summary: "Updated summary",
    status: "closed",
    updated_at: "2026-10-24T12:01:00Z",
    created_at: "2026-10-24T12:01:00Z",
    posts_count: 3,
    posts: [
      post("updated", { relevance: 20, content: "Corrected wording" }),
      post("new", { relevance: 10 }),
    ],
  });
  const newest = event("newest", { created_at: "2026-10-24T11:00:00Z" });
  deliver([changed, newest]);
  vi.setSystemTime(new Date("2026-10-24T12:02:00Z"));
  const result = await fetchEvents();
  expect(result.map((item) => item.uuid)).toEqual([
    "retained",
    "same",
    "newest",
  ]);
  expect(result[1]).toMatchObject({
    title: "Revised event title",
    summary: "Updated summary",
    status: "closed",
    created_at: old.created_at,
    updated_at: changed.updated_at,
    posts_count: 3,
  });
  expect(result[1].posts.map((item) => [item.uuid, item.relevance])).toEqual([
    ["updated", 20],
    ["new", 10],
    ["old", 4],
  ]);
  expect(result[1].posts[0].content).toBe("Corrected wording");
  expect(getLastFetchTime()).toEqual(new Date("2026-10-24T12:02:00Z"));
});

it("accepts a genuinely empty feed and later populates the same cache", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ total: 0 }));
  await expect(fetchEvents()).resolves.toEqual([]);
  expect(getCachedEvents()).toEqual([]);
  const incoming = event("later");
  deliver([incoming]);
  await expect(fetchEvents()).resolves.toEqual([incoming]);
});

it("keeps the last successful cache and timestamp when a later request is unavailable", async () => {
  const old = event("accepted");
  deliver([old]);
  await fetchEvents();
  const time = getLastFetchTime();
  vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 503 }));
  await expect(fetchEvents({ language: "es" })).rejects.toThrow(
    "Failed to fetch events: 503",
  );
  expect(getCachedEvents()).toEqual([old]);
  expect(getLastFetchTime()).toEqual(time);
});

it("does not overwrite a successful cache after malformed JSON or a transport rejection", async () => {
  const old = event("accepted");
  deliver([old]);
  await fetchEvents();
  vi.mocked(fetch).mockResolvedValueOnce(new Response("{invalid"));
  await expect(fetchEvents()).rejects.toThrow();
  vi.mocked(fetch).mockRejectedValueOnce(new Error("network unavailable"));
  await expect(fetchEvents()).rejects.toThrow("network unavailable");
  expect(getCachedEvents()).toEqual([old]);
});

it.each([
  { title: "Changed title" },
  { status: "closed" },
  { posts_count: 2 },
  { posts: [post("a-post"), post("second")] },
  { posts: [post("different-uuid")] },
])("detects material marquee changes %j", (changes) => {
  expect(hasEventChanges([event("a")], [event("a", changes)])).toBe(true);
});

it("detects added, removed or replaced event identities and duplicate-ID data loss", () => {
  expect(hasEventChanges([], [event("a")])).toBe(true);
  expect(hasEventChanges([event("a")], [])).toBe(true);
  expect(hasEventChanges([event("a")], [event("b")])).toBe(true);
  expect(
    hasEventChanges([event("a"), event("b")], [event("a"), event("a")]),
  ).toBe(true);
});

it("does not change the marquee for an identical snapshot, ordering alone or non-displayed text updates", () => {
  const a = event("a");
  const b = event("b");
  expect(hasEventChanges([], [])).toBe(false);
  expect(hasEventChanges([a], [structuredClone(a)])).toBe(false);
  expect(hasEventChanges([a, b], [b, a])).toBe(false);
  expect(
    hasEventChanges(
      [a],
      [
        event("a", {
          summary: "New summary",
          updated_at: "2026-10-24T12:00:00Z",
          posts: [post("a-post", { content: "New content", relevance: 30 })],
        }),
      ],
    ),
  ).toBe(false);
});
