import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModoItalianoBracketEditorFields } from "./ModoItalianoBracketEditorFields";
import type { SongCatalogItem } from "../../models/broadcast";

// gaulatti/alcantara#186: the Modo Italiano song-tournament bracket editor,
// through its props, the scene bracket API and what an operator sees.

// Radix positioning runs continuously in jsdom; keep Bleecker's string
// callback contract with a native select.
vi.mock("@gaulatti/bleecker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gaulatti/bleecker")>();
  return {
    ...actual,
    Select: ({ options, onChange, value, ...rest }: any) => (
      <select
        {...rest}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
});

const TYPE = "modoitaliano-bracket";
const song = (
  id: number,
  artist: string,
  title: string,
  enabled = true,
): SongCatalogItem => ({
  id,
  artist,
  title,
  audioUrl: `https://media.example.test/${id}.mp3`,
  coverUrl: null,
  durationMs: null,
  earoneSongId: null,
  earoneRank: null,
  earoneSpins: null,
  enabled,
});
const catalog = [
  song(1, "Mina", "Grande grande grande"),
  song(2, "Lucio Dalla", "Caruso"),
  song(3, "Raffaella Carrà", "Tanti auguri"),
  song(4, "Adriano Celentano", "Azzurro", false),
];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type Props = Parameters<typeof ModoItalianoBracketEditorFields>[0]["props"];
function editor(
  props: Props,
  extra: Partial<Parameters<typeof ModoItalianoBracketEditorFields>[0]> = {},
) {
  const updateProp = vi.fn();
  const view = render(
    <ModoItalianoBracketEditorFields
      componentType={TYPE}
      props={props}
      updateProp={updateProp}
      songCatalog={catalog}
      {...extra}
    />,
  );
  return { updateProp, view };
}

const matchCard = (label: string) =>
  screen.getByText(label).parentElement as HTMLElement;
const selects = (container: HTMLElement) =>
  within(container).getAllByRole("combobox") as HTMLSelectElement[];

it("edits the title, the overlay switch and the starting round", () => {
  const { updateProp } = editor({ title: "Torneo", show: false });
  fireEvent.change(screen.getByDisplayValue("Torneo"), {
    target: { value: "Torneo estivo" },
  });
  expect(updateProp).toHaveBeenCalledWith(TYPE, "title", "Torneo estivo");
  const show = screen.getByRole("checkbox", { name: "Show Bracket Overlay" });
  expect(show).not.toBeChecked();
  fireEvent.click(show);
  expect(updateProp).toHaveBeenCalledWith(TYPE, "show", true);
  const round = screen.getAllByRole("combobox")[0];
  expect(round).toHaveValue("roundOf16");
  fireEvent.change(round, { target: { value: "quarterfinals" } });
  expect(updateProp).toHaveBeenCalledWith(TYPE, "startRound", "quarterfinals");
  cleanup();
  editor({});
  expect(screen.getByPlaceholderText("TORNEO CANCIÓN")).toHaveValue("");
  expect(
    screen.getByRole("checkbox", { name: "Show Bracket Overlay" }),
  ).toBeChecked();
});

it("lists every round of sixteen match, and only the later rounds from the quarterfinals", () => {
  const { view } = editor({});
  expect(screen.getByText("Round of 16 - Match 1")).toBeInTheDocument();
  expect(screen.getByText("Quarter Final - Match 4")).toBeInTheDocument();
  expect(screen.getByText("Semi Final - Match 2")).toBeInTheDocument();
  expect(screen.getByText("Grand Final")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Draw Pool is available when the bracket starts at Quarterfinals.",
    ),
  ).toBeInTheDocument();
  // Later rounds wait for winners and cannot be picked by hand.
  expect(
    within(matchCard("Quarter Final - Match 1")).getAllByText(
      "Waiting for winner",
    ),
  ).toHaveLength(2);
  view.unmount();
  editor({ startRound: "quarterfinals" });
  expect(screen.queryByText("Round of 16 - Match 1")).toBeNull();
  expect(selects(matchCard("Quarter Final - Match 1"))).toHaveLength(3);
});

