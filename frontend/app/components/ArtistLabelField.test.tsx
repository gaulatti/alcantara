import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ArtistLabelField } from "./ArtistLabelField";

// Radix positioning runs continuously in jsdom; keep Bleecker's string callback contract with a
// native select, as the other Bleecker-select tests in this repo do.
vi.mock("@gaulatti/bleecker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gaulatti/bleecker")>();
  return {
    ...actual,
    Select: ({ options, onChange, value, ...rest }: any) => (
      <select {...rest} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
});

const services = vi.hoisted(() => ({
  fetchAllMediaLabels: vi.fn(),
  fetchArtistLabels: vi.fn(),
  saveArtistLabel: vi.fn(),
}));
vi.mock("../services/mediaLabels", () => ({ fetchAllMediaLabels: services.fetchAllMediaLabels }));
vi.mock("../services/artistLabels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/artistLabels")>()),
  fetchArtistLabels: services.fetchArtistLabels,
  saveArtistLabel: services.saveArtistLabel,
}));

afterEach(() => {
  cleanup();
  Object.values(services).forEach((mock) => mock.mockReset());
});

const labels = [
  { id: "l1", name: "Rob pictures", assetCount: 12 },
  { id: "l2", name: "Empty label", assetCount: 0 },
  { id: "l3", name: "One picture", assetCount: 1 },
];

const mount = async (artist: string, rows = [{ artistKey: "rob", artist: "Rob", labelId: "l1" }]) => {
  services.fetchAllMediaLabels.mockResolvedValue(labels);
  services.fetchArtistLabels.mockResolvedValue(rows);
  const view = render(<ArtistLabelField artist={artist} />);
  await waitFor(() => expect(screen.getByLabelText("Artist label")).not.toBeDisabled());
  return view;
};

it("shows the label already attached to the artist, matched ignoring case and outer spaces, with its image count", async () => {
  await mount(" ROB ");
  expect(screen.getByLabelText("Artist label")).toHaveValue("l1");
  expect(screen.getByRole("option", { name: "Rob pictures (12 images)" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "One picture (1 image)" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save artist label" })).toBeDisabled();
});

it("saves the chosen label for the artist as typed, and then offers no further save", async () => {
  services.saveArtistLabel.mockResolvedValue(undefined);
  await mount("Someone New", []);
  fireEvent.change(screen.getByLabelText("Artist label"), { target: { value: "l3" } });
  fireEvent.click(screen.getByRole("button", { name: "Save artist label" }));
  await screen.findByText("Artist label saved for every song by this artist.");
  expect(services.saveArtistLabel).toHaveBeenCalledWith("Someone New", "l3");
  expect(screen.getByLabelText("Artist label")).toHaveValue("l3");
  expect(screen.getByRole("button", { name: "Save artist label" })).toBeDisabled();
});

it("removes the link with a null label", async () => {
  services.saveArtistLabel.mockResolvedValue(undefined);
  await mount("Rob");
  fireEvent.change(screen.getByLabelText("Artist label"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save artist label" }));
  await screen.findByText("Artist label removed.");
  expect(services.saveArtistLabel).toHaveBeenCalledWith("Rob", null);
  expect(screen.getByLabelText("Artist label")).toHaveValue("");
});

it("warns when the chosen label has no images", async () => {
  await mount("Rob");
  expect(screen.queryByText(/has no images yet/)).toBeNull();
  fireEvent.change(screen.getByLabelText("Artist label"), { target: { value: "l2" } });
  expect(screen.getByRole("status").textContent).toContain("This label has no images yet");
});

it("says why a save was refused and keeps the choice", async () => {
  services.saveArtistLabel.mockRejectedValue(new Error("The label does not exist for this team"));
  await mount("Rob");
  fireEvent.change(screen.getByLabelText("Artist label"), { target: { value: "l3" } });
  fireEvent.click(screen.getByRole("button", { name: "Save artist label" }));
  expect((await screen.findByRole("alert")).textContent).toBe("The label does not exist for this team");
  expect(screen.getByLabelText("Artist label")).toHaveValue("l3");
  expect(screen.getByRole("button", { name: "Save artist label" })).not.toBeDisabled();
});

it("reports a refusal that is not an Error", async () => {
  services.saveArtistLabel.mockRejectedValue("offline");
  await mount("Rob");
  fireEvent.change(screen.getByLabelText("Artist label"), { target: { value: "l3" } });
  fireEvent.click(screen.getByRole("button", { name: "Save artist label" }));
  expect((await screen.findByRole("alert")).textContent).toBe("offline");
});

it("cannot save while the artist is blank", async () => {
  services.fetchAllMediaLabels.mockResolvedValue(labels);
  services.fetchArtistLabels.mockResolvedValue([]);
  render(<ArtistLabelField artist="  " />);
  await waitFor(() => expect(services.fetchArtistLabels).toHaveBeenCalled());
  expect(screen.getByLabelText("Artist label")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save artist label" })).toBeDisabled();
});

it("shows why the labels could not be loaded", async () => {
  services.fetchAllMediaLabels.mockRejectedValue(new Error("Failed to load labels: HTTP 500"));
  services.fetchArtistLabels.mockResolvedValue([]);
  render(<ArtistLabelField artist="Rob" />);
  expect((await screen.findByRole("alert")).textContent).toBe("Failed to load labels: HTTP 500");
  cleanup();
  services.fetchAllMediaLabels.mockRejectedValue("down");
  render(<ArtistLabelField artist="Rob" />);
  expect((await screen.findByRole("alert")).textContent).toBe("down");
});

it("ignores an answer that arrives after it was closed", async () => {
  let resolve!: (value: unknown) => void;
  services.fetchAllMediaLabels.mockReturnValue(new Promise((done) => (resolve = done)));
  services.fetchArtistLabels.mockResolvedValue([]);
  const view = render(<ArtistLabelField artist="Rob" />);
  view.unmount();
  resolve(labels);
  await Promise.resolve();
  services.fetchAllMediaLabels.mockReturnValue(Promise.reject(new Error("late")));
  const second = render(<ArtistLabelField artist="Rob" />);
  second.unmount();
  await Promise.resolve();
  expect(screen.queryByRole("alert")).toBeNull();
});
