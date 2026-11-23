import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RundownFillers } from "./RundownFillers";
import { fillRundown } from "../services/flight";
import { fetchAllMediaLabels } from "../services/mediaLabels";
import type { FlightSequence } from "../models/broadcast";

// The filler panel's own tag loading and failure messages, as the operator
// sees them, when no fixture tags are supplied.

vi.mock("../services/flight", () => ({ fillRundown: vi.fn() }));
vi.mock("../services/mediaLabels", () => ({ fetchAllMediaLabels: vi.fn() }));
vi.mock("@gaulatti/bleecker", async (original) => {
  const actual = await original<typeof import("@gaulatti/bleecker")>();
  return {
    ...actual,
    Select: ({
      options,
      onChange,
      value,
      ...props
    }: {
      options: { value: string; label: string }[];
      onChange: (value: string) => void;
      value: string;
    }) => (
      <select
        {...props}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const rundown: FlightSequence = {
  id: 7,
  name: "Hour",
  revision: 2,
  items: [
    { id: "content", kind: "playSong", songId: 1, clockOffsetSeconds: 0 },
  ],
  scheduledAt: "2026-10-04T12:00:00Z",
  publishedAt: null,
  lastStartedAt: null,
  isRunning: false,
  activeItemId: null,
  loop: false,
  createdAt: "",
  updatedAt: "",
};

function renderPanel(
  props: Partial<Parameters<typeof RundownFillers>[0]> = {},
) {
  const onFilled = vi.fn();
  const view = render(
    <RundownFillers
      programId="radio-demo"
      rundown={rundown}
      items={rundown.items}
      onFilled={onFilled}
      {...props}
    />,
  );
  return { onFilled, view };
}

it("loads the library tags to fill from", async () => {
  vi.mocked(fetchAllMediaLabels).mockResolvedValue([
    { id: "jazz", name: "Late jazz" },
  ]);
  renderPanel();
  expect(
    await screen.findByRole("option", { name: "Late jazz" }),
  ).toBeInTheDocument();
  expect(fetchAllMediaLabels).toHaveBeenCalledTimes(1);
});

it.each([
  [
    new Error("Failed to load labels: HTTP 503"),
    "Failed to load labels: HTTP 503",
  ],
  ["offline", "Tags unavailable"],
])("explains a tag loading failure (%s)", async (cause, message) => {
  vi.mocked(fetchAllMediaLabels).mockRejectedValue(cause);
  renderPanel();
  expect(await screen.findByRole("alert")).toHaveTextContent(message);
});

it("ignores tags and tag failures that arrive after the panel closed", async () => {
  let resolveTags!: (tags: { id: string; name: string }[]) => void;
  vi.mocked(fetchAllMediaLabels).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveTags = resolve;
    }),
  );
  const first = renderPanel();
  first.view.unmount();
  await act(async () => resolveTags([{ id: "jazz", name: "Late jazz" }]));

  let rejectTags!: (cause: unknown) => void;
  vi.mocked(fetchAllMediaLabels).mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      rejectTags = reject;
    }),
  );
  const second = renderPanel();
  second.view.unmount();
  await act(async () => rejectTags(new Error("late")));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("explains a filler preview failure that is not an error object", async () => {
  vi.mocked(fillRundown).mockRejectedValue("timeout");
  const { onFilled } = renderPanel({
    fixtureLabels: [{ id: "music", name: "Music" }],
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Filler tag" }), {
    target: { value: "music" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview fillers" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Filler preview failed",
  );
  expect(onFilled).not.toHaveBeenCalled();
});

it("drops a preview whose rundown changed while it was running", async () => {
  let resolvePreview!: (result: {
    items: FlightSequence["items"];
    warnings: string[];
  }) => void;
  vi.mocked(fillRundown).mockReturnValue(
    new Promise((resolve) => {
      resolvePreview = resolve;
    }),
  );
  const labels = [{ id: "music", name: "Music" }];
  const { onFilled, view } = renderPanel({ fixtureLabels: labels });
  fireEvent.change(screen.getByRole("combobox", { name: "Filler tag" }), {
    target: { value: "music" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview fillers" }));
  expect(screen.getByRole("button", { name: "Filling…" })).toBeVisible();
  view.rerender(
    <RundownFillers
      programId="radio-demo"
      rundown={{ ...rundown, revision: 3 }}
      items={rundown.items}
      onFilled={onFilled}
      fixtureLabels={labels}
    />,
  );
  await act(async () =>
    resolvePreview({ items: rundown.items, warnings: ["stale"] }),
  );
  expect(onFilled).not.toHaveBeenCalled();
  expect(
    screen.queryByLabelText("Filler timing warnings"),
  ).not.toBeInTheDocument();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Preview fillers" }),
    ).toBeVisible(),
  );
});

it("drops a failure whose rundown changed while it was running", async () => {
  let rejectPreview!: (cause: unknown) => void;
  vi.mocked(fillRundown).mockReturnValue(
    new Promise((_resolve, reject) => {
      rejectPreview = reject;
    }),
  );
  const labels = [{ id: "music", name: "Music" }];
  const { onFilled, view } = renderPanel({ fixtureLabels: labels });
  fireEvent.change(screen.getByRole("combobox", { name: "Filler tag" }), {
    target: { value: "music" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview fillers" }));
  view.rerender(
    <RundownFillers
      programId="radio-demo"
      rundown={{ ...rundown, revision: 3 }}
      items={rundown.items}
      onFilled={onFilled}
      fixtureLabels={labels}
    />,
  );
  await act(async () => rejectPreview(new Error("stale failure")));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("locks the controls while there is no rundown, or one that is running or has run", () => {
  const labels = [{ id: "music", name: "Music" }];
  for (const locked of [
    null,
    { ...rundown, isRunning: true },
    { ...rundown, lastStartedAt: "2026-10-04T12:00:00Z" },
  ]) {
    const { view } = renderPanel({ rundown: locked, fixtureLabels: labels });
    expect(screen.getByRole("combobox", { name: "Filler tag" })).toBeDisabled();
    expect(screen.getByLabelText("Filler artist separation")).toBeDisabled();
    view.unmount();
  }
});

it("sends the artist separation the operator chose", async () => {
  vi.mocked(fillRundown).mockResolvedValue({
    items: rundown.items,
    warnings: [],
  });
  renderPanel({ fixtureLabels: [{ id: "music", name: "Music" }] });
  fireEvent.change(screen.getByRole("combobox", { name: "Filler tag" }), {
    target: { value: "music" },
  });
  fireEvent.change(screen.getByLabelText("Filler artist separation"), {
    target: { value: "4" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview fillers" }));
  await waitFor(() =>
    expect(fillRundown).toHaveBeenCalledWith(
      "radio-demo",
      7,
      2,
      rundown.items,
      {
        labelId: "music",
        artistSeparation: 4,
      },
    ),
  );
});