it("fills an opening match, offering each song only once across the openings", () => {
  const { updateProp } = editor({
    matches: [{ id: 1, songAId: 1, songBId: null, winnerId: null }],
  });
  const [songA, songB] = selects(matchCard("Round of 16 - Match 1"));
  expect(songA).toHaveValue("1");
  expect(
    within(songB).queryByRole("option", {
      name: "Mina - Grande grande grande",
    }),
  ).toBeNull();
  expect(
    within(selects(matchCard("Round of 16 - Match 2"))[0]).queryByRole(
      "option",
      { name: "Mina - Grande grande grande" },
    ),
  ).toBeNull();
  fireEvent.change(songB, { target: { value: "2" } });
  const matches = updateProp.mock.lastCall![2];
  expect(matches[0]).toMatchObject({ id: 1, songAId: 1, songBId: 2 });
  fireEvent.change(songA, { target: { value: "" } });
  expect(updateProp.mock.lastCall![2][0]).toMatchObject({ songAId: null });
  fireEvent.change(songA, { target: { value: "3" } });
  expect(updateProp.mock.lastCall![2][0]).toMatchObject({ songAId: 3 });
  fireEvent.change(songB, { target: { value: "" } });
  expect(updateProp.mock.lastCall![2][0]).toMatchObject({ songBId: null });
});

it("picks a winner from the two songs, which advances to the next round", () => {
  const { updateProp } = editor({
    matches: [{ id: 1, songAId: 1, songBId: 2, winnerId: null }],
  });
  const winner = selects(matchCard("Round of 16 - Match 1"))[2];
  expect(
    within(winner)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual([
    "-- Undecided --",
    "Mina - Grande grande grande",
    "Lucio Dalla - Caruso",
  ]);
  fireEvent.change(winner, { target: { value: "2" } });
  const matches = updateProp.mock.lastCall![2];
  expect(matches[0].winnerId).toBe(2);
  expect(matches[8].songAId).toBe(2);
  fireEvent.change(winner, { target: { value: "" } });
  expect(updateProp.mock.lastCall![2][0].winnerId).toBeNull();
});

it("names a later-round song missing from the catalog by its id", () => {
  editor({
    matches: [
      { id: 1, songAId: 1, songBId: 99, winnerId: 99 },
      { id: 2, songAId: 2, songBId: 3, winnerId: null },
    ],
  });
  expect(
    within(matchCard("Quarter Final - Match 1")).getByText("Song #99"),
  ).toBeInTheDocument();
});

it("builds the random song pool from searched catalog songs and clears it", () => {
  const { updateProp, view } = editor({});
  expect(
    screen.getByText("No songs selected for random picks yet."),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Clear Pool" })).toBeNull();
  expect(screen.getByText("Disabled")).toBeInTheDocument();
  const search = screen.getByPlaceholderText("Search songs by artist or title");
  fireEvent.change(search, { target: { value: "caruso" } });
  const results = screen.getByText("Songs").parentElement as HTMLElement;
  expect(within(results).getAllByRole("button", { name: "Add" })).toHaveLength(
    1,
  );
  fireEvent.click(within(results).getByRole("button", { name: "Add" }));
  expect(updateProp).toHaveBeenLastCalledWith(TYPE, "randomSongPoolIds", [2]);
  fireEvent.change(search, { target: { value: "nessuno" } });
  expect(screen.getByText("No matching songs.")).toBeInTheDocument();
  view.unmount();

  const pooled = editor({ randomSongPoolIds: [1, 2, 3, 4] });
  expect(screen.getByText("Selected (4)")).toBeInTheDocument();
  expect(screen.getByText("No more songs available.")).toBeInTheDocument();
  const selected = screen.getByText("Selected (4)")
    .parentElement as HTMLElement;
  fireEvent.click(
    within(selected).getAllByRole("button", { name: "Remove" })[0],
  );
  // The pool keeps the catalog order of the remaining songs.
  expect(pooled.updateProp).toHaveBeenLastCalledWith(
    TYPE,
    "randomSongPoolIds",
    expect.not.arrayContaining([1]),
  );
  fireEvent.click(screen.getByRole("button", { name: "Clear Pool" }));
  expect(pooled.updateProp).toHaveBeenLastCalledWith(
    TYPE,
    "randomSongPoolIds",
    [],
  );
});

it("sets the draw seed and duration, together where the scene supports it", () => {
  const { updateProp, view } = editor({ drawSeed: 7, drawDurationSeconds: 3 });
  const [seed, seconds] = screen.getAllByRole("spinbutton");
  expect(seed).toHaveValue(7);
  expect(seconds).toHaveValue(3);
  fireEvent.change(seed, { target: { value: "12" } });
  expect(updateProp).toHaveBeenCalledWith(TYPE, "drawSeed", 12);
  expect(updateProp).toHaveBeenCalledWith(TYPE, "drawDurationSeconds", 12);
  fireEvent.change(seconds, { target: { value: "0" } });
  expect(updateProp).toHaveBeenLastCalledWith(TYPE, "drawDurationSeconds", 7);
  view.unmount();
  const replaceProps = vi.fn();
  editor({ drawSeed: 7 }, { replaceProps });
  fireEvent.change(screen.getAllByRole("spinbutton")[0], {
    target: { value: "x" },
  });
  expect(replaceProps).toHaveBeenCalledWith(
    TYPE,
    expect.objectContaining({ drawSeed: 5, drawDurationSeconds: 5 }),
  );
});

it("draws one quarterfinal song from the pool through the scene, and waits for the draw to finish", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  vi.setSystemTime(1_000);
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}", { status: 200 }));
  editor(
    {
      startRound: "quarterfinals",
      randomSongPoolIds: [1, 2],
      drawSeed: 4,
      drawDurationSeconds: 2,
    },
    { sceneId: 31 },
  );
  const draw = screen.getByRole("button", { name: "Draw Pool" });
  expect(draw).toBeEnabled();
  await act(async () => {
    fireEvent.click(draw);
  });
  expect(transport).toHaveBeenCalledWith(
    expect.stringContaining("/scenes/31/modo-italiano-bracket/draw"),
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ componentType: TYPE, seed: 1_004 }),
    }),
  );
  expect(screen.getByRole("button", { name: "Drawing…" })).toBeDisabled();
  await act(async () => {
    vi.advanceTimersByTime(2_000);
  });
  expect(screen.getByRole("button", { name: "Draw Pool" })).toBeEnabled();
});

