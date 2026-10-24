import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  asset,
  ready,
  mount,
  writes,
  dialog,
  imageDialog,
  input,
  chooseFiles,
  alert,
  selectedNews,
  mediaState,
  json,
} from "../../test/mediaRuntimeFixture";
import { meta } from "./media";

it("renders real media, capabilities, label badges and authenticated catalogue requests", async () => {
  await ready();
  expect(await screen.findByText("Sunset")).toBeInTheDocument();
  expect(screen.getByText("City")).toBeInTheDocument();
  expect(screen.getAllByText("No capability")).toHaveLength(2);
  expect(screen.getByText("2 assets")).toBeInTheDocument();
  expect(
    mediaState.requests.every(
      (request) =>
        request.headers.get("authorization") === "Bearer media-runtime-fixture",
    ),
  ).toBe(true);
  expect(meta({} as Parameters<typeof meta>[0])).toEqual(
    expect.arrayContaining([{ title: "Media - Alcantara" }]),
  );
});

it("waits for the owning program type before loading or exposing media controls", () => {
  mount("/media", null);
  expect(screen.queryByText("Media library")).not.toBeInTheDocument();
  expect(mediaState.requests).toEqual([]);
});

it("debounces trimmed search, clears it and resets pagination after a search change", async () => {
  mediaState.pageCount = 3;
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await waitFor(() =>
    expect(
      mediaState.requests.some((request) => request.path.includes("page=2")),
    ).toBe(true),
  );
  fireEvent.change(screen.getByPlaceholderText("Search image media…"), {
    target: { value: "  City  " },
  });
  await screen.findByText("City");
  await waitFor(() =>
    expect(
      mediaState.requests.some(
        (request) =>
          request.path.includes("page=1") &&
          request.path.includes("search=City"),
      ),
    ).toBe(true),
  );
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  await waitFor(() =>
    expect(mediaState.requests.at(-2)?.path.includes("search=")).toBe(false),
  );
});

it("shows filtered and unfiltered empty states without manufacturing rows", async () => {
  mediaState.assets = [];
  await ready();
  expect(
    await screen.findByText("This physical media type has no assets yet."),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText("Search image media…"), {
    target: { value: "missing" },
  });
  expect(
    await screen.findByText("Clear the filters and try again."),
  ).toBeInTheDocument();
});

it("shows a failed catalogue load and releases its loading state", async () => {
  mediaState.failures["GET /media-assets"] = json(
    { message: "database unavailable" },
    503,
  );
  mount();
  await alert("Failed to load the media library.");
  expect(screen.getByText("No image media found")).toBeInTheDocument();
});

it("renders actual audio and video controls and supported management destinations", async () => {
  const view = await ready("/media?type=AUDIO");
  expect(await screen.findByText("Weather bed")).toBeInTheDocument();
  expect(view.container.querySelector("audio")).toHaveAttribute(
    "src",
    mediaState.assets[2].sourceUrl,
  );
  fireEvent.click(screen.getByRole("button", { name: "Manage songs" }));
  expect(screen.getByTestId("media-location")).toHaveTextContent("/songs");
});

