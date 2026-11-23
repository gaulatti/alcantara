import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModoItalianoBracket } from "./ModoItalianoBracket";

const songsMock = vi.hoisted(() => ({ fetchSongCatalog: vi.fn() }));
vi.mock("../services/songs", () => songsMock);

const song = (id: number, cover: string | null = `http://c/${id}.jpg`) => ({
  id,
  artist: `Artist ${id}`,
  title: `Title ${id}`,
  audioUrl: "",
  coverUrl: cover,
  durationMs: null,
  earoneSongId: null,
  earoneRank: null,
  earoneSpins: null,
  enabled: true,
});
const catalog = [song(1), song(2), song(3, null), song(4), song(5), song(6), song(7), song(8)];
const matches = (overrides: Record<number, Partial<{ songAId: number | null; songBId: number | null; winnerId: number | null }>> = {}) =>
  Array.from({ length: 15 }, (_, i) => ({ id: i + 1, songAId: null, songBId: null, winnerId: null, ...overrides[i + 1] }));
const mount = async (props: Parameters<typeof ModoItalianoBracket>[0] = {}) => {
  const view = render(<ModoItalianoBracket {...props} />);
  await act(async () => {});
  return view;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  songsMock.fetchSongCatalog.mockReset().mockResolvedValue(catalog);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ModoItalianoBracket", () => {
  it("renders nothing when hidden", async () => {
    const { container } = await mount({ show: false });
    expect(container).toBeEmptyDOMElement();
  });

  it("draws an empty round of 16 with TBD slots and an empty champion", async () => {
    const { container } = await mount();
    expect(screen.getAllByText("TBD").length).toBeGreaterThan(8);
    expect(screen.getByText("Gran Final")).toBeInTheDocument();
    expect(screen.getByText("CAMPEÓN").parentElement).toHaveClass("opacity-30");
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it("starts at the quarterfinals without the first-round columns", async () => {
    const full = await mount({ startRound: "roundOf16" });
    const fullCount = full.container.querySelectorAll(".flex-col.justify-around").length;
    cleanup();
    const qf = await mount({ startRound: "quarterfinals" });
    expect(qf.container.querySelectorAll(".flex-col.justify-around").length).toBeLessThan(fullCount);
  });

  it("shows songs with covers, marks winners, dims losers and crowns the champion", async () => {
    const { container } = await mount({
      startRound: "quarterfinals",
      matches: matches({
        9: { songAId: 1, songBId: 2, winnerId: 1 },
        10: { songAId: 3, songBId: 4, winnerId: 4 },
        11: { songAId: 5, songBId: 6, winnerId: 5 },
        12: { songAId: 7, songBId: 8, winnerId: 8 },
        13: { winnerId: 4 },
        14: { winnerId: 5 },
        15: { winnerId: 5 },
      }),
    });
    expect(screen.getAllByText("Artist 1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Title 5").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".bg-red-600").length).toBe(6);
    expect(container.querySelectorAll(".bg-\\[\\#e2a842\\]").length).toBe(1);
    expect(container.querySelector('img[class*="border-[#e2a842]"]')).toHaveAttribute("src", "http://c/5.jpg");
    expect(screen.getByText("CAMPEÓN").parentElement).not.toHaveClass("opacity-30");
  });

  it("crowns a champion without a cover without drawing an image", async () => {
    const { container } = await mount({
      startRound: "quarterfinals",
      matches: matches({
        9: { songAId: 1, songBId: 2 },
        10: { songAId: 3, songBId: 4, winnerId: 3 },
        11: { songAId: 5, songBId: 6, winnerId: 5 },
        12: { songAId: 7, songBId: 8 },
        13: { winnerId: 3 },
        14: { winnerId: 5 },
        15: { winnerId: 3 },
      }),
    });
    expect(container.querySelector('img[class*="border-[#e2a842]"]')).toBeNull();
    expect(screen.getByText("CAMPEÓN").parentElement).not.toHaveClass("opacity-30");
  });

  it("logs a failed catalogue fetch and still renders", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    songsMock.fetchSongCatalog.mockRejectedValue(new Error("down"));
    await mount();
    expect(error).toHaveBeenCalledWith("Failed to fetch songs for bracket:", expect.any(Error));
    expect(screen.getByText("Gran Final")).toBeInTheDocument();
  });
});

describe("draw overlay", () => {
  const drawCommand = { id: 1, seed: 7, startedAt: 0, durationSeconds: 5, songIds: [1, 2, 99], selectedSongId: null };

  it("cycles through the drawn songs, advances progress and disappears when it ends", async () => {
    const { container } = await mount({ drawCommand });
    expect(screen.getByText("SORTEO")).toBeInTheDocument();
    expect(container.querySelector(".modoitaliano-bracket-draw-cover")).not.toBeNull();
    await act(async () => void vi.advanceTimersByTime(2500));
    const bar = container.querySelector<HTMLElement>(".modoitaliano-bracket-draw-progress")!;
    expect(parseFloat(bar.style.width)).toBeGreaterThan(40);
    await act(async () => void vi.advanceTimersByTime(3000));
    expect(screen.queryByText("SORTEO")).toBeNull();
  });

  it("shows placeholders when no drawn song is in the catalogue and no cover", async () => {
    await mount({ drawCommand: { ...drawCommand, songIds: [98, 99] } });
    expect(screen.getByText("Seleccionando")).toBeInTheDocument();
    expect(screen.getByText("Canciones")).toBeInTheDocument();
  });

  it("shows a drawn song without a cover", async () => {
    const { container } = await mount({ drawCommand: { ...drawCommand, songIds: [3] } });
    expect(screen.getByText("Artist 3")).toBeInTheDocument();
    expect(container.querySelector(".modoitaliano-bracket-draw-cover")).toBeNull();
  });

  it("restarts for a new draw id and stops when the command is removed", async () => {
    const { rerender } = await mount({ drawCommand });
    await act(async () => void vi.advanceTimersByTime(6000));
    expect(screen.queryByText("SORTEO")).toBeNull();
    rerender(<ModoItalianoBracket drawCommand={{ ...drawCommand, id: 2 }} />);
    await act(async () => {});
    expect(screen.getByText("SORTEO")).toBeInTheDocument();
    rerender(<ModoItalianoBracket />);
    await act(async () => {});
    expect(screen.queryByText("SORTEO")).toBeNull();
  });
});

