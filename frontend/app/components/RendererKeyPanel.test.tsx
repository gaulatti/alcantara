import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RendererKeyPanel } from "./RendererKeyPanel";

// gaulatti/alcantara#884: one show's renderer key. The values here are made up.
const none = {
  programId: "night radio",
  exists: false,
  version: null,
  createdAt: null,
  rotatedAt: null,
  lastUsedAt: null,
};
const one = {
  ...none,
  exists: true,
  version: 1,
  createdAt: "2026-11-28T01:00:00.000Z",
  rotatedAt: "2026-11-28T01:00:00.000Z",
};
const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function serve(...answers: Array<Response | Error>) {
  const fetched = vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = answers.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fetched);
  return fetched;
}
const press = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("issues a first key, shows it once and copies it", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const fetched = serve(
    answer(none),
    answer({ ...one, key: "fictional-key-1" }),
  );
  render(<RendererKeyPanel programId="night radio" />);
  expect(await screen.findByText("No key")).toBeInTheDocument();
  press("Issue key");
  expect(await screen.findByLabelText("New renderer key")).toHaveTextContent(
    "fictional-key-1",
  );
  press("Copy key");
  await screen.findByRole("button", { name: "Copied" });
  expect(writeText).toHaveBeenCalledWith("fictional-key-1");
  expect(screen.getByText("Never")).toBeInTheDocument();
  expect(
    fetched.mock.calls.map(([url, init]) => [
      init?.method ?? "GET",
      url.replace(/^.*\/program\//, ""),
    ]),
  ).toEqual([
    ["GET", "night%20radio/renderer-key"],
    ["POST", "night%20radio/renderer-key/rotate"],
  ]);
});

it("asks before replacing a key, and says how to copy when copying fails", async () => {
  vi.stubGlobal("navigator", {
    clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
  });
  const fetched = serve(
    answer(one),
    answer({ ...one, version: 2, key: "fictional-key-2" }),
  );
  render(<RendererKeyPanel programId="night radio" />);
  await screen.findByRole("button", { name: "Rotate key" });
  press("Rotate key");
  press("Cancel");
  expect(fetched).toHaveBeenCalledTimes(1);
  press("Rotate key");
  press("Replace key");
  expect(await screen.findByText("2")).toBeInTheDocument();
  press("Copy key");
  expect(await screen.findByRole("alert")).toHaveTextContent("copy it by hand");
});

it("words a refusal, a failure and a lost connection", async () => {
  serve(answer({}, 403));
  render(<RendererKeyPanel programId="p" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("permission");
  cleanup();

  serve(answer(none), answer({}, 500));
  render(<RendererKeyPanel programId="p" />);
  await screen.findByText("No key");
  press("Issue key");
  expect(await screen.findByRole("alert")).toHaveTextContent("(500)");
  cleanup();

  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject("offline")),
  );
  render(<RendererKeyPanel programId="p" />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Renderer key unavailable",
  );
});

it("drops an answer that arrives after it closes", async () => {
  const answers: Array<() => void> = [];
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementationOnce(
        () => new Promise((resolve) => answers.push(() => resolve(answer(one)))),
      )
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) =>
            answers.push(() => reject(new Error("late"))),
          ),
      ),
  );
  render(<RendererKeyPanel programId="p" />).unmount();
  render(<RendererKeyPanel programId="p" />).unmount();
  answers.forEach((release) => release());
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