it("navigates media tabs and the transition editor while preserving physical type rendering", async () => {
  const view = await ready();
  fireEvent.click(screen.getByRole("tab", { name: "Video" }));
  expect(await screen.findByText("Opening video")).toBeInTheDocument();
  expect(view.container.querySelector("video")).toHaveAttribute(
    "src",
    mediaState.assets[3].sourceUrl,
  );
  expect(
    screen.queryByRole("button", { name: "Delete Opening video" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Manage transitions" }));
  expect(screen.getByTestId("media-location")).toHaveTextContent("/stingers");
});

it.each([
  [["first.png", "second.jpg"], "", ["first", "second"]],
  [["first.png", "second.jpg"], "Editorial", ["Editorial 1", "Editorial 2"]],
  [["single.png"], "Solo image", ["Solo image"]],
  [[".hidden"], "", [".hidden"]],
  [[" "], "", ["Image 1"]],
] as Array<[string[], string, string[]]>)(
  "uploads real file forms and derives image names for %j",
  async (names, title, expected) => {
    await ready();
    const modal = await imageDialog();
    if (title) input(modal, "Optional for file uploads", title);
    chooseFiles(
      modal,
      names.map((name) => new File(["fixture"], name, { type: "image/png" })),
    );
    fireEvent.click(within(modal).getByRole("button", { name: "Add images" }));
    await alert(`Added ${names.length} image${names.length === 1 ? "" : "s"}.`);
    expect(
      writes("POST", "/uploads/artwork").map((request) =>
        (request.body as FormData).get("file"),
      ),
    ).toHaveLength(names.length);
    expect(
      writes("POST", "/media").map((request) => request.body.name),
    ).toEqual(expected);
    expect(
      writes("POST", "/media").every((request) =>
        request.body.imageUrl.startsWith("https://cdn.fixture.invalid/upload/"),
      ),
    ).toBe(true);
  },
);

it("adds a direct-URL image with a trimmed name and explicit canonical label", async () => {
  await ready();
  const modal = await imageDialog();
  input(modal, "Optional for file uploads", "  Sponsor  ");
  input(modal, "https://…", " https://cdn.fixture.invalid/sponsor.png ");
  fireEvent.click(within(modal).getByRole("checkbox", { name: "News" }));
  fireEvent.click(within(modal).getByRole("button", { name: "Add images" }));
  await alert("Added 1 image.");
  expect(writes("POST", "/media")[0].body).toEqual({
    name: "Sponsor",
    imageUrl: "https://cdn.fixture.invalid/sponsor.png",
  });
  expect(writes("PUT", "/media-assets/image%3A21/labels")[0].body).toEqual({
    labelIds: ["label:news"],
  });
  expect(writes("POST", "/uploads/artwork")).toHaveLength(0);
});

it.each([
  ["", "", "Select at least one image or provide an image URL."],
  [
    "",
    "https://cdn.fixture.invalid/direct.png",
    "Name is required for a direct URL.",
  ],
])(
  "keeps incomplete image forms open without creating assets",
  async (name, url, message) => {
    await ready();
    const modal = await imageDialog();
    input(modal, "Optional for file uploads", name);
    input(modal, "https://…", url);
    fireEvent.click(within(modal).getByRole("button", { name: "Add images" }));
    await alert(message);
    expect(
      screen.getByRole("dialog", { name: "Add images" }),
    ).toBeInTheDocument();
    expect(writes("POST", "/media")).toHaveLength(0);
  },
);

it("edits the actual image identity and replaces its canonical labels", async () => {
  await ready();
  fireEvent.click(await screen.findByRole("button", { name: "Edit Sunset" }));
  const modal = await dialog("Edit image");
  input(modal, "Image name", " Evening ");
  input(modal, "https://…", " https://cdn.fixture.invalid/evening.png ");
  fireEvent.click(within(modal).getByRole("checkbox", { name: "News" }));
  fireEvent.click(within(modal).getByRole("checkbox", { name: "Weather" }));
  fireEvent.click(within(modal).getByRole("button", { name: "Save image" }));
  await alert("Image updated.");
  expect(writes("PUT", "/media/1")[0].body).toEqual({
    name: "Evening",
    imageUrl: "https://cdn.fixture.invalid/evening.png",
  });
  expect(writes("PUT", "/media-assets/image%3A1/labels")[0].body).toEqual({
    labelIds: ["label:weather"],
  });
  expect(await screen.findByText("Evening")).toBeInTheDocument();
});

it("requires confirmation to delete an image and preserves it when cancelled", async () => {
  await ready();
  vi.mocked(window.confirm).mockReturnValue(false);
  fireEvent.click(await screen.findByRole("button", { name: "Delete Sunset" }));
  expect(writes("DELETE", "/media/1")).toHaveLength(0);
  expect(screen.getByText("Sunset")).toBeInTheDocument();
  vi.mocked(window.confirm).mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Delete Sunset" }));
  await alert("Image deleted.");
  expect(screen.queryByText("Sunset")).not.toBeInTheDocument();
});

it("replaces an edited image file through the real artwork upload endpoint", async () => {
  await ready();
  fireEvent.click(await screen.findByRole("button", { name: "Edit Sunset" }));
  const modal = await dialog("Edit image");
  chooseFiles(modal, [
    new File(["replacement"], "replacement.png", { type: "image/png" }),
  ]);
  fireEvent.click(within(modal).getByRole("button", { name: "Save image" }));
  await alert("Image updated.");
  expect(writes("PUT", "/media/1")[0].body.imageUrl).toBe(
    "https://cdn.fixture.invalid/upload/replacement.png",
  );
  expect(writes("POST", "/media")).toHaveLength(0);
});

it("validates an edited image before changing its persisted record", async () => {
  await ready();
  fireEvent.click(await screen.findByRole("button", { name: "Edit Sunset" }));
  const modal = await dialog("Edit image");
  input(modal, "Image name", " ");
  fireEvent.click(within(modal).getByRole("button", { name: "Save image" }));
  await alert("Name and image are required.");
  expect(writes("PUT", "/media/1")).toHaveLength(0);
  expect(mediaState.assets[0].name).toBe("Sunset");
});

it("keeps the image dialog locked while a real request is pending", async () => {
  let release!: () => void;
  mediaState.gates["POST /media"] = new Promise<void>((resolve) => {
    release = resolve;
  });
  await ready();
  const modal = await imageDialog();
  input(modal, "Optional for file uploads", "Pending");
  input(modal, "https://…", "https://cdn.fixture.invalid/pending.png");
  fireEvent.click(within(modal).getByRole("button", { name: "Add images" }));
  await within(modal).findByRole("button", { name: "Saving…" });
  expect(within(modal).getByRole("button", { name: "Cancel" })).toBeDisabled();
  fireEvent.click(within(modal).getByRole("button", { name: "Close" }));
  expect(
    screen.getByRole("dialog", { name: "Add images" }),
  ).toBeInTheDocument();
  await act(async () => {
    release();
  });
  await alert("Added 1 image.");
});

it.each([
  [JSON.stringify({ message: "Name rejected" }), "Name rejected"],
  [
    JSON.stringify({ message: ["Name rejected", "Unsupported URL"] }),
    "Name rejected, Unsupported URL",
  ],
  [
    JSON.stringify({ error: "fixture failure" }),
    JSON.stringify({ error: "fixture failure" }),
  ],
  ["Fixture plain-text failure", "Fixture plain-text failure"],
  ["", "HTTP 422"],
])(
  "shows actual server rejection bodies without creating a duplicate image",
  async (body, message) => {
    mediaState.failures["POST /media"] = new Response(body, { status: 422 });
    await ready();
    const modal = await imageDialog();
    input(modal, "Optional for file uploads", "Rejected");
    input(modal, "https://…", "https://cdn.fixture.invalid/rejected.png");
    fireEvent.click(within(modal).getByRole("button", { name: "Add images" }));
    await alert(message);
    expect(
      screen.getByRole("dialog", { name: "Add images" }),
    ).toBeInTheDocument();
    expect(mediaState.assets.some((value) => value.name === "Rejected")).toBe(
      false,
    );
  },
);

it("preserves the file selection for retry after the real upload endpoint rejects it", async () => {
  mediaState.failures["POST /uploads/artwork"] = new Response("Upload denied", {
    status: 403,
  });
  await ready();
  const modal = await imageDialog();
  chooseFiles(modal, [
    new File(["fixture"], "retry.png", { type: "image/png" }),
  ]);
  fireEvent.click(within(modal).getByRole("button", { name: "Add images" }));
  await alert("Upload denied");
  expect(writes("POST", "/media")).toHaveLength(0);
  delete mediaState.failures["POST /uploads/artwork"];
  fireEvent.click(within(modal).getByRole("button", { name: "Add images" }));
  await alert("Added 1 image.");
  expect(writes("POST", "/uploads/artwork")).toHaveLength(2);
  expect(writes("POST", "/media")).toHaveLength(1);
});

it("closes a partially completed batch and exposes persisted images before another upload", async () => {
  mediaState.failures["POST /media"] = () =>
    writes("POST", "/media").length === 2
      ? json({ message: "second image rejected" }, 503)
      : undefined;
  await ready();
  const modal = await imageDialog();
  chooseFiles(modal, [
    new File(["a"], "one.png", { type: "image/png" }),
    new File(["b"], "two.png", { type: "image/png" }),
  ]);
  fireEvent.click(within(modal).getByRole("button", { name: "Add images" }));
  await alert(/1 image was added, but setup did not finish/);
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Add images" }),
    ).not.toBeInTheDocument(),
  );
  expect(await screen.findByText("one")).toBeInTheDocument();
  expect(mediaState.assets.some((value) => value.name === "two")).toBe(false);
});

it("reports a non-Error network rejection using the image failure contract", async () => {
  mediaState.failures["POST /media"] = "fixture disconnected";
  await ready();
  const modal = await imageDialog();
  input(modal, "Optional for file uploads", "Offline");
  input(modal, "https://…", "https://cdn.fixture.invalid/offline.png");
  fireEvent.click(within(modal).getByRole("button", { name: "Add images" }));
  await alert("Failed to save image.");
});

it("preserves an existing image when its deletion is rejected", async () => {
  mediaState.failures["DELETE /media/1"] = json(
    { message: "image still in use" },
    409,
  );
  await ready();
  fireEvent.click(await screen.findByRole("button", { name: "Delete Sunset" }));
  await alert("image still in use");
  expect(screen.getByText("Sunset")).toBeInTheDocument();
});

it("creates background audio from a direct URL with zero default volume and a label", async () => {
  await ready("/media?type=AUDIO");
  fireEvent.click(screen.getByRole("button", { name: "Add background audio" }));
  const modal = await dialog("Add background audio");
  input(modal, "Weather bed", "  Quiet bed  ");
  input(modal, "https://…", " https://cdn.fixture.invalid/quiet.mp3 ");
  fireEvent.change(within(modal).getByRole("spinbutton"), {
    target: { value: "0" },
  });
  fireEvent.click(within(modal).getByRole("checkbox", { name: "Weather" }));
  fireEvent.click(
    within(modal).getByRole("button", { name: "Add background audio" }),
  );
  await alert("Background audio added.");
  expect(writes("POST", "/media-assets/background-audio")[0].body).toEqual({
    name: "Quiet bed",
    sourceUrl: "https://cdn.fixture.invalid/quiet.mp3",
    defaultVolume: 0,
  });
  expect(writes("PUT", "/media-assets/background%3A21/labels")[0].body).toEqual(
    { labelIds: ["label:weather"] },
  );
});

it("uploads a background file and permits deleting only the standalone asset after confirmation", async () => {
  await ready("/media?type=AUDIO");
  fireEvent.click(screen.getByRole("button", { name: "Add background audio" }));
  const modal = await dialog("Add background audio");
  input(modal, "Weather bed", "Uploaded bed");
  chooseFiles(modal, [
    new File(["audio fixture"], "bed.mp3", { type: "audio/mpeg" }),
  ]);
  fireEvent.click(
    within(modal).getByRole("button", { name: "Add background audio" }),
  );
  await alert("Background audio added.");
  expect(writes("POST", "/uploads/background")).toHaveLength(1);
  expect(
    writes("POST", "/media-assets/background-audio")[0].body.sourceUrl,
  ).toBe("https://cdn.fixture.invalid/upload/bed.mp3");
  vi.mocked(window.confirm).mockReturnValue(false);
  fireEvent.click(
    await screen.findByRole("button", { name: "Delete Uploaded bed" }),
  );
  expect(writes("DELETE", "/media-assets/background%3A21")).toHaveLength(0);
  vi.mocked(window.confirm).mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Delete Uploaded bed" }));
  await alert("Media deleted.");
  expect(screen.queryByText("Uploaded bed")).not.toBeInTheDocument();
});

it("validates required background fields before creating an asset", async () => {
  await ready("/media?type=AUDIO");
  fireEvent.click(screen.getByRole("button", { name: "Add background audio" }));
  const modal = await dialog("Add background audio");
  fireEvent.click(
    within(modal).getByRole("button", { name: "Add background audio" }),
  );
  await alert("Name and audio file are required.");
  expect(writes("POST", "/media-assets/background-audio")).toHaveLength(0);
});

it("retains standalone audio when the service rejects deletion", async () => {
  mediaState.failures["DELETE /media-assets/background%3A3"] = json(
    { message: "audio still referenced" },
    409,
  );
  await ready("/media?type=AUDIO");
  fireEvent.click(
    await screen.findByRole("button", { name: "Delete Weather bed" }),
  );
  await alert("audio still referenced");
  expect(screen.getByText("Weather bed")).toBeInTheDocument();
});

it("filters label names locally and exposes an explicit unselected state", async () => {
  await ready("/media?view=labels");
  expect(await screen.findByText("Select a label")).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText("Search labels…"), {
    target: { value: "weather" },
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: /News.*assets/ }),
    ).not.toBeInTheDocument(),
  );
  expect(
    screen.getByRole("button", { name: /Weather.*1 asset/ }),
  ).toBeInTheDocument();
});

