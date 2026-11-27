import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlayoutMode } from "./PlayoutMode";

// gaulatti/alcantara#404 (PlayoutMode, outside the #404 list): the desk's playback mode, shuffle and loop controls.

afterEach(cleanup);

const song = (id: string) => ({
  id,
  kind: "preset" as const,
  songId: Number(id.slice(1)),
  artist: "Fictional artist",
  title: `Song ${id}`,
  coverUrl: "",
  audioUrl: `https://media.example.test/${id}.mp3`,
  durationMs: 180_000,
});
const sequence = (items = [song("s1"), song("s2")], overrides = {}) => ({
  mode: "manual" as const,
  loop: true,
  items,
  activeItemId: "s1",
  startedAt: 0,
  ...overrides,
});

it("sets the playback mode to manual or autoplay and stamps the change", () => {
  const onChange = vi.fn();
  render(<PlayoutMode sequence={sequence()} activeItemId="s1" playing={false} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: /autoplay/i }));
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "autoplay", activeItemId: "s1" }));
  fireEvent.click(screen.getByRole("button", { name: /manual/i }));
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "manual" }));
});

it("shuffles a playlist of two or more songs, and starts it when it is not playing", () => {
  const onChange = vi.fn();
  render(<PlayoutMode sequence={sequence()} activeItemId={null} playing={false} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Shuffle playlist" }));
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ startedAt: expect.any(Number) }));
});

it("cannot shuffle a playlist with fewer than two songs", () => {
  render(<PlayoutMode sequence={sequence([song("s1")])} activeItemId="s1" playing={false} onChange={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Shuffle playlist" })).toBeDisabled();
});

it("turns the loop off and on", () => {
  const onChange = vi.fn();
  const { rerender } = render(<PlayoutMode sequence={sequence()} activeItemId="s1" playing={false} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Loop playlist: on" }));
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ loop: false }));
  rerender(<PlayoutMode sequence={sequence([], { loop: false })} activeItemId="s1" playing={false} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Loop playlist: off" }));
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ loop: true }));
});

it("reshuffles a playing playlist without restarting it, and says shuffle is active", () => {
  const onChange = vi.fn();
  render(
    <PlayoutMode sequence={sequence(undefined, { mode: "shuffle" })} activeItemId={null} playing onChange={onChange} />,
  );
  const shuffle = screen.getByRole("button", { name: "Shuffle playlist" });
  expect(shuffle).toHaveAttribute("title", "Shuffle is active; reshuffle playlist");
  fireEvent.click(shuffle);
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange.mock.calls[0][0]).toMatchObject({ mode: "shuffle" });
});

it("keeps the sequence's own active song when none is passed, and shuffles from none when there is none", () => {
  const onChange = vi.fn();
  const { rerender } = render(<PlayoutMode sequence={sequence()} activeItemId={null} playing={false} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: /autoplay/i }));
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ activeItemId: "s1" }));
  rerender(<PlayoutMode sequence={sequence(undefined, { activeItemId: null })} activeItemId={null} playing={false} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Shuffle playlist" }));
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "shuffle" }));
});

// Walk part 4, GM's call: Autoplay's job is starting the rotation, so while nothing is on air the desk says so beside
// it; the note goes once something plays or the rotation is already automatic, and an empty rotation has none.
it("says Autoplay and Shuffle start the rotation now while nothing is on air", () => {
  const { rerender } = render(
    <PlayoutMode sequence={sequence()} activeItemId="s1" playing={false} onChange={vi.fn()} />,
  );
  const hint = screen.getByText("Starts the rotation now");
  expect(screen.getByRole("button", { name: "Autoplay" })).toHaveAttribute("aria-describedby", hint.id);
  expect(screen.getByRole("button", { name: "Shuffle playlist" })).toHaveAttribute("aria-describedby", hint.id);
  expect(screen.getByRole("button", { name: /Loop playlist/ })).not.toHaveAttribute("aria-describedby");
  for (const [props, why] of [
    [{ sequence: sequence(), playing: true }, "playing"],
    [{ sequence: sequence(undefined, { mode: "autoplay" }), playing: false }, "already automatic"],
    [{ sequence: sequence([]), playing: false }, "empty"],
  ] as const) {
    rerender(<PlayoutMode {...props} activeItemId="s1" onChange={vi.fn()} />);
    expect(screen.queryByText("Starts the rotation now"), why).toBeNull();
    expect(screen.getByRole("button", { name: "Autoplay" })).not.toHaveAttribute("aria-describedby");
  }
});

// Walk part 5: after a Stop the rotation has no cursor, and the engine starts nothing from no cursor. Autoplay off air
// aired nothing while the desk named the first song as next; it now names that song.
it("starts Autoplay at the first song when a Stop left no cursor, and leaves Manual without one", () => {
  const onChange = vi.fn();
  render(
    <PlayoutMode
      sequence={sequence(undefined, { activeItemId: null })}
      activeItemId={null}
      playing={false}
      onChange={onChange}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Autoplay" }));
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "autoplay", activeItemId: "s1" }));
  fireEvent.click(screen.getByRole("button", { name: "Manual" }));
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "manual", activeItemId: null }));
});
