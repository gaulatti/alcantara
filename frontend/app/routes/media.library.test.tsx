import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MediaRoute, { meta } from "./media";

// gaulatti/alcantara#187, group G5: the media library: browsing, filtering
// and bulk-labelling assets, adding and editing images, background audio,
// and managing labels and their ordered media, with every refusal.

const authFetch = vi.hoisted(() => vi.fn());
const uploadFileToMediaBucket = vi.hoisted(() => vi.fn());
vi.mock("../services/api", () => ({ authFetch }));
vi.mock("../services/uploads", () => ({ uploadFileToMediaBucket }));
vi.mock("@gaulatti/bleecker", async (original) => {
  const kit = await import("../../test/routeKit");
  return kit.nativeSelect(
    original as () => Promise<typeof import("@gaulatti/bleecker")>,
  );
});

type Asset = Record<string, any>;
const asset = (id: string, overrides: Asset = {}): Asset => ({
  id,
  mediaType: "IMAGE",
  name: `Asset ${id}`,
  sourceUrl: `https://media.test/${id}`,
  enabled: true,
  capabilities: [],
  labels: [],
  image: null,
  instant: null,
  background: null,
  song: null,
  coverForSongIds: [],
  transition: null,
  updatedAt: "2026-11-01T00:00:00Z",
  ...overrides,
});
const label = (
  id: string,
  name: string,
  assets: Asset[] = [],
  description: string | null = null,
) => ({
  id,
  name,
  description,
  assetCount: assets.length,
  assets: assets.map((entry, position) => ({ position, asset: entry })),
  createdAt: "",
  updatedAt: "",
});

type Handler = (init?: RequestInit) => Response | Promise<Response>;
let routes: Record<string, Handler>;
let assets: Asset[];
let labels: ReturnType<typeof label>[];
let meta2: { total?: number; totalPages?: number } | undefined;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

beforeEach(() => {
  assets = [];
  labels = [];
  meta2 = undefined;
  routes = {};
  authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    const [pathname] = path.split("?");
    const key = `${init?.method ?? "GET"} ${pathname}`;
    if (routes[key]) return routes[key](init);
    if (key === "GET /media-assets") return json({ data: assets, meta: meta2 });
    if (key === "GET /media-labels")
      return json({ data: labels, meta: { totalPages: 1 } });
    return json({});
  });
  uploadFileToMediaBucket.mockImplementation(
    async (_kind: string, file: File) => ({
      url: `https://uploads.test/${file.name}`,
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  authFetch.mockReset();
  uploadFileToMediaBucket.mockReset();
});

function Shell({ programType }: { programType: string | null }) {
  const location = useLocation();
  return (
    <>
      <output aria-label="location">
        {location.pathname + location.search}
      </output>
      <Outlet context={{ programType }} />
    </>
  );
}
function open(entry = "/media", programType: string | null = "tv") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route element={<Shell programType={programType} />}>
          <Route path="media" element={<MediaRoute />} />
          <Route path="*" element={null} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}
const where = () =>
  screen.getByRole("status", { name: "location" }).textContent;
const toast = async (text: string) =>
  expect((await screen.findAllByText(text))[0]).toBeInTheDocument();
const requests = (method: string) =>
  authFetch.mock.calls
    .filter((call) => (call[1]?.method ?? "GET") === method)
    .map((call) => [
      call[0],
      call[1]?.body ? JSON.parse(String(call[1].body)) : null,
    ]);
const cardOf = (name: string) =>
  screen.getByText(name, { selector: "p" }).closest("article")!;

it("names the page for the browser", () => {
  expect(meta({} as never)).toEqual([
    { title: "Media - Alcantara" },
    {
      name: "description",
      content: "Manage images, audio, video, capabilities, and labels.",
    },
  ]);
});

it("waits for the show's type before loading anything", () => {
  open("/media", null);
  expect(authFetch).not.toHaveBeenCalled();
});