it("creates a label with trimmed values and selects its persisted empty membership", async () => {
  await ready("/media?view=labels");
  fireEvent.click(screen.getByRole("button", { name: "Create label" }));
  const modal = await dialog("Create label");
  input(modal, "80s, Headlines, Sponsor photos…", "  Sponsors  ");
  fireEvent.change(modal.querySelector("textarea")!, {
    target: { value: "  Paid editorial images  " },
  });
  fireEvent.click(within(modal).getByRole("button", { name: "Create label" }));
  await alert("Label created.");
  expect(writes("POST", "/media-labels")[0].body).toEqual({
    name: "Sponsors",
    description: "Paid editorial images",
  });
  expect(
    await screen.findByRole("heading", { name: "Sponsors" }),
  ).toBeInTheDocument();
  expect(screen.getByText("No media with this label")).toBeInTheDocument();
});

it("requires a nonempty label name without persisting a blank record", async () => {
  await ready("/media?view=labels");
  fireEvent.click(screen.getByRole("button", { name: "Create label" }));
  const modal = await dialog("Create label");
  fireEvent.click(within(modal).getByRole("button", { name: "Create label" }));
  await alert("Label name is required.");
  expect(writes("POST", "/media-labels")).toHaveLength(0);
});

it("edits label metadata while retaining its ordered media membership", async () => {
  await selectedNews();
  fireEvent.click(screen.getByRole("button", { name: "Edit News" }));
  const modal = await dialog("Edit label");
  input(modal, "80s, Headlines, Sponsor photos…", "  Headlines  ");
  fireEvent.change(modal.querySelector("textarea")!, {
    target: { value: " " },
  });
  fireEvent.click(within(modal).getByRole("button", { name: "Save label" }));
  await alert("Label updated.");
  expect(writes("PUT", "/media-labels/label%3Anews")[0].body).toEqual({
    name: "Headlines",
    description: null,
  });
  expect(
    await screen.findByRole("heading", { name: "Headlines" }),
  ).toBeInTheDocument();
  expect(mediaState.membership["label:news"]).toEqual([
    "image:1",
    "background:3",
  ]);
});

