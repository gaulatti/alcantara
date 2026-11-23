import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SongSimilarityPanel } from "./SongSimilarityPanel";
import { UPLOAD_BATCH_SIZE, uploadSimilarityEmbeddings } from "../services/similarity";

// Radix positioning runs continuously in jsdom; keep Bleecker's string callback
// contract with a native select, as the other Bleecker-select tests in this repo do.
vi.mock("@gaulatti/bleecker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gaulatti/bleecker")>();
  return {
    ...actual,
    Select: ({ options, onChange, value, ...rest }: any) => (
      <select {...rest} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option: any) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
});

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

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
/** A fetch stub that answers each similarity endpoint like the radio API. */
function radioApi(routes: Partial<Record<string, Route>> = {}) {
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const key =
      init?.method === "PUT"
        ? "save"
        : init?.method === "POST"
          ? "upload"
          : url.includes("/similarity/export")
            ? "export"
            : url.includes("/similarity/coverage")
              ? "coverage"
              : url.includes("/similarity/decisions")
                ? "decisions"
                : "settings";
    const route = routes[key];
    if (route) return route(url, init);
    if (key === "coverage") return new Response(JSON.stringify(coverage));
    if (key === "decisions") return new Response("[]");
    if (key === "settings") return new Response("null");
    return new Response("{}");
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

/** A chosen file; jsdom's File lacks the browser's text(), so it is attached here. */
const chosenFile = (content: string) =>
  Object.assign(new File([content], "embeddings.json", { type: "application/json" }), {
    text: async () => content,
  });

it("keeps the default settings when the program has none, and validates edits before saving", async () => {
  radioApi({
    coverage: () =>
      new Response(JSON.stringify({ ...coverage, embeddedSongs: 10, missingSongs: 0 })),
  });
  render(<SongSimilarityPanel programId="radio-1" />);
  expect(
    await screen.findByText(/10 of 10 enabled songs analyzed at 30s\.$/),
  ).toBeTruthy();
  expect(screen.getByLabelText("Mode")).toHaveValue("off");
  expect(screen.getByText(/Selection is unchanged\./)).toBeTruthy();
  expect(
    screen.getByText(
      "No decisions recorded yet. Set the mode to Shadow to start recording.",
    ),
  ).toBeTruthy();

  const save = screen.getByRole("button", { name: "Save" });
  const threshold = screen.getByLabelText("Threshold (−1 to 1)");
  const windowField = screen.getByLabelText("Window (seconds)");
  fireEvent.change(threshold, { target: { value: "1.5" } });
  expect(save).toBeDisabled();
  fireEvent.change(threshold, { target: { value: "-1.5" } });
  expect(save).toBeDisabled();
  fireEvent.change(threshold, { target: { value: "" } });
  expect(save).toBeDisabled();
  fireEvent.change(threshold, { target: { value: "0.5" } });
  expect(save).toBeEnabled();
  for (const value of ["4", "121", "7.5"]) {
    fireEvent.change(windowField, { target: { value } });
    expect(save).toBeDisabled();
  }
  fireEvent.change(windowField, { target: { value: "60" } });
  fireEvent.change(screen.getByLabelText("Candidates"), {
    target: { value: "catalog" },
  });
  fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "on" } });
  expect(screen.getByText(/The closest passing song plays next/)).toBeTruthy();
  expect(save).toBeEnabled();
});

it("reports a failed load, and a fallback for an unnamed one", async () => {
  radioApi({
    coverage: () =>
      new Response(JSON.stringify({ message: "Coverage store offline" }), {
        status: 503,
      }),
  });
  const first = render(<SongSimilarityPanel programId="radio-1" />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Coverage store offline",
  );
  first.unmount();
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject("offline")));
  render(<SongSimilarityPanel programId="radio-1" />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Similarity unavailable.",
  );
});

it("exports the songs to analyze as a JSON download for the chosen scope", async () => {
  const fetchMock = radioApi({
    export: () => new Response(JSON.stringify({ songs: [{ songId: 1 }] })),
  });
  const createObjectURL = vi.fn(() => "blob:songs");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("songs-to-analyze.json");
      expect(this.href).toBe("blob:songs");
    });
  render(<SongSimilarityPanel programId="radio-1" />);
  await screen.findByText(/4 of 10/);
  fireEvent.change(screen.getByLabelText("Export scope"), {
    target: { value: "catalog" },
  });
  fireEvent.click(screen.getByLabelText("Only songs without embeddings"));
  fireEvent.click(screen.getByRole("button", { name: "Export songs to analyze" }));
  await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  expect(
    fetchMock.mock.calls.some(([url]) =>
      String(url).includes("/similarity/export?scope=catalog&missingOnly=false"),
    ),
  ).toBe(true);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:songs");
});