it("shows each asset with what it is used for, and pages and counts the results", async () => {
  assets = [
    asset("img", {
      image: { id: 11 },
      labels: [{ id: "l1", name: "Headlines", description: null, position: 0 }],
    }),
    asset("standalone", { mediaType: "AUDIO", capabilities: ["BACKGROUND"] }),
    asset("instant", {
      mediaType: "AUDIO",
      capabilities: ["INSTANT"],
      instant: { id: 1, volume: 1 },
    }),
    asset("song", {
      mediaType: "AUDIO",
      capabilities: ["SONG", "COVER"],
      song: { id: 1, artist: "A", title: "T", coverUrl: null, durationMs: 1 },
    }),
    asset("cover", { capabilities: ["COVER"], coverForSongIds: [3] }),
    asset("clip", {
      mediaType: "VIDEO",
      capabilities: ["TRANSITION"],
      transition: { id: 2, cutPointMs: 400 },
    }),
  ];
  meta2 = { total: 6, totalPages: 2 };
  open();
  await waitFor(() => expect(screen.getByText("6 assets")).toBeInTheDocument());
  expect(authFetch).toHaveBeenCalledWith(
    "/media-assets?page=1&limit=50&mediaType=IMAGE",
    undefined,
  );
  const img = cardOf("Asset img");
  expect(img.querySelector("img")).toHaveAttribute(
    "src",
    "https://media.test/img",
  );
  expect(img).toHaveTextContent("No capability");
  expect(img).toHaveTextContent("Headlines");
  expect(
    within(img).getByRole("button", { name: "Edit Asset img" }),
  ).toBeInTheDocument();
  const standalone = cardOf("Asset standalone");
  expect(standalone.querySelector("audio")).toHaveAttribute(
    "src",
    "https://media.test/standalone",
  );
  expect(standalone).toHaveTextContent("Background");
  expect(standalone).toHaveTextContent("Unlabeled");
  expect(
    within(standalone).getByRole("button", { name: "Delete Asset standalone" }),
  ).toBeInTheDocument();
  for (const used of [
    "Asset instant",
    "Asset song",
    "Asset cover",
    "Asset clip",
  ]) {
    expect(
      within(cardOf(used)).queryByRole("button", { name: /^Delete/ }),
    ).toBeNull();
  }
  expect(cardOf("Asset song")).toHaveTextContent("SongSong cover");
  expect(cardOf("Asset clip").querySelector("video")).toHaveAttribute(
    "src",
    "https://media.test/clip",
  );
  expect(cardOf("Asset clip")).toHaveTextContent("Transition");

  fireEvent.click(
    within(screen.getByRole("navigation", { name: "Pagination" })).getByRole(
      "button",
      { name: "2" },
    ),
  );
  await waitFor(() =>
    expect(authFetch).toHaveBeenCalledWith(
      "/media-assets?page=2&limit=50&mediaType=IMAGE",
      undefined,
    ),
  );
  cleanup();

  assets = [asset("one")];
  meta2 = { total: 1, totalPages: 1 };
  open();
  expect(await screen.findByText("1 asset")).toBeInTheDocument();
  cleanup();
  assets = [];
  meta2 = undefined;
  open();
  expect(await screen.findByText("No image media found")).toBeInTheDocument();
  expect(
    screen.getByText("This physical media type has no assets yet."),
  ).toBeInTheDocument();
  expect(screen.getByText("0 assets")).toBeInTheDocument();
});

