import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RecoveryPlaylistPanel } from "./RecoveryPlaylistPanel";

// gaulatti/alcantara#184: the prepared local recovery playlist, through the
// radio API it reads and writes.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const song = (id: number, enabled = true) => ({
  id,
  artist: `Artist ${id}`,
  title: `Song ${id}`,
  audioUrl: `https://media.example.test/${id}.mp3`,
  coverUrl: null,
  durationMs: null,
  earoneSongId: null,
  earoneRank: null,
  earoneSpins: null,
  enabled,
});

const recovery = (overrides: Record<string, unknown> = {}) => ({
  selectedSongIds: [1],
  preparedVersion: "recovery-v1",
  automation: null,
  connection: "connected",
  ...overrides,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

type Answer = Response | (() => Response | Promise<Response>);
function radioApi(answers: { songs?: Answer; status?: Answer; prepare?: Answer }) {
  const resolve = (answer: Answer | undefined, fallback: Response) =>
    answer === undefined ? fallback : typeof answer === "function" ? answer() : answer;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/songs?")) {
      return resolve(answers.songs, json({ data: [song(1), song(2), song(3, false)] }));
    }
    if (url.includes("/recovery/prepare")) {
      return resolve(answers.prepare, json(recovery()));
    }
    return resolve(answers.status, json(recovery()));
  });
}

