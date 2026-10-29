import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModoItalianoPodcastPlayerEditorFields } from "./ModoItalianoPodcastPlayerEditorFields";

const renderFields = (updateProp = vi.fn()) =>
  render(
    <ModoItalianoPodcastPlayerEditorFields
      componentType="modoitaliano-giorgia-podcast-player"
      props={{}}
      updateProp={updateProp}
      mediaGroups={[]}
      isLoadingMediaGroups={false}
    />,
  );

describe("ModoItalianoPodcastPlayerEditorFields cover search", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists library images from the paginated /media response and selects one", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 1, name: "Paolo Meneguzzi", imageUrl: "https://example.test/p.jpg" }],
        meta: { total: 1, page: 1, limit: 48, totalPages: 1 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const updateProp = vi.fn();
    renderFields(updateProp);

    fireEvent.change(screen.getByPlaceholderText(/Search all media/), {
      target: { value: "paolo" },
    });

    const image = await screen.findByAltText("Paolo Meneguzzi");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/media?search=paolo");
    fireEvent.click(image);
    expect(updateProp).toHaveBeenCalledWith(
      "modoitaliano-giorgia-podcast-player",
      "coverUrl",
      "https://example.test/p.jpg",
    );
  });

  it("shows an error instead of an empty list when the search fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    renderFields();

    fireEvent.change(screen.getByPlaceholderText(/Search all media/), {
      target: { value: "x" },
    });

    await waitFor(() =>
      expect(screen.getByText("Media search failed (401)")).toBeInTheDocument(),
    );
  });
});
