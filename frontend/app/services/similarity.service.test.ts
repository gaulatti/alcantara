import { afterEach, expect, it, vi } from "vitest";
import {
  UPLOAD_BATCH_SIZE,
  exportSimilaritySongs,
  fetchSimilarityCoverage,
  fetchSimilarityDecisions,
  fetchSimilaritySettings,
  saveSimilaritySettings,
  uploadSimilarityEmbeddings,
} from "./similarity";

// gaulatti/alcantara#404 (group C): every request of the similarity service, its answers and the
// reasons it reports a failure.

afterEach(() => vi.unstubAllGlobals());

const answer = (response: Response) => vi.stubGlobal("fetch", vi.fn(async () => response));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const calls: Array<[string, () => Promise<unknown>]> = [
  ["settings", () => fetchSimilaritySettings("main")],
  ["save", () => saveSimilaritySettings("main", { similarityMode: "on", similarityThreshold: 0.5, similarityWindowSeconds: 30, similarityPool: "catalog" })],
  ["coverage", () => fetchSimilarityCoverage("main")],
  ["decisions", () => fetchSimilarityDecisions("main")],
  ["export", () => exportSimilaritySongs("main", "catalog", true)],
  ["upload", () => uploadSimilarityEmbeddings("main", JSON.stringify({ songs: [{}] }))],
];

it.each(calls)("reports why a failed %s request failed: a message, a list of them, or the status", async (name, call) => {
  answer(json({ message: "Radio only" }, 400));
  await expect(call()).rejects.toThrow("Radio only");
  answer(json({ message: ["a is bad", "b is bad"] }, 400));
  await expect(call()).rejects.toThrow("a is bad; b is bad");
  answer(new Response("not json", { status: 502 }));
  await expect(call()).rejects.toThrow("(502)");
  answer(json({ message: 7 }, 500));
  await expect(call()).rejects.toThrow("(500)");
  answer(json(null, 503));
  await expect(call()).rejects.toThrow("(503)");
  expect(name).toBeTruthy();
});

it("reads the settings with a default for every field the program has not saved, and null for none", async () => {
  answer(json({ similarityMode: "shadow", similarityThreshold: 0.6, similarityWindowSeconds: 45, similarityPool: "catalog" }));
  await expect(fetchSimilaritySettings("main")).resolves.toEqual({
    similarityMode: "shadow", similarityThreshold: 0.6, similarityWindowSeconds: 45, similarityPool: "catalog",
  });
  answer(json({}));
  await expect(fetchSimilaritySettings("main")).resolves.toEqual({
    similarityMode: "off", similarityThreshold: 0.8, similarityWindowSeconds: 30, similarityPool: "sequence",
  });
  answer(json(null));
  await expect(fetchSimilaritySettings("main")).resolves.toBeNull();
});

it("saves, reads coverage and decisions, and exports for the chosen scope", async () => {
  answer(json({}));
  await saveSimilaritySettings("a b", { similarityMode: "off", similarityThreshold: 0.8, similarityWindowSeconds: 30, similarityPool: "sequence" });
  const [saveUrl, saveInit] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(saveUrl).toContain("/radio/a%20b/settings");
  expect(saveInit.method).toBe("PUT");
  answer(json({ enabledSongs: 3 }));
  await expect(fetchSimilarityCoverage("main")).resolves.toEqual({ enabledSongs: 3 });
  answer(json([{ id: 1 }]));
  await expect(fetchSimilarityDecisions("main")).resolves.toEqual([{ id: 1 }]);
  expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("/similarity/decisions?limit=50");
  answer(json({ songs: [] }));
  await expect(exportSimilaritySongs("main", "sequence", false)).resolves.toBe(JSON.stringify({ songs: [] }, null, 2));
  expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("scope=sequence&missingOnly=false");
});

it("refuses a file that is not JSON or has no songs list", async () => {
  await expect(uploadSimilarityEmbeddings("main", "{")).rejects.toThrow("The file is not valid JSON.");
  await expect(uploadSimilarityEmbeddings("main", JSON.stringify({ songs: "x" }))).rejects.toThrow("The file has no songs array.");
});

it("uploads in batches, reports progress after each, and returns every result in order", async () => {
  const songs = Array.from({ length: UPLOAD_BATCH_SIZE + 3 }, (_, index) => ({ songId: index }));
  const send = vi.fn(async (_url: string, init: RequestInit) => {
    const batch = (JSON.parse(String(init.body)).songs as Array<{ songId: number }>).map((song) => ({ songId: song.songId, status: "stored" }));
    return json({ results: batch });
  });
  vi.stubGlobal("fetch", send);
  const progress = vi.fn();
  const results = await uploadSimilarityEmbeddings("main", JSON.stringify({ schema: 1, model: "m", windowSeconds: 30, songs }), progress);
  expect(send).toHaveBeenCalledTimes(2);
  expect(results.map((result) => result.songId)).toEqual(songs.map((song) => song.songId));
  expect(progress.mock.calls).toEqual([[UPLOAD_BATCH_SIZE, songs.length], [songs.length, songs.length]]);
  expect(JSON.parse(String(send.mock.calls[0][1].body))).toMatchObject({ schema: 1, model: "m", windowSeconds: 30 });
  // Without a progress callback it still uploads.
  answer(json({ results: [] }));
  await expect(uploadSimilarityEmbeddings("main", JSON.stringify({ songs: [{}] }))).resolves.toEqual([]);
});
