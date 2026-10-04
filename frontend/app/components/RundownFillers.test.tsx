import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RundownFillers } from "./RundownFillers";
import { fillRundown } from "../services/flight";
import type { FlightSequence } from "../models/broadcast";
vi.mock("../services/flight", () => ({ fillRundown: vi.fn() }));
vi.mock("@gaulatti/bleecker", async (original) => {
  const actual = await original<typeof import("@gaulatti/bleecker")>();
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
it("does not apply a late preview after leaving its inspector tab", async () => {
  let resolve!: (result: {
    items: typeof rundown.items;
    warnings: string[];
  }) => void;
  vi.mocked(fillRundown).mockReturnValue(
    new Promise((result) => {
      resolve = result;
    }),
  );
  const onFilled = vi.fn();
  const view = render(
    <RundownFillers
      programId="radio-demo"
      rundown={rundown}
      items={rundown.items}
      onFilled={onFilled}
      fixtureLabels={[{ id: "music", name: "Music" }]}
    />,
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Filler tag" }), {
    target: { value: "music" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview fillers" }));
  view.unmount();
  await act(async () => resolve({ items: rundown.items, warnings: [] }));
  expect(onFilled).not.toHaveBeenCalled();
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
it("preserves reviewed content in the request and exposes filler cuts without saving", async () => {
  const onFilled = vi.fn();
  const items = [
    ...rundown.items,
    { id: "fill", kind: "playSong" as const, songId: 2, isFiller: true },
  ];
  vi.mocked(fillRundown).mockResolvedValue({
    items,
    warnings: ["Last filler will be cut 15s before its end."],
  });
  render(
    <RundownFillers
      programId="radio-demo"
      rundown={rundown}
      items={rundown.items}
      onFilled={onFilled}
      fixtureLabels={[{ id: "music", name: "Music" }]}
    />,
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Filler tag" }), {
    target: { value: "music" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview fillers" }));
  await waitFor(() => expect(onFilled).toHaveBeenCalledWith(items));
  expect(fillRundown).toHaveBeenCalledWith("radio-demo", 7, 2, rundown.items, {
    labelId: "music",
    artistSeparation: 2,
  });
  expect(screen.getByLabelText("Filler timing warnings")).toHaveTextContent(
    "cut 15s",
  );
});
it("keeps published content locked and reports failures without replacing content", async () => {
  const onFilled = vi.fn();
  const view = render(
    <RundownFillers
      programId="radio-demo"
      rundown={{ ...rundown, publishedAt: "now" }}
      items={rundown.items}
      onFilled={onFilled}
      fixtureLabels={[{ id: "music", name: "Music" }]}
    />,
  );
  expect(screen.getByRole("combobox", { name: "Filler tag" })).toBeDisabled();
  view.rerender(
    <RundownFillers
      programId="radio-demo"
      rundown={rundown}
      items={rundown.items}
      onFilled={onFilled}
      fixtureLabels={[{ id: "music", name: "Music" }]}
    />,
  );
  vi.mocked(fillRundown).mockRejectedValue(
    new Error("Content duration is missing"),
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Filler tag" }), {
    target: { value: "music" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview fillers" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "duration is missing",
  );
  expect(onFilled).not.toHaveBeenCalled();
});