describe("voting overlay", () => {
  const voters = [
    { id: "a", name: "Ana" },
    { id: "b", name: "Beto" },
    { id: "c", name: "Cleo" },
    { id: "bad", name: "  " },
  ] as any;
  const names = (c: HTMLElement) => [...c.querySelectorAll(".modoitaliano-bracket-voting-name")].map((n) => n.textContent);
  // Round of 16: match 9 is fed by the winners of 1 and 2.
  const feeder = (winner9: number | null = null) =>
    matches({
      1: { songAId: 1, songBId: 2, winnerId: 1 },
      2: { songAId: 3, songBId: 4, winnerId: 3 },
      9: { winnerId: winner9 },
    });
  const qf = matches({ 10: { songAId: 3, songBId: 4 } });

  it("rotates the voters for later matches and shows revealed votes", async () => {
    const { container } = await mount({
      startRound: "quarterfinals",
      matches: qf,
      voters: [...voters, null],
      matchVotes: { "10": { a: 3, b: null, c: 4 } },
      activeVotingMatchId: 10,
    });
    expect(screen.getByText("VOTACIÓN")).toBeInTheDocument();
    expect(names(container)).toEqual(["Beto", "Cleo", "Ana"]);
    expect(container.querySelectorAll(".modoitaliano-bracket-voting-cover-reveal")).toHaveLength(2);
    expect(container.querySelector(".modoitaliano-bracket-voting-cover-reveal img")).not.toBeNull();
    expect(container.querySelector(".modoitaliano-bracket-voting-grid")).toHaveStyle({ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" });
  });

  it("does not rotate for the first match of a round of 16", async () => {
    const { container } = await mount({
      matches: matches({ 1: { songAId: 3, songBId: 2 } }),
      voters,
      activeVotingMatchId: 1,
    });
    expect(names(container)).toEqual(["Ana", "Beto", "Cleo"]);
  });

  it("rotates by the match position in a round of 16", async () => {
    const { container } = await mount({ matches: feeder(), voters, activeVotingMatchId: 9 });
    expect(names(container)).toEqual(["Cleo", "Ana", "Beto"]);
  });

  it("stays hidden without voters, without both songs, or when decided without a result", async () => {
    await mount({ startRound: "quarterfinals", matches: qf, voters: [], activeVotingMatchId: 10 });
    expect(screen.queryByText("VOTACIÓN")).toBeNull();
    cleanup();
    await mount({ startRound: "quarterfinals", matches: matches({ 10: { songAId: 3 } }), voters, activeVotingMatchId: 10 });
    expect(screen.queryByText("VOTACIÓN")).toBeNull();
    cleanup();
    await mount({ startRound: "quarterfinals", matches: matches({ 10: { songAId: 3, songBId: 4, winnerId: 3 } }), voters, activeVotingMatchId: 10 });
    expect(screen.queryByText("VOTACIÓN")).toBeNull();
  });

  it("reveals the winner for ten seconds then hides the modal", async () => {
    const { container } = await mount({
      matches: feeder(1),
      voters,
      activeVotingMatchId: 9,
      votingWinnerId: 1,
      votingResultStartedAt: Date.now(),
    });
    expect(screen.getByText("WINNER")).toBeInTheDocument();
    expect(screen.getByText("Artist 1 - Title 1")).toBeInTheDocument();
    expect(container.querySelector(".modoitaliano-bracket-voting-winner img")).toHaveAttribute("src", "http://c/1.jpg");
    await act(async () => void vi.advanceTimersByTime(10_500));
    expect(screen.queryByText("WINNER")).toBeNull();
  });

  it("reveals a winner without a cover, and one missing from the catalogue", async () => {
    const props = { matches: feeder(3), voters, activeVotingMatchId: 9, votingWinnerId: 3, votingResultStartedAt: Date.now() };
    const { container } = await mount(props);
    expect(screen.getByText("Artist 3 - Title 3")).toBeInTheDocument();
    expect(container.querySelector(".modoitaliano-bracket-voting-winner img")).toBeNull();
    cleanup();
    songsMock.fetchSongCatalog.mockResolvedValue([]);
    await mount(props);
    expect(screen.getByText("Winner")).toBeInTheDocument();
  });

  it("ignores a result start time that is not positive", async () => {
    await mount({ matches: feeder(1), voters, activeVotingMatchId: 9, votingWinnerId: 1, votingResultStartedAt: 0 });
    expect(screen.queryByText("WINNER")).toBeNull();
  });
});
