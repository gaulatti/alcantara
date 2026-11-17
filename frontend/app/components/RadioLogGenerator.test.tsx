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
import { fetchAllMediaLabels } from "../services/mediaLabels";
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
vi.mock("../services/mediaLabels", () => ({ fetchAllMediaLabels: vi.fn() }));
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

it("loads the Library tags itself when none are supplied", async () => {
  vi.mocked(fetchAllMediaLabels).mockResolvedValue([
    { id: "jazz", name: "Jazz" },
  ]);
  render(<RadioLogGenerator programId="radio-demo" log={log} onGenerated={vi.fn()} />);
  expect(
    screen.getByText("Create tags and label songs in the Library first."),
  ).toBeInTheDocument();
  expect(
    await screen.findByRole("option", { name: "Jazz" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByText("Create tags and label songs in the Library first."),
  ).toBeNull();
});

it("reports a tag load failure, with a fallback for an unnamed one", async () => {
  vi.mocked(fetchAllMediaLabels).mockRejectedValueOnce(
    new Error("Failed to load labels: HTTP 503"),
  );
  const first = render(
    <RadioLogGenerator programId="radio-demo" log={log} onGenerated={vi.fn()} />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Failed to load labels: HTTP 503",
  );
  expect(
    screen.queryByText("Create tags and label songs in the Library first."),
  ).toBeNull();
  first.unmount();

  vi.mocked(fetchAllMediaLabels).mockRejectedValueOnce("offline");
  render(<RadioLogGenerator programId="radio-demo" log={log} onGenerated={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Tags unavailable");
});

it("drops a tag load that finishes after the generator closed", async () => {
  let resolve!: (labels: { id: string; name: string }[]) => void;
  let reject!: (cause: Error) => void;
  vi.mocked(fetchAllMediaLabels)
    .mockReturnValueOnce(new Promise((done) => (resolve = done)))
    .mockReturnValueOnce(new Promise((_done, fail) => (reject = fail)));
  const errors = vi.spyOn(console, "error");
  render(<RadioLogGenerator programId="radio-demo" log={log} onGenerated={vi.fn()} />).unmount();
  render(<RadioLogGenerator programId="radio-demo" log={log} onGenerated={vi.fn()} />).unmount();
  await act(async () => {
    resolve([{ id: "late", name: "Late" }]);
    reject(new Error("late failure"));
  });
  expect(errors).not.toHaveBeenCalled();
});

it("arranges several blocks with their own tags, counts and fixed starts", async () => {
  vi.mocked(generateTaggedLog).mockResolvedValue({ items: [] });
  render(
    <RadioLogGenerator
      programId="radio-demo"
      log={log}
      onGenerated={vi.fn()}
      fixtureLabels={[
        { id: "music", name: "Music" },
        { id: "ballads", name: "Ballads" },
      ]}
    />,
  );
  expect(screen.queryByRole("button", { name: "Remove block 1" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Music block" }));
  fireEvent.click(screen.getByRole("button", { name: "Music block" }));
  expect(
    screen.getByRole("spinbutton", { name: "Fixed start for block 1" }),
  ).toBeDisabled();
  fireEvent.change(screen.getByRole("combobox", { name: "Tag for block 1" }), {
    target: { value: "music" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Tag for block 2" }), {
    target: { value: "ballads" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Tag for block 3" }), {
    target: { value: "music" },
  });
  const second = screen.getByRole("spinbutton", {
    name: "Fixed start for block 2",
  });
  expect(second).toHaveAttribute("placeholder", "Follows");
  fireEvent.change(second, { target: { value: "900" } });
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Fixed start for block 3" }),
    { target: { value: "1200" } },
  );
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Fixed start for block 3" }),
    { target: { value: "" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove block 2" }));
  fireEvent.click(screen.getByRole("button", { name: "Generate draft" }));
  await waitFor(() =>
    expect(generateTaggedLog).toHaveBeenCalledWith("radio-demo", 7, 2, {
      slots: [
        { labelId: "music", count: 1, clockOffsetSeconds: 0 },
        { labelId: "music", count: 1, clockOffsetSeconds: undefined },
      ],
      artistSeparation: 2,
    }),
  );
});

it("offers to replace an existing draft and needs a tag on every block", async () => {
  vi.mocked(generateTaggedLog).mockRejectedValueOnce("no reason");
  render(
    <RadioLogGenerator
      programId="radio-demo"
      log={{ ...log, items: [{ id: "cue", kind: "playSong", songId: 1 }] }}
      onGenerated={vi.fn()}
      fixtureLabels={[{ id: "music", name: "Music" }]}
    />,
  );
  const replace = screen.getByRole("button", {
    name: "Replace draft from tags",
  });
  expect(replace).toBeDisabled();
  fireEvent.change(screen.getByRole("combobox", { name: "Tag for block 1" }), {
    target: { value: "music" },
  });
  fireEvent.click(replace);
  expect(screen.getByRole("button", { name: "Generating…" })).toBeInTheDocument();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Generation failed",
  );
});

it("locks the generator without a draft, and for a running or aired one", () => {
  const { rerender } = render(
    <RadioLogGenerator
      programId="radio-demo"
      log={null}
      onGenerated={vi.fn()}
      fixtureLabels={[{ id: "music", name: "Music" }]}
    />,
  );
  expect(
    screen.getByText("Choose an unaired draft to generate."),
  ).toBeInTheDocument();
  for (const locked of [
    { ...log, isRunning: true },
    { ...log, lastStartedAt: "2026-10-04T12:00:00Z" },
  ]) {
    rerender(
      <RadioLogGenerator
        programId="radio-demo"
        log={locked}
        onGenerated={vi.fn()}
        fixtureLabels={[{ id: "music", name: "Music" }]}
      />,
    );
    expect(
      screen.getByRole("combobox", { name: "Tag for block 1" }),
    ).toBeDisabled();
  }
  expect(screen.getByRole("link", { name: "Manage Library tags" })).toHaveAttribute(
    "href",
    "/media",
  );
});