it("uploads an embeddings file and summarizes stored and rejected songs", async () => {
  radioApi({
    upload: (_url, init) => {
      const sent = JSON.parse(String(init!.body)).songs as { songId?: number }[];
      return new Response(
        JSON.stringify({
          results: sent.map((s, i) =>
            i === 0
              ? { songId: s.songId, status: "stored" }
              : { songId: s.songId, status: "rejected", reason: "wrong window" },
          ),
        }),
      );
    },
  });
  render(<SongSimilarityPanel programId="radio-1" />);
  await screen.findByText(/4 of 10/);
  const input = screen.getByLabelText("Upload embeddings.json") as HTMLInputElement;
  const songs = [1, 2, 3, 4, 5, 6, undefined].map((songId) => ({ songId }));
  const file = chosenFile(
    JSON.stringify({ schema: 1, model: {}, windowSeconds: 30, songs }),
  );
  fireEvent.change(input, { target: { files: [file] } });
  expect(
    await screen.findByText(
      "1 stored, 6 rejected. #2: wrong window; #3: wrong window; #4: wrong window; #5: wrong window; #6: wrong window",
    ),
  ).toBeTruthy();
  expect(input.value).toBe("");

  // Choosing no file does nothing.
  fireEvent.change(input, { target: { files: [] } });
  expect(screen.getByText(/1 stored, 6 rejected/)).toBeTruthy();
});

it("names a song without an id in the rejection summary, and reports a file it cannot read", async () => {
  radioApi({
    upload: () =>
      new Response(
        JSON.stringify({ results: [{ status: "rejected", reason: "no id" }] }),
      ),
  });
  render(<SongSimilarityPanel programId="radio-1" />);
  await screen.findByText(/4 of 10/);
  const input = screen.getByLabelText("Upload embeddings.json");
  fireEvent.change(input, {
    target: {
      files: [chosenFile(JSON.stringify({ songs: [{}] }))],
    },
  });
  expect(await screen.findByText("0 stored, 1 rejected. #?: no id")).toBeTruthy();
  fireEvent.change(input, {
    target: { files: [chosenFile("not json")] },
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The file is not valid JSON.",
  );
});

it("says when a save fails without a reason, and lists a decision with nothing proposed", async () => {
  radioApi({
    save: () => Promise.reject("network down"),
    decisions: () =>
      new Response(
        JSON.stringify([
          {
            id: 9,
            mode: "shadow",
            outcome: "fallback",
            createdAt: "2026-10-29T20:00:00Z",
            score: null,
            current: { songId: 1, artist: "A", title: "One" },
            proposed: null,
            played: { songId: 3, artist: "C", title: "Three" },
          },
        ]),
      ),
  });
  render(<SongSimilarityPanel programId="radio-1" />);
  expect(await screen.findByText("fallback")).toBeTruthy();
  const row = screen.getByText("fallback").closest("tr")!;
  expect(row).toHaveTextContent(/A — One\s*—\s*—\s*C — Three/);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Request failed.");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("reports a clean upload with no rejections, then reloads coverage", async () => {
  const fetchMock = radioApi({
    upload: () =>
      new Response(
        JSON.stringify({
          results: [
            { songId: 1, status: "stored" },
            { songId: 2, status: "stored" },
          ],
        }),
      ),
  });
  render(<SongSimilarityPanel programId="radio-1" />);
  await screen.findByText(/4 of 10/);
  const coverageCalls = () =>
    fetchMock.mock.calls.filter(([url]) => String(url).includes("/coverage"))
      .length;
  const before = coverageCalls();
  fireEvent.change(screen.getByLabelText("Upload embeddings.json"), {
    target: {
      files: [chosenFile(JSON.stringify({ songs: [{ songId: 1 }, { songId: 2 }] }))],
    },
  });
  expect(await screen.findByText("2 stored, 0 rejected.")).toBeTruthy();
  await waitFor(() => expect(coverageCalls()).toBe(before + 1));
});

// gaulatti/alcantara#392 (audit of #350): the Bleecker controls submit what the native ones did.
it("saves the mode, candidates, threshold and window together in one payload", async () => {
  const fetchMock = radioApi({
    settings: () =>
      new Response(
        JSON.stringify({ similarityMode: "off", similarityThreshold: 0.8, similarityWindowSeconds: 30, similarityPool: "sequence" }),
      ),
    save: () => new Response("{}"),
  });
  render(<SongSimilarityPanel programId="radio-1" />);
  await screen.findByText(/4 of 10/);
  fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "on" } });
  fireEvent.change(screen.getByLabelText("Candidates"), { target: { value: "catalog" } });
  fireEvent.change(screen.getByLabelText("Threshold (−1 to 1)"), { target: { value: "0.6" } });
  fireEvent.change(screen.getByLabelText("Window (seconds)"), { target: { value: "45" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true));
  const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
  expect(JSON.parse(String(put[1]!.body))).toEqual({
    similarityMode: "on",
    similarityPool: "catalog",
    similarityThreshold: 0.6,
    similarityWindowSeconds: 45,
  });
});

it("exports only the songs without embeddings by default and every song once the box is cleared", async () => {
  const fetchMock = radioApi({ export: () => new Response(JSON.stringify({ songs: [] })) });
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  render(<SongSimilarityPanel programId="radio-1" />);
  await screen.findByText(/4 of 10/);
  const exportButton = screen.getByRole("button", { name: "Export songs to analyze" });
  fireEvent.click(exportButton);
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/similarity/export?scope=sequence&missingOnly=true"))).toBe(true),
  );
  fireEvent.click(screen.getByLabelText("Only songs without embeddings"));
  fireEvent.click(exportButton);
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/similarity/export?scope=sequence&missingOnly=false"))).toBe(true),
  );
});
