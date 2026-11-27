import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlaylistSheetPanel } from "./PlaylistSheetPanel";

// gaulatti/alcantara#184, group G7: the playlist sheet, which adds songs
// from the catalog.

afterEach(cleanup);

const sequence = {
  mode: "manual",
  loop: true,
  activeItemId: null,
  items: [],
} as any;
const catalog = [
  {
    id: 4,
    enabled: true,
    artist: "Alpha",
    title: "Opening",
    audioUrl: "https://audio.test/4.mp3",
  },
] as any;

function sheet(props: Record<string, unknown> = {}) {
  const onChange = vi.fn();
  const onClose = vi.fn();
  render(
    <PlaylistSheetPanel
        programId="test-program"
      isOpen
      onClose={onClose}
      sequence={sequence}
      songCatalog={catalog}
      programSongPlayback={null}
      isSaving={false}
      onChange={onChange}
      {...props}
    />,
  );
  return { onChange, onClose };
}

it("adds a catalog song to the playlist and shows when it is saving", () => {
  const { onChange } = sheet();
  expect(screen.queryByText("Saving…")).toBeNull();
  fireEvent.click(screen.getByLabelText("Add Opening to the playlist"));
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({
      items: [expect.objectContaining({ songId: 4, title: "Opening" })],
    }),
  );
  cleanup();
  sheet({ isSaving: true });
  expect(screen.getByText("Saving…")).toBeInTheDocument();
});

it("closes on Escape, and renders nothing while closed", () => {
  const { onClose } = sheet({ onTakeSelection: vi.fn() });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
  cleanup();
  sheet({ isOpen: false });
  expect(screen.queryByPlaceholderText("Search catalog to add...")).toBeNull();
});