it("moves mixed media down and up using immutable complete order requests", async () => {
  await selectedNews();
  expect(screen.getAllByRole("button", { name: "Move up" })[0]).toBeDisabled();
  expect(
    screen.getAllByRole("button", { name: "Move down" })[1],
  ).toBeDisabled();
  fireEvent.click(screen.getAllByRole("button", { name: "Move down" })[0]);
  await waitFor(() =>
    expect(mediaState.membership["label:news"]).toEqual([
      "background:3",
      "image:1",
    ]),
  );
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Move up" })).toHaveLength(2),
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Move up" })[1]);
  await waitFor(() =>
    expect(mediaState.membership["label:news"]).toEqual([
      "image:1",
      "background:3",
    ]),
  );
  expect(
    writes("PUT", "/media-labels/label%3Anews/assets").map(
      (request) => request.body.assetIds,
    ),
  ).toEqual([
    ["background:3", "image:1"],
    ["image:1", "background:3"],
  ]);
});

it("deletes only the label definition and keeps its physical media", async () => {
  await selectedNews();
  vi.mocked(window.confirm).mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "Delete News" }));
  expect(writes("DELETE", "/media-labels/label%3Anews")).toHaveLength(0);
  vi.mocked(window.confirm).mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Delete News" }));
  await alert("Label deleted. Its media files were kept.");
  expect(screen.getByText("Select a label")).toBeInTheDocument();
  expect(mediaState.assets).toHaveLength(4);
});