it("searches after a pause, filters audio by use, and clears the search", async () => {
  open("/media?type=AUDIO");
  await waitFor(() =>
    expect(authFetch).toHaveBeenCalledWith(
      "/media-assets?page=1&limit=50&mediaType=AUDIO",
      undefined,
    ),
  );
  const search = screen.getByPlaceholderText("Search audio media…");
  fireEvent.change(search, { target: { value: " bed " } });
  await waitFor(() =>
    expect(authFetch).toHaveBeenCalledWith(
      "/media-assets?page=1&limit=50&mediaType=AUDIO&search=bed",
      undefined,
    ),
  );
  expect(
    await screen.findByText("Clear the filters and try again."),
  ).toBeInTheDocument();
  fireEvent.click(
    within(screen.getByRole("group", { name: "Capability" })).getByRole(
      "button",
      { name: "Instant" },
    ),
  );
  await waitFor(() =>
    expect(authFetch).toHaveBeenCalledWith(
      "/media-assets?page=1&limit=50&mediaType=AUDIO&search=bed&capability=INSTANT",
      undefined,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(search).toHaveValue("");
  await waitFor(() =>
    expect(authFetch).toHaveBeenCalledWith(
      "/media-assets?page=1&limit=50&mediaType=AUDIO&capability=INSTANT",
      undefined,
    ),
  );
  expect(
    await screen.findByText("Clear the filters and try again."),
  ).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Manage instant audio" }));
  await waitFor(() => expect(where()).toBe("/instants"));
});

it("opens the song and transition managers", async () => {
  open("/media?type=AUDIO");
  fireEvent.click(await screen.findByRole("button", { name: "Manage songs" }));
  await waitFor(() => expect(where()).toBe("/songs"));
  cleanup();
  open("/media?type=VIDEO");
  fireEvent.click(
    await screen.findByRole("button", { name: "Manage transitions" }),
  );
  await waitFor(() => expect(where()).toBe("/stingers"));
});

it("reports a library that cannot load", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  routes["GET /media-assets"] = () =>
    json({ message: "Database unavailable" }, 503);
  open();
  await toast("Failed to load the media library.");
  cleanup();
  routes["GET /media-assets"] = () => json({ data: "nope" });
  open();
  expect(await screen.findByText("No image media found")).toBeInTheDocument();
});

it("lists audio as rows with the stored analysis and one shared transport, and labels or deletes from them", async () => {
  assets = [
    asset("song", {
      mediaType: "AUDIO",
      capabilities: ["SONG"],
      song: {
        id: 1,
        artist: "A",
        title: "T",
        coverUrl: null,
        durationMs: 200_000,
      },
      analysis: {
        status: "success",
        cueInSeconds: 1,
        cueOutSeconds: 190,
        fadeInSeconds: null,
        fadeOutSeconds: null,
        overlapSeconds: null,
        integratedLufs: -11.5,
        truePeakDbtp: -1.2,
      },
    }),
    asset("bed", { mediaType: "AUDIO", capabilities: ["BACKGROUND"] }),
  ];
  labels = [label("l1", "Headlines")];
  meta2 = { total: 2, totalPages: 1 };
  open("/media?type=AUDIO");
  await waitFor(() => expect(screen.getByText("2 assets")).toBeInTheDocument());
  const table = within(screen.getByRole("table"));
  const song = table.getByText("Asset song").closest("tr")!;
  expect(song).toHaveTextContent("3:20");
  expect(song).toHaveTextContent("-11.5");
  expect(song).toHaveTextContent("Measured");
  // A response with no analysis says so; it is not shown as a file that was never analysed.
  expect(table.getByText("Asset bed").closest("tr")).toHaveTextContent(
    "Analysis unavailable",
  );
  expect(document.querySelectorAll("audio")).toHaveLength(1);
  expect(
    within(screen.getByRole("group", { name: "Audio transport" })).getByText(
      "Asset song",
    ),
  ).toBeInTheDocument();

  // Bulk labelling works from the rows, as it did from the cards.
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Asset bed" }));
  fireEvent.change(screen.getAllByRole("combobox").at(-1)!, {
    target: { value: "l1" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Label 1/ }));
  await toast("Label added to selected media.");
  expect(requests("PUT")).toEqual([
    ["/media-assets/bed/labels", { labelIds: ["l1"] }],
  ]);

  // A standalone clip can be deleted from its detail panel; a song cannot.
  fireEvent.click(table.getByText("Asset bed").closest("tr")!);
  routes["DELETE /media-assets/bed"] = () => json({});
  vi.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Delete Asset bed" }));
  await waitFor(() =>
    expect(requests("DELETE")).toContainEqual(["/media-assets/bed", null]),
  );
  fireEvent.click(table.getByText("Asset song").closest("tr")!);
  expect(screen.queryByRole("button", { name: "Delete Asset song" })).toBeNull();
});

it("labels the selected media in bulk, creating a label on the way", async () => {
  assets = [
    asset("a", {
      labels: [{ id: "l1", name: "Headlines", description: null, position: 0 }],
    }),
    asset("b"),
  ];
  labels = [label("l1", "Headlines"), label("l2", "Sponsors")];
  meta2 = { total: 2, totalPages: 1 };
  open();
  await waitFor(() => expect(screen.getByText("2 assets")).toBeInTheDocument());
  const check = (name: string) =>
    cardOf(name).querySelector("input[type=checkbox]") as HTMLInputElement;
  fireEvent.click(check("Asset a"));
  fireEvent.click(check("Asset b"));
  fireEvent.click(check("Asset b"));
  fireEvent.click(check("Asset b"));
  expect(screen.getByRole("button", { name: /Label 2/ })).toBeDisabled();

  routes["POST /media-labels"] = () => json(label("l3", "Archive"));
  fireEvent.change(screen.getByRole("textbox", { name: "New label name" }), {
    target: { value: " Archive " },
  });
  fireEvent.click(screen.getByRole("button", { name: /Create and select/ }));
  await toast("Created and selected “Archive”.");
  expect(requests("POST")).toContainEqual([
    "/media-labels",
    { name: "Archive", description: null },
  ]);
  const bulk = screen.getAllByRole("combobox").at(-1) as HTMLSelectElement;
  expect(bulk).toHaveValue("l3");
  expect(
    within(bulk)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["Choose label…", "Archive", "Headlines", "Sponsors"]);
  fireEvent.change(bulk, { target: { value: "l1" } });
  fireEvent.click(screen.getByRole("button", { name: /Label 2/ }));
  await toast("Label added to selected media.");
  expect(requests("PUT")).toEqual([
    ["/media-assets/a/labels", { labelIds: ["l1"] }],
    ["/media-assets/b/labels", { labelIds: ["l1"] }],
  ]);
  expect(screen.queryByRole("button", { name: /Label 2/ })).toBeNull();

  fireEvent.click(check("Asset b"));
  fireEvent.change(screen.getAllByRole("combobox").at(-1)!, {
    target: { value: "l2" },
  });
  routes["PUT /media-assets/b/labels"] = () =>
    json({ message: ["labelIds must be unique", "label is archived"] }, 400);
  fireEvent.click(screen.getByRole("button", { name: /Label 1/ }));
  await toast("labelIds must be unique, label is archived");
  routes["PUT /media-assets/b/labels"] = () => {
    throw "offline";
  };
  fireEvent.click(screen.getByRole("button", { name: /Label 1/ }));
  await toast("Failed to label selected media.");
});

it("ignores a labels answer that arrives after a label was created inline", async () => {
  assets = [asset("a")];
  routes["POST /media-labels"] = () => json(label("l9", "Fresh"));
  open();
  fireEvent.click(await screen.findByRole("button", { name: /Add images/ }));
  const dialog = await screen.findByRole("dialog", { name: "Add images" });
  // A search reloads the library; its labels answer is held back.
  let answer: (response: Response) => void = () => {};
  routes["GET /media-labels"] = () =>
    new Promise((resolve) => (answer = resolve));
  fireEvent.change(screen.getByPlaceholderText("Search image media…"), {
    target: { value: "x" },
  });
  await waitFor(() =>
    expect(authFetch).toHaveBeenCalledWith(
      "/media-assets?page=1&limit=50&mediaType=IMAGE&search=x",
      undefined,
    ),
  );
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: "New label name" }),
    { target: { value: "Fresh" } },
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: /Create and select/ }),
  );
  await waitFor(() =>
    expect(
      within(dialog).getByRole("checkbox", { name: "Fresh" }),
    ).toBeChecked(),
  );
  await act(async () =>
    answer(json({ data: [label("old", "Stale")], meta: { totalPages: 1 } })),
  );
  expect(within(dialog).queryByRole("checkbox", { name: "Stale" })).toBeNull();
  expect(
    within(dialog).getByRole("checkbox", { name: "Fresh" }),
  ).toBeInTheDocument();
});