it("logs a draw the scene refused or could not receive", async () => {
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("{}", { status: 409 }))
    .mockRejectedValueOnce(new Error("offline"));
  editor(
    {
      startRound: "quarterfinals",
      randomSongPoolIds: [1],
      drawDurationSeconds: 1,
    },
    { sceneId: 31 },
  );
  fireEvent.click(screen.getByRole("button", { name: "Draw Pool" }));
  await waitFor(() =>
    expect(console.error).toHaveBeenCalledWith(
      "Failed to start Modo Italiano bracket draw:",
      expect.any(Error),
    ),
  );
  expect(transport).toHaveBeenCalledTimes(1);
});

it("does not draw without a saved scene, and asks for pool songs when none are unused", () => {
  const transport = vi.spyOn(globalThis, "fetch");
  const { view } = editor({
    startRound: "quarterfinals",
    randomSongPoolIds: [1],
  });
  fireEvent.click(screen.getByRole("button", { name: "Draw Pool" }));
  expect(transport).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Draw Pool" })).toBeEnabled();
  view.unmount();
  editor({
    startRound: "quarterfinals",
    matches: [{ id: 9, songAId: 1, songBId: null, winnerId: null }],
    randomSongPoolIds: [1],
  });
  expect(
    screen.getByText("Add unused songs to the pool before drawing."),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Draw Pool" })).toBeDisabled();
});

it("adds and removes voters, ignoring blank and malformed ones", () => {
  const { updateProp, view } = editor({
    voters: [
      { id: "v1", name: "Anna" },
      { id: "v1", name: "Anna again" },
      { id: "", name: "No id" },
      { id: "v2", name: "  " },
      null as never,
    ],
  });
  expect(screen.getByText("Anna")).toBeInTheDocument();
  expect(screen.queryByText("Anna again")).toBeNull();
  const name = screen.getByPlaceholderText("Voter name");
  fireEvent.keyDown(name, { key: "Enter" });
  expect(updateProp).not.toHaveBeenCalled();
  fireEvent.change(name, { target: { value: " Bruno " } });
  fireEvent.keyDown(name, { key: "a" });
  expect(updateProp).not.toHaveBeenCalled();
  fireEvent.keyDown(name, { key: "Enter" });
  expect(updateProp.mock.lastCall![2]).toEqual([
    { id: "v1", name: "Anna" },
    { id: expect.any(String), name: "Bruno" },
  ]);
  expect(name).toHaveValue("");
  fireEvent.change(name, { target: { value: "Carla" } });
  const voting = screen.getByText("Voting").parentElement!
    .parentElement as HTMLElement;
  fireEvent.click(within(voting).getAllByRole("button", { name: "Add" })[0]);
  expect(updateProp.mock.lastCall![2][1].name).toBe("Carla");
  fireEvent.click(within(voting).getByRole("button", { name: "Remove" }));
  expect(updateProp).toHaveBeenLastCalledWith(TYPE, "voters", []);
  view.unmount();
  editor({ voters: "nobody" as never });
  expect(screen.getByText("No voters have been added.")).toBeInTheDocument();
});

const votingProps = (extra: Partial<Props> = {}): Props => ({
  matches: [
    { id: 1, songAId: 1, songBId: 2, winnerId: null },
    { id: 2, songAId: 3, songBId: null, winnerId: null },
  ],
  voters: [
    { id: "v1", name: "Anna" },
    { id: "v2", name: "Bruno" },
    { id: "v3", name: "Carla" },
  ],
  ...extra,
});

it("opens voting on a match and records each ballot through the scene", async () => {
  const syncProps = vi.fn();
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("{}", { status: 200 }))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          metadata: JSON.stringify({
            [TYPE]: { matchVotes: { 1: { v1: 2 } } },
          }),
        }),
        { status: 200 },
      ),
    );
  editor(votingProps({ matchVotes: { 1: { v2: 1 } } }), {
    sceneId: 31,
    syncProps,
  });
  const card = matchCard("Round of 16 - Match 1");
  const vote = within(card).getByRole("button", { name: "Vote" });
  expect(
    within(matchCard("Round of 16 - Match 2")).getByRole("button", {
      name: "Vote",
    }),
  ).toBeDisabled();
  fireEvent.click(vote);
  expect(within(card).getByRole("button", { name: "Opening…" })).toBeDisabled();
  expect(await within(card).findByText("Ballots")).toBeInTheDocument();
  expect(transport).toHaveBeenCalledWith(
    expect.stringContaining("/scenes/31/modo-italiano-bracket/voting/open"),
    expect.objectContaining({
      body: JSON.stringify({ componentType: TYPE, matchId: 1 }),
    }),
  );
  // Match 1 lists voters in their saved order; Bruno already voted.
  const ballots = selects(card).slice(3);
  expect(
    ballots.map(
      (ballot) => ballot.closest("label")!.textContent!.split("--")[0],
    ),
  ).toEqual(["Anna", "Bruno", "Carla"]);
  expect(ballots[1]).toHaveValue("1");
  fireEvent.change(ballots[0], { target: { value: "2" } });
  expect(syncProps).toHaveBeenCalledWith(
    TYPE,
    expect.objectContaining({
      matchVotes: { 1: { v2: 1, v1: 2 } },
      activeVotingMatchId: 1,
      votingWinnerId: null,
    }),
  );
  await waitFor(() =>
    expect(syncProps).toHaveBeenLastCalledWith(TYPE, {
      matchVotes: { 1: { v1: 2 } },
    }),
  );
  expect(JSON.parse(String(transport.mock.calls[1][1]!.body))).toEqual({
    componentType: TYPE,
    matchId: 1,
    voterId: "v1",
    songId: 2,
  });
  // Vote again closes the ballots.
  fireEvent.click(within(card).getByRole("button", { name: "Vote" }));
  expect(within(card).queryByText("Ballots")).toBeNull();
});

