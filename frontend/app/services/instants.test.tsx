import { afterEach, expect, it, vi } from "vitest";
import { apiUrl } from "../utils/apiBaseUrl";
import { fetchInstants, stopAllInstants, triggerInstant } from "./instants";

// gaulatti/alcantara#184, group G5: the instants client against a stubbed
// network.
afterEach(() => vi.unstubAllGlobals());

function network(response: Response) {
  const fetch = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("lists the instants, for every program or for one", async () => {
  const items = [{ id: 1, name: "Applause" }];
  let fetch = network(new Response(JSON.stringify(items)));
  await expect(fetchInstants()).resolves.toEqual(items);
  expect(fetch).toHaveBeenCalledWith(apiUrl("/instants"));
  fetch = network(new Response("[]"));
  await expect(fetchInstants("radio one")).resolves.toEqual([]);
  expect(fetch).toHaveBeenCalledWith(apiUrl("/instants?programId=radio%20one"));
});

it("plays one instant and stops them all on a program", async () => {
  const fetch = network(new Response(null, { status: 204 }));
  await triggerInstant(7, "radio one");
  expect(fetch).toHaveBeenCalledWith(
    apiUrl("/instants/7/play?programId=radio%20one"),
    { method: "POST" },
  );
  await stopAllInstants("radio one");
  expect(fetch).toHaveBeenLastCalledWith(
    apiUrl("/instants/stop-all?programId=radio%20one"),
    { method: "POST" },
  );
});

it("reports a refused request by its status", async () => {
  network(new Response("no", { status: 503 }));
  await expect(fetchInstants()).rejects.toThrow("HTTP 503");
  await expect(triggerInstant(1, "p")).rejects.toThrow("HTTP 503");
  await expect(stopAllInstants("p")).rejects.toThrow("HTTP 503");
});