it("adds images from files, naming them from the files or a shared name, with labels", async () => {
  labels = [label("l1", "Headlines")];
  routes["POST /media"] = (init) => {
    const body = JSON.parse(String(init!.body));
    return json({
      id: 1,
      assetId: `asset-${body.name}`,
      name: body.name,
      imageUrl: body.imageUrl,
    });
  };
  open();
  fireEvent.click(await screen.findByRole("button", { name: /Add images/ }));
  let dialog = await screen.findByRole("dialog", { name: "Add images" });
  const files = dialog.querySelector('input[type="file"]') as HTMLInputElement;
  expect(files).toHaveAttribute("multiple");
  fireEvent.change(files, {
    target: {
      files: [
        new File(["a"], " Sunset.final.png "),
        new File(["b"], "noext"),
        new File(["c"], ""),
      ],
    },
  });
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Headlines" }));
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Headlines" }));
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Headlines" }));
  let save: (value: unknown) => void = () => {};
  uploadFileToMediaBucket.mockImplementationOnce(
    (_kind: string, file: File) =>
      new Promise(
        (resolve) =>
          (save = () => resolve({ url: `https://uploads.test/${file.name}` })),
      ),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Add images" }));
  expect(
    await within(dialog).findByRole("button", { name: "Saving…" }),
  ).toBeDisabled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(
    screen.getByRole("dialog", { name: "Add images" }),
  ).toBeInTheDocument();
  await act(async () => save(undefined));
  await toast("Added 3 images.");
  expect(requests("POST").map(([, body]) => body.name)).toEqual([
    "Sunset.final",
    "noext",
    "Image 3",
  ]);
  expect(requests("PUT")).toEqual([
    ["/media-assets/asset-Sunset.final/labels", { labelIds: ["l1"] }],
    ["/media-assets/asset-noext/labels", { labelIds: ["l1"] }],
    ["/media-assets/asset-Image%203/labels", { labelIds: ["l1"] }],
  ]);

  // A shared name numbers several files, and names a single one as given.
  authFetch.mockClear();
  fireEvent.click(screen.getByRole("button", { name: /Add images/ }));
  dialog = await screen.findByRole("dialog", { name: "Add images" });
  fireEvent.change(
    within(dialog).getByPlaceholderText("Optional for file uploads"),
    { target: { value: " Studio " } },
  );
  fireEvent.change(dialog.querySelector('input[type="file"]')!, {
    target: { files: [new File(["a"], "a.png"), new File(["b"], "b.png")] },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add images" }));
  await toast("Added 2 images.");
  expect(requests("POST").map(([, body]) => body.name)).toEqual([
    "Studio 1",
    "Studio 2",
  ]);
  expect(requests("PUT")).toEqual([]);

  authFetch.mockClear();
  fireEvent.click(screen.getByRole("button", { name: /Add images/ }));
  dialog = await screen.findByRole("dialog", { name: "Add images" });
  fireEvent.change(
    within(dialog).getByPlaceholderText("Optional for file uploads"),
    { target: { value: "Studio" } },
  );
  fireEvent.change(dialog.querySelector('input[type="file"]')!, {
    target: { files: [new File(["a"], "a.png")] },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add images" }));
  await toast("Added 1 image.");
  expect(requests("POST")).toEqual([
    ["/media", { name: "Studio", imageUrl: "https://uploads.test/a.png" }],
  ]);
});

it("adds an image from a URL, and refuses one with nothing to add", async () => {
  routes["POST /media"] = () =>
    json({
      id: 2,
      assetId: "asset-url",
      name: "Logo",
      imageUrl: "https://cdn.test/logo.png",
    });
  open();
  fireEvent.click(await screen.findByRole("button", { name: /Add images/ }));
  const dialog = await screen.findByRole("dialog", { name: "Add images" });
  expect(
    within(dialog).getByText(
      "No labels yet. Create one above and it will be selected.",
    ),
  ).toBeInTheDocument();
  const add = () =>
    fireEvent.click(within(dialog).getByRole("button", { name: "Add images" }));
  add();
  await toast("Select at least one image or provide an image URL.");
  fireEvent.change(within(dialog).getByPlaceholderText("https://…"), {
    target: { value: " https://cdn.test/logo.png " },
  });
  add();
  await toast("Name is required for a direct URL.");
  fireEvent.change(
    within(dialog).getByPlaceholderText("Optional for file uploads"),
    { target: { value: "Logo" } },
  );
  // A label created here is selected for the new image.
  routes["POST /media-labels"] = () => json(label("l5", "Brand"));
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: "New label name" }),
    { target: { value: "Brand" } },
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: /Create and select/ }),
  );
  await waitFor(() =>
    expect(
      within(dialog).getByRole("checkbox", { name: "Brand" }),
    ).toBeChecked(),
  );
  add();
  await toast("Added 1 image.");
  expect(requests("POST")).toContainEqual([
    "/media",
    { name: "Logo", imageUrl: "https://cdn.test/logo.png" },
  ]);
  expect(requests("PUT")).toEqual([
    ["/media-assets/asset-url/labels", { labelIds: ["l5"] }],
  ]);
});

