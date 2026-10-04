import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RadioLogGenerator } from "./RadioLogGenerator";
import type { FlightSequence } from "../models/broadcast";
import { generateTaggedLog } from "../services/flight";
// Radix positioning runs continuously in jsdom; preserve Bleecker's string callback contract.
vi.mock("@gaulatti/bleecker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gaulatti/bleecker")>();
  return {
    ...actual,
    Select: ({ options, onChange, value, ...props }: any) => (
      <select
        {...props}
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
it("does not apply a late generation after leaving its inspector tab", async () => {
  let resolve!: (result: { items: typeof log.items }) => void;
  vi.mocked(generateTaggedLog).mockReturnValue(
    new Promise((result) => {
      resolve = result;
    }),
  );
  const onGenerated = vi.fn();
  const view = render(
    <RadioLogGenerator
      programId="radio-demo"
      log={log}
      onGenerated={onGenerated}
      fixtureLabels={[{ id: "music", name: "Music" }]}
    />,
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Tag for block 1" }), {
    target: { value: "music" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Generate draft" }));
  view.unmount();
  await act(async () => resolve({ items: log.items }));
  expect(onGenerated).not.toHaveBeenCalled();
});
vi.mock("../services/flight", () => ({ generateTaggedLog: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const log: FlightSequence = {
  id: 7,
  name: "Next hour",
  items: [],
  revision: 2,
  scheduledAt: "2026-10-04T12:00:00Z",
  publishedAt: null,
  lastStartedAt: null,
  loop: false,
  isRunning: false,
  activeItemId: null,
  createdAt: "",
  updatedAt: "",
};

it("sends explicit tag blocks and returns a reviewable draft without saving or publishing", async () => {
  const onGenerated = vi.fn();
  const items = [
    {
      id: "cue",
      kind: "playSong" as const,
      songId: 9001,
      clockOffsetSeconds: 0,
    },
  ];
  vi.mocked(generateTaggedLog).mockResolvedValue({ items });
  render(
    <RadioLogGenerator
      programId="radio-demo"
      log={log}
      onGenerated={onGenerated}
      fixtureLabels={[{ id: "music", name: "Demo music" }]}
    />,
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Tag for block 1" }), {
    target: { value: "music" },
  });
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Song count for block 1" }),
    { target: { value: "2" } },
  );
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Artist separation" }),
    { target: { value: "0" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Generate draft" }));
  await waitFor(() => expect(onGenerated).toHaveBeenCalledWith(items));
  expect(generateTaggedLog).toHaveBeenCalledWith("radio-demo", 7, 2, {
    slots: [{ labelId: "music", count: 2, clockOffsetSeconds: 0 }],
    artistSeparation: 0,
  });
});

it("keeps a published hour frozen and displays selection failures without replacing its draft", async () => {
  const onGenerated = vi.fn();
  const { rerender } = render(
    <RadioLogGenerator
      programId="radio-demo"
      log={{ ...log, publishedAt: "2026-10-04T11:00:00Z" }}
      onGenerated={onGenerated}
      fixtureLabels={[{ id: "music", name: "Music" }]}
    />,
  );
  expect(
    screen.getByRole("combobox", { name: "Tag for block 1" }),
  ).toBeDisabled();
  rerender(
    <RadioLogGenerator
      programId="radio-demo"
      log={log}
      onGenerated={onGenerated}
      fixtureLabels={[{ id: "music", name: "Music" }]}
    />,
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Tag for block 1" }), {
    target: { value: "music" },
  });
  vi.mocked(generateTaggedLog).mockRejectedValue(
    new Error("Not enough eligible songs"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Generate draft" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Not enough eligible songs",
  );
  expect(onGenerated).not.toHaveBeenCalled();
});

it("does not apply an in-flight preview to a different hour", async () => {
  const onGenerated = vi.fn();
  let resolve!: (result: { items: FlightSequence["items"] }) => void;
  vi.mocked(generateTaggedLog).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const props = {
    programId: "radio-demo",
    onGenerated,
    fixtureLabels: [{ id: "music", name: "Music" }],
  };
  const { rerender } = render(<RadioLogGenerator {...props} log={log} />);
  fireEvent.change(screen.getByRole("combobox", { name: "Tag for block 1" }), {
    target: { value: "music" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Generate draft" }));
  rerender(<RadioLogGenerator {...props} log={{ ...log, id: 8 }} />);
  resolve({ items: [{ id: "old-hour", kind: "playSong", songId: 9001 }] });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Generate draft" }),
    ).toBeEnabled(),
  );
  expect(onGenerated).not.toHaveBeenCalled();
});
