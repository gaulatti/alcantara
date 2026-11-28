import { afterEach, expect, it, vi } from "vitest";
import * as dayparts from "./dayparts";

afterEach(() => vi.unstubAllGlobals());

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

it("calls each clock and grid route", async () => {
  const fetched = vi.fn(async (_url: string, _init?: RequestInit) =>
    answer({}),
  );
  vi.stubGlobal("fetch", fetched);
  const rules = { artistSeparation: 0, slots: [] };
  await dayparts.fetchRadioClocks("a b");
  await dayparts.createRadioClock("p", { name: "n", rules });
  await dayparts.updateRadioClock("p", 5, { name: "n", rules, revision: 1 });
  await dayparts.deleteRadioClock("p", 5, 2);
  await dayparts.fetchRadioDayparts("p");
  await dayparts.saveRadioDayparts("p", {
    timeZone: "UTC",
    revision: 0,
    dayparts: [],
  });
  expect(
    fetched.mock.calls.map(([url, init]) => [
      init?.method ?? "GET",
      url.replace(/^.*\/program\//, ""),
    ]),
  ).toEqual([
    ["GET", "a%20b/radio-clocks"],
    ["POST", "p/radio-clocks"],
    ["PUT", "p/radio-clocks/5"],
    ["DELETE", "p/radio-clocks/5?revision=2"],
    ["GET", "p/radio-dayparts"],
    ["PUT", "p/radio-dayparts"],
  ]);
});

it("words a refusal from the server, or its status", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => answer({ message: "fills 1 daypart" }, 409)),
  );
  await expect(dayparts.fetchRadioClocks("p")).rejects.toThrow(
    "fills 1 daypart",
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("down", { status: 502 })),
  );
  await expect(dayparts.fetchRadioClocks("p")).rejects.toThrow("(502)");
});
