import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import InstantsAdmin, { meta } from "./instants";
import { uploadFileToMediaBucket } from "../services/uploads";
import { routeFetch } from "../../test/routeKit";
import {
  cancelConfirmation,
  chooseFromRowMenu,
  confirmWith,
  confirmation,
  rowAction,
  rowMenuLabels,
} from "../../test/libraryKit";

// The audio clips page: list, play, stop, create, edit and delete clips.

vi.mock("@gaulatti/bleecker", async (original) =>
  (await import("../../test/libraryKit")).libraryBleecker(
    original as () => Promise<typeof import("@gaulatti/bleecker")>,
  ),
);
vi.mock("../services/uploads", () => ({ uploadFileToMediaBucket: vi.fn() }));
vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => ["night radio"],
}));

type Clip = {
  id: number;
  name: string;
  audioUrl: string;
  volume: number;
  enabled: boolean;
  position: number;
};
let clips: Clip[];

function serve(overrides: Partial<Record<string, () => Response>> = {}) {
  const { fetchMock, calls } = routeFetch((url, init) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${new URL(url).pathname}`;
    if (overrides[key]) return overrides[key]!();
    if (key === "GET /instants") return Response.json(clips);
    if (method === "POST" && /\/(play|stop-all)$/.test(key))
      return new Response(null, { status: 204 });
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (key === "POST /instants") {
      clips = [...clips, { id: 9, position: 9, ...body }];
      return Response.json({});
    }
    const id = Number(url.split("/").pop());
    if (method === "PUT") {
      clips = clips.map((clip) =>
        clip.id === id ? { ...clip, ...body } : clip,
      );
      return Response.json({});
    }
    if (method === "DELETE") {
      clips = clips.filter((clip) => clip.id !== id);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${key}`);
  });
  vi.stubGlobal("fetch", vi.fn(fetchMock));
  return calls;
}

// Bleecker renders its modal as a div with role="dialog"; a plain selector
// keeps lookups inside the large template and clip forms fast.
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement;
const dialogButton = (text: string) =>
  within(dialog())
    .getAllByText(text)
    .map((element) => element.closest("button"))
    .find(Boolean) as HTMLButtonElement;
const toast = async (text: string) =>
  expect((await screen.findAllByText(text))[0]).toBeVisible();
const nameInput = () => within(dialog()).getByPlaceholderText("Hit FX");
const volumeInput = () =>
  dialog().querySelector('input[type="number"]') as HTMLInputElement;
const fileInput = () =>
  dialog().querySelector('input[type="file"]') as HTMLInputElement;
const audio = new File(["ogg"], "sweep.ogg", { type: "audio/ogg" });
const tableRows = () =>
  within(screen.getByRole("table"))
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.textContent);

