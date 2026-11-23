import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import StingersAdmin, { meta } from "./stingers";
import { uploadFileToMediaBucket } from "../services/uploads";
import { routeFetch } from "../../test/routeKit";
import {
  cancelConfirmation,
  chooseFromRowMenu,
  confirmWith,
  confirmation,
  rowMenuLabels,
} from "../../test/libraryKit";

vi.mock("@gaulatti/bleecker", async (original) =>
  (await import("../../test/libraryKit")).libraryBleecker(
    original as () => Promise<typeof import("@gaulatti/bleecker")>,
  ),
);
vi.mock("../services/uploads", () => ({ uploadFileToMediaBucket: vi.fn() }));

type Stinger = {
  id: number;
  name: string;
  videoUrl: string;
  cutPointMs?: number;
  enabled: boolean;
};
let stingers: Stinger[];

function serve(overrides: Partial<Record<string, () => Response>> = {}) {
  const { fetchMock, calls } = routeFetch((url, init) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${new URL(url).pathname}`;
    if (overrides[key]) return overrides[key]!();
    if (key === "GET /stingers") return Response.json(stingers);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (key === "POST /stingers") {
      stingers = [...stingers, { id: 9, ...body }];
      return Response.json({});
    }
    const id = Number(url.split("/").pop());
    if (method === "PUT") {
      stingers = stingers.map((stinger) =>
        stinger.id === id ? { ...stinger, ...body } : stinger,
      );
      return Response.json({});
    }
    if (method === "DELETE") {
      stingers = stingers.filter((stinger) => stinger.id !== id);
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
const nameInput = () => within(dialog()).getByPlaceholderText("My Stinger");
const cutInput = () => within(dialog()).getByPlaceholderText("1000");
const fileInput = () =>
  dialog().querySelector('input[type="file"]') as HTMLInputElement;
const video = new File(["webm"], "wipe.webm", { type: "video/webm" });

function openCreate() {
  fireEvent.click(
    screen.getAllByText("Create transition")[0].closest("button")!,
  );
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  stingers = [
    {
      id: 2,
      name: "Wipe",
      videoUrl: "https://media.example/wipe.webm",
      cutPointMs: 800,
      enabled: true,
    },
    {
      id: 1,
      name: "Old flash",
      videoUrl: "https://media.example/flash.webm",
      enabled: false,
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
    { title: "Transitions - Alcantara" },
    { name: "description", content: "Manage transition videos and cut points" },
  ]);
});

it("lists transitions in creation order with a status pill", async () => {
  serve();
  render(<StingersAdmin />);
  expect(screen.getByLabelText("Loading Transitions")).toBeVisible();
  await screen.findByRole("table");
  const rows = within(screen.getByRole("table"))
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.textContent);
  expect(rows[0]).toMatch(/^Old flash—Disabled/);
  expect(rows[1]).toMatch(/^Wipe800 msEnabled/);
  expect(await rowMenuLabels("Wipe")).toEqual(["Delete"]);
});

it("explains a load failure with a retry, then offers to create the first transition", async () => {
  serve({ "GET /stingers": () => new Response(null, { status: 500 }) });
  render(<StingersAdmin />);
  expect(await screen.findByText("Failed to load transitions")).toBeVisible();
  stingers = [];
  serve();
  fireEvent.click(screen.getByText("Retry").closest("button")!);
  expect(await screen.findByText("No transitions yet")).toBeVisible();
});

it("uploads a new transition video and creates it", async () => {
  stingers = [];
  const calls = serve();
  vi.mocked(uploadFileToMediaBucket).mockResolvedValue({
    url: "https://media.example/new-wipe.webm",
  } as never);
  render(<StingersAdmin />);
  await screen.findByText("No transitions yet");
  // The empty state's own button opens the same dialog.
  fireEvent.click(
    screen.getAllByText("Create transition").at(-1)!.closest("button")!,
  );
  expect(within(dialog()).getByText("No video selected yet.")).toBeVisible();

  fireEvent.click(dialogButton("Create transition"));
  expect(await within(dialog()).findByText("Name is required.")).toBeVisible();
  fireEvent.change(nameInput(), { target: { value: " Wipe left " } });
  expect(
    within(dialog()).queryByText("Name is required."),
  ).not.toBeInTheDocument();

  fireEvent.change(cutInput(), { target: { value: "-5" } });
  fireEvent.click(dialogButton("Create transition"));
  expect(
    await within(dialog()).findByText("Cut point must be a positive number."),
  ).toBeVisible();
  fireEvent.change(cutInput(), { target: { value: "1200" } });
  expect(
    within(dialog()).queryByText("Cut point must be a positive number."),
  ).not.toBeInTheDocument();

  // Without a video the transition cannot be saved.
  fireEvent.click(dialogButton("Create transition"));
  expect(
    await within(dialog()).findByText("Video file is required."),
  ).toBeVisible();
  fireEvent.change(fileInput(), { target: { files: [video] } });
  expect(within(dialog()).getByText("Selected: wipe.webm")).toBeVisible();
  expect(
    within(dialog()).queryByText("Video file is required."),
  ).not.toBeInTheDocument();
  fireEvent.click(within(dialog()).getByLabelText("Enabled"));

  fireEvent.click(dialogButton("Create transition"));
  await toast("Transition created.");
  expect(uploadFileToMediaBucket).toHaveBeenCalledWith("stinger", video);
  const post = calls.find((call) => call.init?.method === "POST")!;
  expect(JSON.parse(String(post.init!.body))).toEqual({
    name: "Wipe left",
    videoUrl: "https://media.example/new-wipe.webm",
    cutPointMs: 1200,
    enabled: false,
  });
  expect(await screen.findByText("Wipe left")).toBeVisible();
});

it("clears a file choice that picked nothing", async () => {
  serve();
  render(<StingersAdmin />);
  await screen.findByRole("table");
  openCreate();
  fireEvent.change(fileInput(), { target: { files: [video] } });
  expect(within(dialog()).getByText("Selected: wipe.webm")).toBeVisible();
  fireEvent.change(fileInput(), { target: { files: [] } });
  expect(within(dialog()).getByText("No video selected yet.")).toBeVisible();
  fireEvent.click(dialogButton("Cancel"));
});

it("edits a transition, keeping its uploaded video, and shows a refusal", async () => {
  const calls = serve();
  render(<StingersAdmin />);
  await screen.findByRole("table");
  fireEvent.click(screen.getByLabelText("Edit Wipe"));
  expect(
    within(dialog()).getByText("Using existing uploaded video."),
  ).toBeVisible();
  expect(
    within(dialog()).getByText("URL: https://media.example/wipe.webm"),
  ).toBeVisible();
  expect(cutInput()).toHaveValue(800);
  fireEvent.change(nameInput(), { target: { value: "Wipe right" } });
  fireEvent.click(dialogButton("Update transition"));
  await toast("Transition updated.");
  const put = calls.find((call) => call.init?.method === "PUT")!;
  expect(put.url).toMatch(/\/stingers\/2$/);
  expect(uploadFileToMediaBucket).not.toHaveBeenCalled();

  // A transition saved without a cut point opens at the default.
  fireEvent.click(screen.getByLabelText("Edit Old flash"));
  expect(cutInput()).toHaveValue(1000);
  expect(within(dialog()).getByLabelText("Enabled")).not.toBeChecked();
  for (const [response, message] of [
    [
      Response.json({ message: "Cut point is after the end" }, { status: 400 }),
      "Cut point is after the end",
    ],
    [
      Response.json({ message: ["Name taken", "", 3] }, { status: 400 }),
      "Name taken",
    ],
    [Response.json({ message: [""] }, { status: 400 }), '{"message":[""]}'],
    [Response.json({ message: "  " }, { status: 400 }), '{"message":"  "}'],
    [new Response("plain refusal", { status: 409 }), "plain refusal"],
    [new Response("", { status: 502 }), "HTTP 502"],
  ] as const) {
    serve({ "PUT /stingers/1": () => response });
    fireEvent.click(dialogButton("Update transition"));
    // Shown exactly as the server sent it, whitespace included.
    expect(
      await within(dialog()).findByText(message, {
        normalizer: (text) => text,
      }),
    ).toBeVisible();
  }
});

it("reports a failed video upload", async () => {
  serve();
  vi.mocked(uploadFileToMediaBucket)
    .mockRejectedValueOnce(new Error("Upload refused"))
    .mockRejectedValueOnce("offline");
  render(<StingersAdmin />);
  await screen.findByRole("table");
  openCreate();
  fireEvent.change(nameInput(), { target: { value: "Flash" } });
  fireEvent.change(fileInput(), { target: { files: [video] } });
  fireEvent.click(dialogButton("Create transition"));
  expect(await within(dialog()).findByText("Upload refused")).toBeVisible();
  fireEvent.click(dialogButton("Create transition"));
  expect(
    await within(dialog()).findByText("Failed to save stinger."),
  ).toBeVisible();
});

it("shows the upload in progress", async () => {
  serve();
  let finish!: (value: { url: string }) => void;
  vi.mocked(uploadFileToMediaBucket).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }) as never,
  );
  render(<StingersAdmin />);
  await screen.findByRole("table");
  openCreate();
  fireEvent.change(nameInput(), { target: { value: "Flash" } });
  fireEvent.change(fileInput(), { target: { files: [video] } });
  fireEvent.click(dialogButton("Create transition"));
  expect(await within(dialog()).findByText("Uploading...")).toBeVisible();
  finish({ url: "https://media.example/flash2.webm" });
  await toast("Transition created.");
});

it("deletes a transition only after confirmation, and reports a failure", async () => {
  serve();
  render(<StingersAdmin />);
  await screen.findByRole("table");
  await chooseFromRowMenu("Wipe", "Delete");
  expect(
    within(await confirmation()).getByText('Delete transition "Wipe"?'),
  ).toBeVisible();
  await cancelConfirmation();
  expect(screen.getByText("Wipe")).toBeVisible();
  await chooseFromRowMenu("Wipe", "Delete");
  await confirmWith("Delete");
  await toast("Transition deleted.");
  await waitFor(() =>
    expect(screen.queryByText("Wipe")).not.toBeInTheDocument(),
  );

  for (const response of [
    new Response("In use", { status: 409 }),
    new Response("", { status: 500 }),
  ]) {
    serve({ "DELETE /stingers/1": () => response });
    await chooseFromRowMenu("Old flash", "Delete");
    await confirmWith("Delete");
    await toast("Failed to delete transition.");
  }
});