it("rotates the ballot order from match to match", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("{}", { status: 200 }),
  );
  editor(
    votingProps({
      startRound: "quarterfinals",
      matches: [
        { id: 9, songAId: 1, songBId: 2, winnerId: null },
        { id: 10, songAId: 3, songBId: 4, winnerId: null },
      ],
    }),
    { sceneId: 31 },
  );
  const card = matchCard("Quarter Final - Match 2");
  fireEvent.click(within(card).getByRole("button", { name: "Vote" }));
  await within(card).findByText("Ballots");
  const order = selects(card)
    .slice(3)
    .map((ballot) => ballot.closest("label")!.textContent!.split("--")[0]);
  expect(order).toEqual(["Bruno", "Carla", "Anna"]);
});

it("keeps one voter in place, and clears a vote", async () => {
  const syncProps = vi.fn();
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("{}", { status: 200 }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ metadata: "{}" }), { status: 200 }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ metadata: 7 }), { status: 200 }),
    );
  editor(
    votingProps({
      voters: [{ id: "v1", name: "Anna" }],
      matchVotes: { 2: {} },
    }),
    { sceneId: 31, syncProps },
  );
  const card = matchCard("Round of 16 - Match 1");
  fireEvent.click(within(card).getByRole("button", { name: "Vote" }));
  await within(card).findByText("Ballots");
  const [ballot] = selects(card).slice(3);
  expect(ballot).toHaveValue("");
  fireEvent.change(ballot, { target: { value: "1" } });
  fireEvent.change(ballot, { target: { value: "" } });
  await waitFor(() => expect(syncProps).toHaveBeenCalledTimes(2));
  expect(syncProps.mock.calls[1][1].matchVotes).toEqual({
    1: { v1: null },
    2: {},
  });
});

