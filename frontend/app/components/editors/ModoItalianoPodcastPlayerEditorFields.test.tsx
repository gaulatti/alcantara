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

describe("ModoItalianoPodcastPlayerEditorFields uploads", () => {
  afterEach(() => {
    cleanup();
    vi.resetModules();
    vi.doUnmock("../../services/uploads");
  });

  const renderWithUpload = async (upload: ReturnType<typeof vi.fn>) => {
    vi.resetModules();
    vi.doMock("../../services/uploads", () => ({ uploadFileToMediaBucket: upload }));
    const { ModoItalianoPodcastPlayerEditorFields: Fields } = await import(
      "./ModoItalianoPodcastPlayerEditorFields"
    );
    const updateProp = vi.fn();
    render(
      <Fields
        componentType="player"
        props={{}}
        updateProp={updateProp}
        mediaGroups={[]}
        isLoadingMediaGroups={false}
      />,
    );
    return updateProp;
  };

  it("uploads audio and writes the returned URL into audioUrl", async () => {
    const upload = vi.fn().mockResolvedValue({ url: "https://cdn.test/ep.mp3" });
    const updateProp = await renderWithUpload(upload);
    const input = screen.getAllByTestId("file-drop-input")[0];
    const file = new File(["x"], "ep.mp3", { type: "audio/mpeg" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(updateProp).toHaveBeenCalledWith("player", "audioUrl", "https://cdn.test/ep.mp3"),
    );
    expect(upload).toHaveBeenCalledWith("instant", file);
  });

  it("uploads cover art and writes coverUrl", async () => {
    const upload = vi.fn().mockResolvedValue({ url: "https://cdn.test/c.jpg" });
    const updateProp = await renderWithUpload(upload);
    const input = screen.getAllByTestId("file-drop-input")[1];
    const file = new File(["x"], "c.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(updateProp).toHaveBeenCalledWith("player", "coverUrl", "https://cdn.test/c.jpg"),
    );
    expect(upload).toHaveBeenCalledWith("artwork", file);
  });

  it("rejects oversized audio without calling the API", async () => {
    const upload = vi.fn();
    const updateProp = await renderWithUpload(upload);
    const file = new File(["x"], "big.mp3", { type: "audio/mpeg" });
    Object.defineProperty(file, "size", { value: 201 * 1024 * 1024 });
    fireEvent.change(screen.getAllByTestId("file-drop-input")[0], { target: { files: [file] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Max size is 200MB");
    expect(upload).not.toHaveBeenCalled();
    expect(updateProp).not.toHaveBeenCalled();
  });
});

// gaulatti/alcantara#186: the rest of the podcast editor.
describe("ModoItalianoPodcastPlayerEditorFields editing", () => {
  const TYPE = "modoitaliano-podcast-player";
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const fields = (props: Record<string, unknown>, updateProp = vi.fn()) => {
    render(
      <ModoItalianoPodcastPlayerEditorFields
        componentType={TYPE}
        props={props}
        updateProp={updateProp}
        mediaGroups={[]}
        isLoadingMediaGroups={false}
      />,
    );
    return updateProp;
  };

  it("edits the episode copy, audio URL and show toggle", () => {
    const updateProp = fields({ show: false, episodeTitle: "Uno", showName: "Modo", audioUrl: "/a.mp3" });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(updateProp).toHaveBeenCalledWith(TYPE, "show", true);
    fireEvent.change(screen.getByDisplayValue("Uno"), { target: { value: "Due" } });
    expect(updateProp).toHaveBeenCalledWith(TYPE, "episodeTitle", "Due");
    fireEvent.change(screen.getByDisplayValue("Modo"), { target: { value: "Altro" } });
    expect(updateProp).toHaveBeenCalledWith(TYPE, "showName", "Altro");
    fireEvent.change(screen.getByRole("textbox", { name: "Audio URL" }), { target: { value: "/b.mp3" } });
    expect(updateProp).toHaveBeenCalledWith(TYPE, "audioUrl", "/b.mp3");
  });

  it("previews and clears the chosen cover, and toggles it off from the results", async () => {
    let answer!: (response: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((done) => (answer = done))),
    );
    const updateProp = fields({ coverUrl: "https://example.test/covers/one.jpg" });
    expect(screen.getByAltText("Selected cover")).toHaveAttribute("src", "https://example.test/covers/one.jpg");
    expect(screen.getByText("one.jpg")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(updateProp).toHaveBeenLastCalledWith(TYPE, "coverUrl", "");

    fireEvent.change(screen.getByPlaceholderText(/Search all media/), { target: { value: "cover" } });
    expect(await screen.findByText("Searching media library…")).toBeInTheDocument();
    answer({
      ok: true,
      json: async () => ({
        data: [
          { id: 1, name: "Cover one", imageUrl: "https://example.test/covers/one.jpg" },
          { id: 2, name: "No image", imageUrl: "" },
        ],
      }),
    });
    const result = await screen.findByAltText("Cover one");
    expect(screen.queryByAltText("No image")).toBeNull();
    expect(screen.getByText("✓")).toBeInTheDocument();
    fireEvent.click(result);
    expect(updateProp).toHaveBeenLastCalledWith(TYPE, "coverUrl", "");
    await waitFor(() => expect(screen.queryByText("Searching media library…")).toBeNull());
  });

  it("says when nothing matches, and clears results when the search is emptied", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }));
    fields({});
    const search = screen.getByPlaceholderText(/Search all media/);
    fireEvent.change(search, { target: { value: "nothing" } });
    expect(await screen.findByText(/No images match/)).toHaveTextContent("No images match “nothing”");
    fireEvent.change(search, { target: { value: "  " } });
    expect(screen.queryByText(/No images match/)).toBeNull();
  });

  it("drops a search answer that arrives after the term changed", async () => {
    let reject!: (error: Error) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, fail) => {
            reject = fail;
            init.signal?.addEventListener("abort", () => fail(new Error("aborted")));
          }),
      )
      .mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    fields({});
    const search = screen.getByPlaceholderText(/Search all media/);
    fireEvent.change(search, { target: { value: "first" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.change(search, { target: { value: "second" } });
    expect(await screen.findByText(/No images match “second”/)).toBeInTheDocument();
    reject(new Error("late"));
    expect(screen.queryByText("late")).toBeNull();
    expect(screen.queryByText("aborted")).toBeNull();
  });
});