it("explains an image that was added but not fully set up, and a save that failed", async () => {
  labels = [label("l1", "Headlines")];
  let created = 0;
  routes["POST /media"] = () => {
    created += 1;
    return created === 2
      ? new Response("Image limit reached", { status: 409 })
      : json({ id: created, assetId: `a${created}`, name: "x", imageUrl: "u" });
  };
  open();
  fireEvent.click(await screen.findByRole("button", { name: /Add images/ }));
  let dialog = await screen.findByRole("dialog", { name: "Add images" });
  fireEvent.change(dialog.querySelector('input[type="file"]')!, {
    target: { files: [new File(["a"], "a.png"), new File(["b"], "b.png")] },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add images" }));
  await toast(
    "1 image was added, but setup did not finish. Check the existing images and edit their labels before trying again.",
  );
  expect(screen.queryByRole("dialog", { name: "Add images" })).toBeNull();

  routes["POST /media"] = () =>
    json({ id: 9, assetId: "a9", name: "x", imageUrl: "u" });
  routes["PUT /media-assets/a9/labels"] = () =>
    new Response("", { status: 500 });
  fireEvent.click(screen.getByRole("button", { name: /Add images/ }));
  dialog = await screen.findByRole("dialog", { name: "Add images" });
  fireEvent.change(dialog.querySelector('input[type="file"]')!, {
    target: { files: [new File(["a"], "a.png"), new File(["b"], "b.png")] },
  });
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Headlines" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Add images" }));
  await toast(
    "2 images were added, but setup did not finish. Check the existing images and edit their labels before trying again.",
  );

  uploadFileToMediaBucket.mockRejectedValueOnce("network down");
  fireEvent.click(screen.getByRole("button", { name: /Add images/ }));
  dialog = await screen.findByRole("dialog", { name: "Add images" });
  fireEvent.change(dialog.querySelector('input[type="file"]')!, {
    target: { files: [new File(["a"], "a.png")] },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add images" }));
  await toast("Failed to save image.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Add images" })).toBeNull(),
  );
});