it("restores the ballots when a vote is refused, and records nothing without a scene or a sync action", async () => {
  const syncProps = vi.fn();
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("{}", { status: 200 }))
    .mockResolvedValueOnce(new Response("{}", { status: 409 }));
  const props = votingProps();
  const { view } = editor(props, { sceneId: 31, syncProps });
  const card = matchCard("Round of 16 - Match 1");
  fireEvent.click(within(card).getByRole("button", { name: "Vote" }));
  await within(card).findByText("Ballots");
  fireEvent.change(selects(card)[3], { target: { value: "1" } });
  await waitFor(() => expect(syncProps).toHaveBeenLastCalledWith(TYPE, props));
  expect(console.error).toHaveBeenCalledWith(
    "Failed to save Modo Italiano bracket vote:",
    expect.any(Error),
  );
  view.unmount();

  transport
    .mockResolvedValueOnce(new Response("{}", { status: 200 }))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ metadata: JSON.stringify({ [TYPE]: {} }) }),
        { status: 200 },
      ),
    );
  editor(props, { sceneId: 31 });
  const unsynced = matchCard("Round of 16 - Match 1");
  fireEvent.click(within(unsynced).getByRole("button", { name: "Vote" }));
  await within(unsynced).findByText("Ballots");
  fireEvent.change(selects(unsynced)[3], { target: { value: "1" } });
  await waitFor(() => expect(transport).toHaveBeenCalledTimes(4));
  cleanup();

  // Without a scene, voting cannot open.
  editor(props);
  fireEvent.click(
    within(matchCard("Round of 16 - Match 1")).getByRole("button", {
      name: "Vote",
    }),
  );
  expect(transport).toHaveBeenCalledTimes(4);
});

it("logs voting that could not open", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response("{}", { status: 500 }),
  );
  editor(votingProps(), { sceneId: 31 });
  const card = matchCard("Round of 16 - Match 1");
  fireEvent.click(within(card).getByRole("button", { name: "Vote" }));
  await waitFor(() =>
    expect(console.error).toHaveBeenCalledWith(
      "Failed to open Modo Italiano bracket voting:",
      expect.any(Error),
    ),
  );
  expect(within(card).queryByText("Ballots")).toBeNull();
  expect(within(card).getByRole("button", { name: "Vote" })).toBeEnabled();
});

it("resets the bracket through the richest action the scene offers", () => {
  const props = votingProps({ title: "Torneo" });
  const reset = (
    extra: Partial<Parameters<typeof ModoItalianoBracketEditorFields>[0]>,
  ) => {
    const result = editor(props, extra);
    fireEvent.click(screen.getByRole("button", { name: "Reset Bracket" }));
    result.view.unmount();
    return result.updateProp;
  };
  const commitProps = vi.fn();
  reset({ commitProps, replaceProps: vi.fn() });
  expect(commitProps).toHaveBeenCalledWith(
    TYPE,
    expect.objectContaining({
      title: "Torneo",
      drawCommand: null,
      matchVotes: {},
      activeVotingMatchId: null,
      votingWinnerId: null,
      votingResultStartedAt: null,
    }),
  );
  expect(
    commitProps.mock.lastCall![1].matches.every(
      (match: any) => match.songAId === null,
    ),
  ).toBe(true);
  const replaceProps = vi.fn();
  reset({ replaceProps });
  expect(replaceProps).toHaveBeenCalledWith(
    TYPE,
    expect.objectContaining({ matchVotes: {} }),
  );
  const updateProp = reset({});
  expect(updateProp).toHaveBeenCalledWith(TYPE, "matchVotes", {});
  expect(updateProp).toHaveBeenCalledWith(TYPE, "title", "Torneo");
});

it("records no ballot once the scene is gone", async () => {
  const syncProps = vi.fn();
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}", { status: 200 }));
  const props = votingProps();
  const { view } = editor(props, { sceneId: 31, syncProps });
  const card = matchCard("Round of 16 - Match 1");
  fireEvent.click(within(card).getByRole("button", { name: "Vote" }));
  await within(card).findByText("Ballots");
  view.rerender(
    <ModoItalianoBracketEditorFields
      componentType={TYPE}
      props={props}
      updateProp={vi.fn()}
      songCatalog={catalog}
      syncProps={syncProps}
    />,
  );
  fireEvent.change(selects(matchCard("Round of 16 - Match 1"))[3], {
    target: { value: "1" },
  });
  expect(syncProps).not.toHaveBeenCalled();
  expect(transport).toHaveBeenCalledTimes(1);
});
