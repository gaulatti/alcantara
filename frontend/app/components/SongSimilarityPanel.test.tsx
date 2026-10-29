import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SongSimilarityPanel } from "./SongSimilarityPanel";
import { UPLOAD_BATCH_SIZE, uploadSimilarityEmbeddings } from "../services/similarity";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const coverage = {
  model: { name: "discogs-effnet-bs64-1", version: "1", license: "CC BY-NC-SA 4.0" },
  windowSeconds: 30,
  enabledSongs: 10,
  embeddedSongs: 4,
  missingSongs: 6,
};

it("shows coverage, license and a shadow decision beside what played", () => {
  render(
    <SongSimilarityPanel
      programId="radio-1"
      fixtureData={{
        settings: {
          similarityMode: "shadow",
          similarityThreshold: 0.8,
          similarityWindowSeconds: 30,
          similarityPool: "sequence",
        },
        coverage,
        decisions: [
          {
            id: 1,
            mode: "shadow",
            outcome: "selected",
            createdAt: "2026-10-29T20:00:00Z",
            score: 0.9123,
            current: { songId: 1, artist: "A", title: "One" },
            proposed: { songId: 2, artist: "B", title: "Two" },
            played: { songId: 3, artist: "C", title: "Three" },
          },
        ],
      }}
    />,
  );
  expect(screen.getByText(/4 of 10 enabled songs analyzed/)).toBeTruthy();
  expect(screen.getByText(/CC BY-NC-SA 4.0/)).toBeTruthy();
  expect(screen.getByText("B — Two")).toBeTruthy();
  expect(screen.getByText("C — Three")).toBeTruthy();
  expect(screen.getByText("0.912")).toBeTruthy();
});

it("saves the mode and threshold through the radio settings endpoint", async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") return new Response("{}", { status: 200 });
    if (String(url).endsWith("/settings"))
      return new Response(
        JSON.stringify({ similarityMode: "off", similarityThreshold: 0.8, similarityWindowSeconds: 30, similarityPool: "sequence" }),
      );
    if (String(url).includes("/coverage")) return new Response(JSON.stringify(coverage));
    return new Response("[]");
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<SongSimilarityPanel programId="radio-1" />);
  await screen.findByText(/4 of 10/);
  fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "shadow" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => {
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(put).toBeTruthy();
    expect(JSON.parse(String(put![1]!.body))).toMatchObject({ similarityMode: "shadow", similarityThreshold: 0.8 });
  });
  vi.unstubAllGlobals();
});

it("uploads embeddings in bounded batches and aggregates per-song results", async () => {
  const songs = Array.from({ length: UPLOAD_BATCH_SIZE + 3 }, (_, i) => ({ songId: i + 1 }));
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const sent = JSON.parse(String(init!.body)).songs as { songId: number }[];
    return new Response(JSON.stringify({ results: sent.map((s) => ({ songId: s.songId, status: "stored" })) }));
  });
  vi.stubGlobal("fetch", fetchMock);
  const results = await uploadSimilarityEmbeddings(
    "radio-1",
    JSON.stringify({ schema: 1, model: {}, windowSeconds: 30, songs }),
  );
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(results).toHaveLength(songs.length);
  await expect(uploadSimilarityEmbeddings("radio-1", "not json")).rejects.toThrow("not valid JSON");
  vi.unstubAllGlobals();
});