it("edits an image's name, picture and labels, and deletes images and standalone media", async () => {
  assets = [
    asset("img", {
      image: { id: 11 },
      labels: [{ id: "l1", name: "Headlines", description: null, position: 0 }],
    }),
    asset("bed", { mediaType: "AUDIO" }),
  ];
  labels = [label("l1", "Headlines"), label("l2", "Sponsors")];
  open();
  await waitFor(() => expect(screen.queryByText("Asset img")).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Edit Asset img" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit image" });
  expect(within(dialog).getByPlaceholderText("Image name")).toHaveValue(
    "Asset img",
  );
  expect(within(dialog).getByText("Replace image")).toBeInTheDocument();
  expect(dialog.querySelector('input[type="file"]')).not.toHaveAttribute(
    "multiple",
  );
  expect(
    within(dialog).getByRole("checkbox", { name: "Headlines" }),
  ).toBeChecked();
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Sponsors" }));

  // Name and picture are required.
  fireEvent.change(within(dialog).getByPlaceholderText("Image name"), {
    target: { value: " " },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save image" }));
  await toast("Name and image are required.");
  fireEvent.change(within(dialog).getByPlaceholderText("Image name"), {
    target: { value: " Front page " },
  });
  fireEvent.change(within(dialog).getByPlaceholderText("https://…"), {
    target: { value: "" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save image" }));
  await waitFor(() =>
    expect(
      screen.getAllByText("Name and image are required.").length,
    ).toBeGreaterThan(0),
  );
  fireEvent.change(dialog.querySelector('input[type="file"]')!, {
    target: { files: [new File(["x"], "front.png")] },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save image" }));
  await toast("Image updated.");
  expect(requests("PUT")).toEqual([
    [
      "/media/11",
      { name: "Front page", imageUrl: "https://uploads.test/front.png" },
    ],
    ["/media-assets/img/labels", { labelIds: ["l1", "l2"] }],
  ]);

  // Without a new file the URL stays.
  authFetch.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Edit Asset img" }));
  const again = await screen.findByRole("dialog", { name: "Edit image" });
  fireEvent.click(within(again).getByRole("button", { name: "Save image" }));
  await waitFor(() =>
    expect(requests("PUT")[0]).toEqual([
      "/media/11",
      { name: "Asset img", imageUrl: "https://media.test/img" },
    ]),
  );

  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "Delete Asset img" }));
  expect(confirm).toHaveBeenCalledWith("Delete “Asset img”?");
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Delete Asset img" }));
  await toast("Image deleted.");
  expect(requests("DELETE")).toEqual([["/media/11", null]]);
  routes["DELETE /media/11"] = () =>
    new Response("Image is on air", { status: 409 });
  fireEvent.click(screen.getByRole("button", { name: "Delete Asset img" }));
  await toast("Image is on air");
  routes["DELETE /media/11"] = () => {
    throw "offline";
  };
  fireEvent.click(screen.getByRole("button", { name: "Delete Asset img" }));
  await toast("Failed to delete image.");

  fireEvent.click(screen.getByRole("button", { name: "Delete Asset bed" }));
  await toast("Media deleted.");
  routes["DELETE /media-assets/bed"] = () =>
    json({ message: "Still referenced" }, 409);
  fireEvent.click(screen.getByRole("button", { name: "Delete Asset bed" }));
  await toast("Still referenced");
  routes["DELETE /media-assets/bed"] = () => {
    throw "offline";
  };
  fireEvent.click(screen.getByRole("button", { name: "Delete Asset bed" }));
  await toast("Failed to delete media.");
  confirm.mockReturnValue(false);
  const before = requests("DELETE").length;
  fireEvent.click(screen.getByRole("button", { name: "Delete Asset bed" }));
  expect(requests("DELETE").length).toBe(before);
});

it("adds background audio from a file or a URL, with labels and a default volume", async () => {
  labels = [label("l1", "Beds")];
  routes["POST /media-assets/background-audio"] = (init) =>
    json(asset("new-bed", { name: JSON.parse(String(init!.body)).name }));
  open("/media?type=AUDIO");
  fireEvent.click(
    await screen.findByRole("button", { name: /Add background audio/ }),
  );
  let dialog = await screen.findByRole("dialog", {
    name: "Add background audio",
  });
  const add = () =>
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Add background audio" }),
    );
  add();
  await toast("Name and audio file are required.");
  fireEvent.change(within(dialog).getByPlaceholderText("Weather bed"), {
    target: { value: " Weather bed " },
  });
  fireEvent.change(dialog.querySelector('input[type="file"]')!, {
    target: { files: [new File(["a"], "bed.mp3")] },
  });
  fireEvent.change(within(dialog).getByRole("spinbutton"), {
    target: { value: "0.4" },
  });
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Beds" }));
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Beds" }));
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Beds" }));
  let finish: (value: unknown) => void = () => {};
  uploadFileToMediaBucket.mockImplementationOnce(
    () => new Promise((resolve) => (finish = resolve)),
  );
  add();
  expect(
    await within(dialog).findByRole("button", { name: "Saving…" }),
  ).toBeDisabled();
  await act(async () => finish({ url: "https://uploads.test/bed.mp3" }));
  await toast("Background audio added.");
  expect(uploadFileToMediaBucket).toHaveBeenCalledWith(
    "background",
    expect.any(File),
  );
  expect(requests("POST")).toContainEqual([
    "/media-assets/background-audio",
    {
      name: "Weather bed",
      sourceUrl: "https://uploads.test/bed.mp3",
      defaultVolume: 0.4,
    },
  ]);
  expect(requests("PUT")).toEqual([
    ["/media-assets/new-bed/labels", { labelIds: ["l1"] }],
  ]);

  // From a URL, with a label created here and no file.
  authFetch.mockClear();
  routes["POST /media-labels"] = () => json(label("l2", "News beds"));
  fireEvent.click(screen.getByRole("button", { name: /Add background audio/ }));
  dialog = await screen.findByRole("dialog", { name: "Add background audio" });
  fireEvent.change(within(dialog).getByPlaceholderText("Weather bed"), {
    target: { value: "Bed two" },
  });
  fireEvent.change(dialog.querySelector('input[type="file"]')!, {
    target: { files: [] },
  });
  fireEvent.change(within(dialog).getByPlaceholderText("https://…"), {
    target: { value: " https://cdn.test/two.mp3 " },
  });
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: "New label name" }),
    { target: { value: "News beds" } },
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: /Create and select/ }),
  );
  await waitFor(() =>
    expect(
      within(dialog).getByRole("checkbox", { name: "News beds" }),
    ).toBeChecked(),
  );
  add();
  await toast("Background audio added.");
  expect(requests("POST")).toContainEqual([
    "/media-assets/background-audio",
    {
      name: "Bed two",
      sourceUrl: "https://cdn.test/two.mp3",
      defaultVolume: 1,
    },
  ]);

  // Refusals, and Cancel.
  fireEvent.click(screen.getByRole("button", { name: /Add background audio/ }));
  dialog = await screen.findByRole("dialog", { name: "Add background audio" });
  fireEvent.change(within(dialog).getByPlaceholderText("Weather bed"), {
    target: { value: "Bed three" },
  });
  fireEvent.change(within(dialog).getByPlaceholderText("https://…"), {
    target: { value: "https://cdn.test/3.mp3" },
  });
  routes["POST /media-assets/background-audio"] = () =>
    new Response("", { status: 502 });
  add();
  await toast("HTTP 502");
  routes["POST /media-assets/background-audio"] = () => {
    throw "offline";
  };
  add();
  await toast("Failed to add background audio.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Add background audio" }),
    ).toBeNull(),
  );
});

const labelRow = (name: string) =>
  within(screen.getByRole("table")).getByText(name).closest("tr")!;