it("lists enabled catalog songs with the saved selection and its prepared state", async () => {
  radioApi({});
  render(<RecoveryPlaylistPanel programId="radio 1" />);
  const first = await screen.findByLabelText("Artist 1 — Song 1");
  expect(first).toBeChecked();
  expect(screen.getByLabelText("Artist 2 — Song 2")).not.toBeChecked();
  expect(screen.queryByLabelText("Artist 3 — Song 3")).toBeNull();
  expect(screen.getByText("Prepared")).toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual(
    expect.arrayContaining([expect.stringContaining("/radio/radio%201/recovery")]),
  );
  expect(screen.queryByText(/Selection changed/)).toBeNull();
  fireEvent.click(first);
  expect(first).not.toBeChecked();
  expect(screen.getByText(/Selection changed/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Prepare playlist" })).toBeDisabled();
});

it("prepares a changed selection in Palazzo and flags it until then", async () => {
  const transport = radioApi({
    prepare: () => json(recovery({ selectedSongIds: [1, 2], preparedVersion: "recovery-v2" })),
  });
  render(<RecoveryPlaylistPanel programId="radio-1" />);
  fireEvent.click(await screen.findByLabelText("Artist 2 — Song 2"));
  expect(
    screen.getByText("Selection changed. Prepare it before starting a new session."),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Prepare playlist" }));
  expect(screen.getByRole("button", { name: "Preparing in Palazzo…" })).toBeDisabled();
  await waitFor(() => expect(screen.queryByText(/Selection changed/)).toBeNull());
  const prepareCall = transport.mock.calls.find(([url]) =>
    String(url).includes("/recovery/prepare"),
  )!;
  expect(prepareCall[1]).toMatchObject({ method: "POST" });
  expect(JSON.parse(String(prepareCall[1]!.body))).toEqual({ songIds: [1, 2] });
  expect(screen.getByRole("button", { name: "Prepare playlist" })).toBeEnabled();
});

it("needs at least one song and at most a hundred", async () => {
  const many = Array.from({ length: 101 }, (_, index) => song(index + 1));
  radioApi({
    songs: json({ data: many }),
    status: json(recovery({ selectedSongIds: many.slice(0, 100).map((s) => s.id), preparedVersion: null })),
  });
  render(<RecoveryPlaylistPanel programId="radio-1" />);
  expect(await screen.findByText("Not prepared")).toBeInTheDocument();
  const prepare = screen.getByRole("button", { name: "Prepare playlist" });
  await waitFor(() => expect(prepare).toBeEnabled());
  fireEvent.click(screen.getByLabelText("Artist 101 — Song 101"));
  expect(prepare).toBeDisabled();
  cleanup();

  radioApi({ status: json(recovery({ selectedSongIds: [] })) });
  render(<RecoveryPlaylistPanel programId="radio-1" />);
  await screen.findByLabelText("Artist 1 — Song 1");
  expect(screen.getByRole("button", { name: "Prepare playlist" })).toBeDisabled();
});

it("says when Palazzo is unavailable, and when a recovery playlist is active", async () => {
  radioApi({ status: json(recovery({ connection: "unavailable" })) });
  const view = render(<RecoveryPlaylistPanel programId="radio-1" />);
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Palazzo is unavailable. The saved selection is shown",
  );
  view.unmount();

  radioApi({
    status: json(
      recovery({
        automation: { actualState: "running", filler: { activeVersion: "recovery-v1", ready: true } },
      }),
    ),
  });
  render(<RecoveryPlaylistPanel programId="radio-1" />);
  expect(
    await screen.findByText("A recovery playlist is active in the current Palazzo session."),
  ).toBeInTheDocument();
});

it("reports an unreadable catalog, an unreadable configuration and an empty catalog", async () => {
  radioApi({ songs: json({}, 503) });
  const first = render(<RecoveryPlaylistPanel programId="radio-1" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Catalog songs are unavailable.");
  first.unmount();

  radioApi({ songs: json({ data: "not a list" }), status: json({}, 502) });
  render(<RecoveryPlaylistPanel programId="radio-1" />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Recovery configuration is unavailable.",
  );
  expect(screen.getByText("No enabled catalog songs are available.")).toBeInTheDocument();
});

it("explains a refused preparation with the server's reason or its status", async () => {
  let attempt = 0;
  radioApi({
    prepare: () =>
      ++attempt === 1
        ? json({ message: "Song 2 could not be downloaded" }, 422)
        : attempt === 2
          ? new Response("not json", { status: 500 })
          : json({ message: ["not", "a", "string"] }, 400),
  });
  render(<RecoveryPlaylistPanel programId="radio-1" />);
  await screen.findByLabelText("Artist 1 — Song 1");
  const prepare = screen.getByRole("button", { name: "Prepare playlist" });
  fireEvent.click(prepare);
  expect(await screen.findByRole("alert")).toHaveTextContent("Song 2 could not be downloaded");
  fireEvent.click(prepare);
  expect(await screen.findByRole("alert")).toHaveTextContent("Preparation failed (500)");
  fireEvent.click(prepare);
  expect(await screen.findByRole("alert")).toHaveTextContent("Preparation failed (400)");
});

it("uses fallback messages for failures without a reason, and refreshes on request", async () => {
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValueOnce("offline")
    .mockRejectedValueOnce("offline");
  render(<RecoveryPlaylistPanel programId="radio-1" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Recovery status failed.");

  transport.mockImplementation(() => Promise.reject("offline"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  await waitFor(() => expect(transport.mock.calls.length).toBeGreaterThan(2));
  expect(screen.getByRole("alert")).toHaveTextContent("Recovery status failed.");

  transport.mockImplementation(() => Promise.reject(new Error("DNS failure")));
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  expect(await screen.findByText("DNS failure")).toBeInTheDocument();

  transport.mockImplementation(async (input) =>
    String(input).includes("/songs?")
      ? json({ data: [song(1)] })
      : json(recovery()),
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  expect(await screen.findByLabelText("Artist 1 — Song 1")).toBeChecked();

  transport.mockImplementation(() => Promise.reject("offline"));
  fireEvent.click(screen.getByRole("button", { name: "Prepare playlist" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Recovery preparation failed.");
});

// gaulatti/alcantara#20: with a program radio filler configured this older path is not a failure: it is done.
it("says the program radio filler is in use instead of offering the older playlist", async () => {
  radioApi({ status: json(recovery({ preparedVersion: "filler-radio-1", programFillerVersion: "filler-radio-1" })) });
  render(<RecoveryPlaylistPanel programId="radio-1" />);
  expect(await screen.findByText(/program radio filler is in use/)).toBeInTheDocument();
  expect(screen.getByText("Prepared")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Prepare playlist" })).toBeNull();
});

it("treats a refused preparation, filler configured meanwhile, as already prepared", async () => {
  let configured = false;
  radioApi({
    status: () => json(recovery(configured ? { programFillerVersion: "filler-radio-1" } : {})),
    prepare: () => {
      configured = true;
      return json({ message: "the radio filler is managed by the program filler configuration" }, 409);
    },
  });
  render(<RecoveryPlaylistPanel programId="radio-1" />);
  fireEvent.click(await screen.findByLabelText("Artist 2 — Song 2"));
  fireEvent.click(screen.getByRole("button", { name: "Prepare playlist" }));
  expect(await screen.findByText(/program radio filler is in use/)).toBeInTheDocument();
  expect(screen.queryByRole("alert")).toBeNull();
});