it("shows the empty-label contract rather than a fabricated collection", async () => {
  mediaState.labels = [];
  mediaState.membership = {};
  await ready("/media?view=labels");
  expect(await screen.findByText("No labels yet")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Create label" }));
  fireEvent.click(
    within(await dialog("Create label")).getByRole("button", {
      name: "Cancel",
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(writes("POST", "/media-labels")).toHaveLength(0);
});

it("supports deselecting an asset without issuing a bulk mutation", async () => {
  await ready();
  const checkbox = within(
    (await screen.findByText("Sunset")).closest("article")!,
  ).getByRole("checkbox");
  fireEvent.click(checkbox);
  expect(screen.getByRole("button", { name: "Label 1" })).toBeDisabled();
  fireEvent.click(checkbox);
  expect(
    screen.queryByRole("button", { name: "Label 1" }),
  ).not.toBeInTheDocument();
  expect(
    mediaState.requests.filter((request) => request.method === "PUT"),
  ).toEqual([]);
});

it("creates and auto-selects a new bulk label using the actual inline form", async () => {
  await ready();
  fireEvent.click(
    within((await screen.findByText("City")).closest("article")!).getByRole(
      "checkbox",
    ),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "New label name" }), {
    target: { value: "  Sponsors  " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create and select" }));
  await alert("Created and selected “Sponsors”.");
  expect(screen.getByRole("button", { name: "Label 1" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Label 1" }));
  await alert("Label added to selected media.");
  expect(
    writes("PUT", "/media-assets/image%3A2/labels")[0].body.labelIds,
  ).toEqual(["label:weather", "label:21"]);
});

it("creates and selects a new image label without leaving the upload form", async () => {
  await ready();
  const modal = await imageDialog();
  input(modal, "Optional for file uploads", "Archive photo");
  input(modal, "https://…", "https://cdn.fixture.invalid/archive.png");
  fireEvent.change(
    within(modal).getByRole("textbox", { name: "New label name" }),
    { target: { value: "  Archive  " } },
  );
  fireEvent.click(
    within(modal).getByRole("button", { name: "Create and select" }),
  );
  await alert("Created and selected “Archive”.");
  expect(
    within(modal).getByRole("checkbox", { name: "Archive" }),
  ).toBeChecked();
  fireEvent.click(within(modal).getByRole("button", { name: "Add images" }));
  await alert("Added 1 image.");
  expect(
    writes("PUT", "/media-assets/image%3A22/labels")[0].body.labelIds,
  ).toEqual(["label:21"]);
});

it("does not create or select an inline label after its service rejects the name", async () => {
  mediaState.failures["POST /media-labels"] = json(
    { message: "duplicate label name" },
    409,
  );
  await ready();
  const modal = await imageDialog();
  fireEvent.change(
    within(modal).getByRole("textbox", { name: "New label name" }),
    { target: { value: "News" } },
  );
  fireEvent.click(
    within(modal).getByRole("button", { name: "Create and select" }),
  );
  await alert("duplicate label name");
  expect(
    within(modal).getByRole("checkbox", { name: "News" }),
  ).not.toBeChecked();
  expect(mediaState.labels).toHaveLength(2);
});

it("renders unlabeled assets and explains the empty label catalogue inside uploads", async () => {
  mediaState.labels = [];
  mediaState.membership = {};
  await ready();
  expect(await screen.findAllByText("Unlabeled")).toHaveLength(2);
  const modal = await imageDialog();
  expect(
    within(modal).getByText(
      "No labels yet. Create one above and it will be selected.",
    ),
  ).toBeInTheDocument();
  fireEvent.click(within(modal).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

it("keeps referenced song, instant and cover assets out of standalone deletion controls", async () => {
  mediaState.assets.push(
    asset("instant:5", "Applause", {
      mediaType: "AUDIO",
      image: null,
      capabilities: ["INSTANT"],
      instant: { id: 5, volume: 1 },
    }),
  );
  mediaState.assets.push(
    asset("song:6", "Theme song", {
      mediaType: "AUDIO",
      image: null,
      capabilities: ["SONG"],
      song: {
        id: 6,
        artist: "Fixture artist",
        title: "Theme",
        coverUrl: null,
        durationMs: 60000,
      },
    }),
  );
  mediaState.assets.push(
    asset("cover:7", "Album cover", {
      image: null,
      capabilities: ["COVER"],
      coverForSongIds: [6],
    }),
  );
  await ready("/media?type=AUDIO");
  await screen.findByText("Applause");
  expect(
    screen.queryByRole("button", { name: "Delete Applause" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Delete Theme song" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Images" }));
  await screen.findByText("Album cover");
  expect(screen.getByText("Song cover")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Delete Album cover" }),
  ).not.toBeInTheDocument();
});

it.each([
  ["move", "Failed to reorder label."],
  ["remove", "Failed to remove label."],
])(
  "preserves ordered members when a %s request fails without an Error object",
  async (action, message) => {
    mediaState.failures["PUT /media-labels/label%3Anews/assets"] =
      "fixture disconnected";
    await selectedNews();
    fireEvent.click(
      action === "move"
        ? screen.getAllByRole("button", { name: "Move down" })[0]
        : screen.getAllByRole("button", { name: "Remove label from media" })[0],
    );
    await alert(message);
    expect(mediaState.membership["label:news"]).toEqual([
      "image:1",
      "background:3",
    ]);
    expect(screen.getByText("Sunset")).toBeInTheDocument();
  },
);

it("preserves a label and its selected members after rejected deletion", async () => {
  mediaState.failures["DELETE /media-labels/label%3Anews"] = json(
    { message: "label still needed" },
    409,
  );
  await selectedNews();
  fireEvent.click(screen.getByRole("button", { name: "Delete News" }));
  await alert("label still needed");
  expect(screen.getByRole("heading", { name: "News" })).toBeInTheDocument();
});

it("shows a label save fallback while keeping entered values for retry", async () => {
  mediaState.failures["POST /media-labels"] = "fixture disconnected";
  await ready("/media?view=labels");
  fireEvent.click(screen.getByRole("button", { name: "Create label" }));
  const modal = await dialog("Create label");
  input(modal, "80s, Headlines, Sponsor photos…", "Offline label");
  fireEvent.click(within(modal).getByRole("button", { name: "Create label" }));
  await alert("Failed to save label.");
  expect(
    within(modal).getByPlaceholderText("80s, Headlines, Sponsor photos…"),
  ).toHaveValue("Offline label");
});

it("clears edited image state when cancelling before a fresh upload", async () => {
  await ready();
  fireEvent.click(await screen.findByRole("button", { name: "Edit Sunset" }));
  fireEvent.click(
    within(await dialog("Edit image")).getByRole("button", { name: "Cancel" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  const modal = await imageDialog();
  expect(
    within(modal).getByPlaceholderText("Optional for file uploads"),
  ).toHaveValue("");
  expect(within(modal).getByPlaceholderText("https://…")).toHaveValue("");
  expect(
    within(modal).getByRole("checkbox", { name: "News" }),
  ).not.toBeChecked();
  expect(
    mediaState.requests.filter((request) => request.method === "PUT"),
  ).toHaveLength(0);
});