it("manages labels: search, create, edit, delete, and the ordered media in each", async () => {
  const a = asset("a", { name: "Alpha" });
  const b = asset("b", { name: "Beta", mediaType: "AUDIO" });
  const c = asset("c", { name: "Gamma" });
  assets = [c, a, b];
  labels = [
    label("l1", "Headlines", [a, b], "Front page photos"),
    label("l2", "Sponsors", [], null),
  ];
  open("/media?view=labels");
  expect(await screen.findByText("Select a label")).toBeInTheDocument();
  expect(authFetch).toHaveBeenCalledWith(
    "/media-assets?page=1&limit=200",
    undefined,
  );
  // The management table: each label's media mix and count.
  expect(labelRow("Headlines")).toHaveTextContent("1 audio");
  expect(labelRow("Headlines")).toHaveTextContent("1 image");
  expect(labelRow("Headlines")).toHaveTextContent("Front page photos");
  expect(within(labelRow("Headlines")).getByRole("img")).toHaveAttribute(
    "aria-label",
    "1 audio, 1 image",
  );
  expect(labelRow("Headlines").cells[2]).toHaveTextContent("2");
  expect(labelRow("Sponsors")).toHaveTextContent("No media");
  expect(labelRow("Sponsors").cells[2]).toHaveTextContent("0");
  fireEvent.change(screen.getByPlaceholderText("Search labels…"), {
    target: { value: "spon" },
  });
  await waitFor(() =>
    expect(
      within(screen.getByRole("table")).queryByText("Headlines"),
    ).toBeNull(),
  );
  fireEvent.change(screen.getByPlaceholderText("Search labels…"), {
    target: { value: "" },
  });
  await waitFor(() => expect(labelRow("Headlines")).toBeInTheDocument());

  fireEvent.click(labelRow("Sponsors"));
  expect(
    await screen.findByText("No media with this label"),
  ).toBeInTheDocument();
  fireEvent.click(labelRow("Headlines"));
  expect(
    screen.getByRole("heading", { name: "Headlines" }),
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole("complementary", { name: "Headlines details" })).getByText(
      "Front page photos",
    ),
  ).toBeInTheDocument();
  const rows = () =>
    Array.from(document.querySelectorAll<HTMLElement>("aside ol li"));
  expect(rows().map((row) => row.textContent)).toEqual([
    "1Alphaimage",
    "2Betaaudio",
  ]);
  expect(
    within(rows()[0]).getByRole("button", { name: /^Move .* up$/ }),
  ).toBeDisabled();
  expect(
    within(rows()[1]).getByRole("button", { name: /^Move .* down$/ }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Add assets" }));
  const chooser = screen.getAllByRole("combobox").at(-1) as HTMLSelectElement;
  expect(
    within(chooser)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["Choose media…", "Gamma · image"]);

  // Reorder, add and remove, each saved as the label's order.
  routes["PUT /media-labels/l1/assets"] = (init) => {
    const ids: string[] = JSON.parse(String(init!.body)).assetIds;
    labels[0] = label(
      "l1",
      "Headlines",
      ids.map((id) => [a, b, c].find((entry) => entry.id === id)!),
      "Front page photos",
    );
    return json(labels[0]);
  };
  fireEvent.click(within(rows()[0]).getByRole("button", { name: /^Move .* down$/ }));
  await waitFor(() =>
    expect(rows().map((row) => row.textContent)).toEqual([
      "1Betaaudio",
      "2Alphaimage",
    ]),
  );
  fireEvent.click(within(rows()[1]).getByRole("button", { name: /^Move .* up$/ }));
  await waitFor(() =>
    expect(rows().map((row) => row.textContent)).toEqual([
      "1Alphaimage",
      "2Betaaudio",
    ]),
  );
  expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  fireEvent.change(screen.getAllByRole("combobox").at(-1)!, {
    target: { value: "c" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(rows()).toHaveLength(3));
  expect(screen.getAllByRole("combobox").at(-1)).toHaveValue("");
  fireEvent.click(
    within(rows()[1]).getByRole("button", { name: /^Remove .* from Headlines$/ }),
  );
  await waitFor(() =>
    expect(rows().map((row) => row.textContent)).toEqual([
      "1Alphaimage",
      "2Gammaimage",
    ]),
  );
  expect(requests("PUT").map(([, body]) => body.assetIds)).toEqual([
    ["b", "a"],
    ["a", "b"],
    ["a", "b", "c"],
    ["a", "c"],
  ]);

  // Each order change can be refused.
  routes["PUT /media-labels/l1/assets"] = () =>
    new Response("Label is locked", { status: 423 });
  fireEvent.click(within(rows()[0]).getByRole("button", { name: /^Move .* down$/ }));
  await toast("Label is locked");
  routes["PUT /media-labels/l1/assets"] = () => {
    throw "offline";
  };
  fireEvent.click(within(rows()[0]).getByRole("button", { name: /^Move .* down$/ }));
  await toast("Failed to reorder label.");
  fireEvent.click(
    within(rows()[0]).getByRole("button", { name: /^Remove .* from Headlines$/ }),
  );
  await toast("Failed to remove label.");
  fireEvent.change(screen.getAllByRole("combobox").at(-1)!, {
    target: { value: "b" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await toast("Failed to add media to label.");
  routes["PUT /media-labels/l1/assets"] = () =>
    new Response("Too many", { status: 400 });
  fireEvent.click(
    within(rows()[0]).getByRole("button", { name: /^Remove .* from Headlines$/ }),
  );
  await toast("Too many");
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() =>
    expect(screen.getAllByText("Too many").length).toBeGreaterThan(1),
  );
});

it("creates, edits and deletes labels, and drops a label deleted elsewhere", async () => {
  labels = [label("l1", "Headlines", [], "Old description")];
  routes["POST /media-labels"] = (init) => {
    const body = JSON.parse(String(init!.body));
    labels.push(label("l2", body.name, [], body.description));
    return json(labels.at(-1));
  };
  routes["PUT /media-labels/l1"] = (init) => {
    const body = JSON.parse(String(init!.body));
    labels[0] = label("l1", body.name, [], body.description);
    return json(labels[0]);
  };
  open("/media?view=labels");
  fireEvent.click(await screen.findByRole("button", { name: /New label/ }));
  let dialog = await screen.findByRole("dialog", { name: "Create label" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create label" }));
  await toast("Label name is required.");
  fireEvent.change(
    within(dialog).getByPlaceholderText("80s, Headlines, Sponsor photos…"),
    { target: { value: " Sponsors " } },
  );
  fireEvent.change(dialog.querySelector("textarea")!, {
    target: { value: " " },
  });
  let save: (response: Response) => void = () => {};
  const original = routes["POST /media-labels"];
  routes["POST /media-labels"] = (init) =>
    new Promise(
      (resolve) => (save = () => resolve(original(init) as Response)),
    );
  fireEvent.click(within(dialog).getByRole("button", { name: "Create label" }));
  expect(
    await within(dialog).findByRole("button", { name: "Saving…" }),
  ).toBeDisabled();
  await act(async () => save(new Response()));
  await toast("Label created.");
  expect(requests("POST")).toContainEqual([
    "/media-labels",
    { name: "Sponsors", description: null },
  ]);
  expect(
    await screen.findByRole("heading", { name: "Sponsors" }),
  ).toBeInTheDocument();

  fireEvent.click(labelRow("Headlines"));
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  dialog = await screen.findByRole("dialog", { name: "Edit label" });
  expect(dialog.querySelector("textarea")).toHaveValue("Old description");
  fireEvent.change(dialog.querySelector("textarea")!, {
    target: { value: " Front pages " },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save label" }));
  await toast("Label updated.");
  expect(requests("PUT")).toContainEqual([
    "/media-labels/l1",
    { name: "Headlines", description: "Front pages" },
  ]);

  // A refused save, then Cancel.
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  dialog = await screen.findByRole("dialog", { name: "Edit label" });
  routes["PUT /media-labels/l1"] = () => json({ message: "Name taken" }, 409);
  fireEvent.click(within(dialog).getByRole("button", { name: "Save label" }));
  await toast("Name taken");
  routes["PUT /media-labels/l1"] = () => {
    throw "offline";
  };
  fireEvent.click(within(dialog).getByRole("button", { name: "Save label" }));
  await toast("Failed to save label.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Edit label" })).toBeNull(),
  );

  // Delete: only after confirming; the selection clears; refusals are shown.
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "Delete Headlines" }));
  expect(confirm).toHaveBeenCalledWith(
    "Delete label “Headlines”? Files will remain in the library.",
  );
  confirm.mockReturnValue(true);
  routes["DELETE /media-labels/l1"] = () =>
    json({ message: "Label in use" }, 409);
  fireEvent.click(screen.getByRole("button", { name: "Delete Headlines" }));
  await toast("Label in use");
  routes["DELETE /media-labels/l1"] = () => {
    throw "offline";
  };
  fireEvent.click(screen.getByRole("button", { name: "Delete Headlines" }));
  await toast("Failed to delete label.");
  routes["DELETE /media-labels/l1"] = () => {
    labels = labels.filter((entry) => entry.id !== "l1");
    return json({});
  };
  fireEvent.click(screen.getByRole("button", { name: "Delete Headlines" }));
  await toast("Label deleted. Its media files were kept.");
  expect(await screen.findByText("Select a label")).toBeInTheDocument();

  // Deleting a label that is not selected keeps the selection.
  fireEvent.click(labelRow("Sponsors"));
  routes["DELETE /media-labels/l2"] = () => json({});
  labels.push(label("l3", "Other"));
  fireEvent.click(screen.getByRole("button", { name: "Delete Sponsors" }));
  await toast("Label deleted. Its media files were kept.");
});

it("says when there are no labels yet", async () => {
  open("/media?view=labels");
  expect(await screen.findByText("No labels yet")).toBeInTheDocument();
});

it("counts a single asset, edits a label without a description, and drops a label gone after a reload", async () => {
  const a = asset("a", { name: "Alpha" });
  labels = [label("l1", "Headlines", [a]), label("l2", "Sponsors")];
  routes["PUT /media-labels/l1"] = (init) => {
    const body = JSON.parse(String(init!.body));
    // Someone else removed Sponsors meanwhile.
    labels = [label("l1", body.name, [a], body.description)];
    return json(labels[0]);
  };
  open("/media?view=labels");
  await screen.findByRole("table");
  expect(labelRow("Headlines").cells[2]).toHaveTextContent("1");
  expect(labelRow("Headlines")).toHaveTextContent("1 image");
  fireEvent.click(labelRow("Headlines"));
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit label" });
  expect(dialog.querySelector("textarea")).toHaveValue("");
  fireEvent.click(labelRow("Sponsors"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Save label" }));
  await toast("Label updated.");
  await waitFor(() =>
    expect(
      within(screen.getByRole("table")).queryByText("Sponsors"),
    ).toBeNull(),
  );
  expect(
    screen.getByRole("heading", { name: "Headlines" }),
  ).toBeInTheDocument();

  // A reload that no longer has the selected label clears the selection.
  labels = [];
  fireEvent.change(screen.getByPlaceholderText("Search labels…"), {
    target: { value: "head" },
  });
  expect(await screen.findByText("No labels yet")).toBeInTheDocument();
});