function openCreate() {
  fireEvent.click(
    screen.getAllByText("Create audio clip")[0].closest("button")!,
  );
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  clips = [
    {
      id: 2,
      name: "Station ID",
      audioUrl: "https://media.example/id.ogg",
      volume: 0.8,
      enabled: true,
      position: 2,
    },
    {
      id: 1,
      name: "Applause",
      audioUrl: "https://media.example/applause.ogg",
      volume: 1,
      enabled: false,
      position: 1,
    },
  ];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("has a page title and description", () => {
  expect(meta({} as never)).toEqual([
    { title: "Audio clips - Alcantara" },
    {
      name: "description",
      content: "Manage reusable audio clips and sounders",
    },
  ]);
});

it("lists clips by position in one dense, sortable table", async () => {
  serve();
  render(<InstantsAdmin />);
  expect(screen.getByLabelText("Loading Audio clips")).toBeVisible();
  await screen.findByRole("table");
  expect(tableRows()[0]).toMatch(/^1Applause100%Disabled/);
  expect(tableRows()[1]).toMatch(/^2Station ID80%Enabled/);
  expect(screen.queryByRole("article")).not.toBeInTheDocument();

  const header = (label: string) =>
    within(screen.getByRole("table")).getByText(label).closest("button")!;
  fireEvent.click(header("Name"));
  expect(tableRows()[0]).toMatch(/Applause/);
  fireEvent.click(header("Name"));
  expect(tableRows()[0]).toMatch(/Station ID/);
  fireEvent.click(header("Volume"));
  expect(tableRows()[0]).toMatch(/80%/);
  fireEvent.click(header("Volume"));
  expect(tableRows()[0]).toMatch(/100%/);
  fireEvent.click(header("Status"));
  expect(tableRows()[0]).toMatch(/Disabled/);
  fireEvent.click(header("Status"));
  expect(tableRows()[0]).toMatch(/Enabled/);
});

it("keeps one visible action per row, delete last in the menu", async () => {
  serve();
  render(<InstantsAdmin />);
  await screen.findByRole("table");
  expect(rowAction("Play", "Station ID")).toBeVisible();
  expect(screen.queryByLabelText("Delete Station ID")).not.toBeInTheDocument();
  expect(await rowMenuLabels("Station ID")).toEqual(["Edit", "Delete"]);
});

it("explains a load failure with a retry, then offers to create the first clip", async () => {
  serve({ "GET /instants": () => new Response(null, { status: 500 }) });
  render(<InstantsAdmin />);
  expect(await screen.findByText("Failed to load audio clips")).toBeVisible();
  clips = [];
  serve();
  fireEvent.click(screen.getByText("Retry").closest("button")!);
  expect(await screen.findByText("No audio clips yet")).toBeVisible();
});

it("plays a clip on the selected program, and stops all only after confirmation", async () => {
  const calls = serve();
  render(<InstantsAdmin />);
  await screen.findByRole("table");
  fireEvent.click(rowAction("Play", "Station ID"));
  await toast("Audio clip triggered.");
  expect(
    calls.some((call) =>
      call.url.endsWith("/instants/2/play?programId=night%20radio"),
    ),
  ).toBe(true);
  fireEvent.click(rowAction("Play", "Applause"));
  await waitFor(() =>
    expect(calls.some((call) => call.url.includes("/instants/1/play"))).toBe(
      true,
    ),
  );
  fireEvent.click(screen.getByText("Stop all").closest("button")!);
  expect(await confirmation()).toBeVisible();
  await cancelConfirmation();
  expect(calls.some((call) => call.url.includes("stop-all"))).toBe(false);
  fireEvent.click(screen.getByText("Stop all").closest("button")!);
  await confirmWith("Stop all");
  await toast("Stop command sent.");
  expect(
    calls.some((call) =>
      call.url.endsWith("/instants/stop-all?programId=night%20radio"),
    ),
  ).toBe(true);
});

it.each([
  [() => new Response("Program is not on air", { status: 409 })],
  [() => new Response("", { status: 502 })],
])(
  "reports a clip that could not be played or stopped (%#)",
  async (failure) => {
    serve({
      "POST /instants/2/play": failure,
      "POST /instants/stop-all": failure,
    });
    render(<InstantsAdmin />);
    await screen.findByRole("table");
    fireEvent.click(rowAction("Play", "Station ID"));
    await toast("Failed to trigger audio clip.");
    fireEvent.click(screen.getByText("Stop all").closest("button")!);
    await confirmWith("Stop all");
    await toast("Failed to stop audio clips.");
  },
);

it("uploads a new clip and creates it, validating its name, volume and audio", async () => {
  clips = [];
  const calls = serve();
  vi.mocked(uploadFileToMediaBucket).mockResolvedValue({
    url: "https://media.example/sweep.ogg",
  } as never);
  render(<InstantsAdmin />);
  await screen.findByText("No audio clips yet");
  fireEvent.click(
    screen.getAllByText("Create audio clip").at(-1)!.closest("button")!,
  );
  expect(within(dialog()).getByText("No audio selected yet.")).toBeVisible();

  fireEvent.click(dialogButton("Create audio clip"));
  expect(await within(dialog()).findByText("Name is required.")).toBeVisible();
  fireEvent.change(nameInput(), { target: { value: " Sweep " } });
  expect(
    within(dialog()).queryByText("Name is required."),
  ).not.toBeInTheDocument();

  for (const value of ["1.5", "-0.1"]) {
    fireEvent.change(volumeInput(), { target: { value } });
    fireEvent.click(dialogButton("Create audio clip"));
    expect(
      await within(dialog()).findByText("Volume must be between 0 and 1."),
    ).toBeVisible();
  }
  fireEvent.change(volumeInput(), { target: { value: "0.5" } });
  expect(
    within(dialog()).queryByText("Volume must be between 0 and 1."),
  ).not.toBeInTheDocument();

  fireEvent.click(dialogButton("Create audio clip"));
  expect(
    await within(dialog()).findByText("Audio file is required."),
  ).toBeVisible();
  fireEvent.change(fileInput(), { target: { files: [audio] } });
  expect(within(dialog()).getByText("Selected: sweep.ogg")).toBeVisible();
  expect(
    within(dialog()).queryByText("Audio file is required."),
  ).not.toBeInTheDocument();
  fireEvent.click(within(dialog()).getByLabelText("Enabled"));

  fireEvent.click(dialogButton("Create audio clip"));
  await toast("Audio clip created.");
  expect(uploadFileToMediaBucket).toHaveBeenCalledWith("instant", audio);
  const post = calls.find(
    (call) => call.init?.method === "POST" && call.url.endsWith("/instants"),
  )!;
  expect(JSON.parse(String(post.init!.body))).toEqual({
    name: "Sweep",
    audioUrl: "https://media.example/sweep.ogg",
    volume: 0.5,
    enabled: false,
  });
  expect((await screen.findAllByText("Sweep")).length).toBeGreaterThan(0);
});

it("clears a file choice that picked nothing, and cancels", async () => {
  serve();
  render(<InstantsAdmin />);
  await screen.findByRole("table");
  openCreate();
  fireEvent.change(fileInput(), { target: { files: [audio] } });
  expect(within(dialog()).getByText("Selected: sweep.ogg")).toBeVisible();
  fireEvent.change(fileInput(), { target: { files: [] } });
  expect(within(dialog()).getByText("No audio selected yet.")).toBeVisible();
  fireEvent.click(dialogButton("Cancel"));
});

it("edits a clip, keeping its uploaded audio, and shows each kind of refusal", async () => {
  const calls = serve();
  render(<InstantsAdmin />);
  await screen.findByRole("table");
  await chooseFromRowMenu("Station ID", "Edit");
  expect(
    within(dialog()).getByText("Using existing uploaded audio."),
  ).toBeVisible();
  expect(
    within(dialog()).getByText("URL: https://media.example/id.ogg"),
  ).toBeVisible();
  expect(volumeInput()).toHaveValue(0.8);
  fireEvent.change(nameInput(), { target: { value: "Station ident" } });
  fireEvent.click(dialogButton("Update audio clip"));
  await toast("Audio clip updated.");
  expect(calls.find((call) => call.init?.method === "PUT")!.url).toMatch(
    /\/instants\/2$/,
  );
  expect(uploadFileToMediaBucket).not.toHaveBeenCalled();

  await chooseFromRowMenu("Applause", "Edit");
  expect(within(dialog()).getByLabelText("Enabled")).not.toBeChecked();
  for (const [answer, message] of [
    [
      () => Response.json({ message: "Volume is locked" }, { status: 400 }),
      "Volume is locked",
    ],
    [
      () => Response.json({ message: ["Name taken", "", 3] }, { status: 400 }),
      "Name taken",
    ],
    [
      () => Response.json({ message: [""] }, { status: 400 }),
      '{"message":[""]}',
    ],
    [
      () => Response.json({ message: "  " }, { status: 400 }),
      '{"message":"  "}',
    ],
    [() => new Response("plain refusal", { status: 409 }), "plain refusal"],
    [() => new Response("", { status: 502 }), "HTTP 502"],
  ] as const) {
    serve({ "PUT /instants/1": answer });
    fireEvent.click(dialogButton("Update audio clip"));
    expect(
      await within(dialog()).findByText(message, {
        normalizer: (text) => text,
      }),
    ).toBeVisible();
  }
});

it("reports a failed upload and shows the upload in progress", async () => {
  serve();
  let finish!: (value: { url: string }) => void;
  vi.mocked(uploadFileToMediaBucket)
    .mockRejectedValueOnce(new Error("Upload refused"))
    .mockRejectedValueOnce("offline")
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }) as never,
    );
  render(<InstantsAdmin />);
  await screen.findByRole("table");
  openCreate();
  fireEvent.change(nameInput(), { target: { value: "Sweep" } });
  fireEvent.change(fileInput(), { target: { files: [audio] } });
  fireEvent.click(dialogButton("Create audio clip"));
  expect(await within(dialog()).findByText("Upload refused")).toBeVisible();
  fireEvent.click(dialogButton("Create audio clip"));
  expect(
    await within(dialog()).findByText("Failed to save audio clip."),
  ).toBeVisible();
  fireEvent.click(dialogButton("Create audio clip"));
  expect(await within(dialog()).findByText("Uploading...")).toBeVisible();
  finish({ url: "https://media.example/sweep.ogg" });
  await toast("Audio clip created.");
});

it("deletes a clip only after confirmation, and reports a failure", async () => {
  serve();
  render(<InstantsAdmin />);
  await screen.findByRole("table");
  await chooseFromRowMenu("Station ID", "Delete");
  expect(
    within(await confirmation()).getByText('Delete audio clip "Station ID"?'),
  ).toBeVisible();
  await cancelConfirmation();
  expect(screen.getByText("Station ID")).toBeVisible();
  await chooseFromRowMenu("Station ID", "Delete");
  await confirmWith("Delete");
  await toast("Audio clip deleted.");
  await waitFor(() =>
    expect(screen.queryByText("Station ID")).not.toBeInTheDocument(),
  );

  for (const answer of [
    () => new Response("In use", { status: 409 }),
    () => new Response("", { status: 500 }),
  ]) {
    serve({ "DELETE /instants/1": answer });
    await chooseFromRowMenu("Applause", "Delete");
    await confirmWith("Delete");
    await toast("Failed to delete audio clip.");
  }
});
