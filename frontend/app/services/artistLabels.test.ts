import { afterEach, expect, it, vi } from "vitest";
import { artistKeyOf, fetchArtistLabels, saveArtistLabel } from "./artistLabels";

const authFetch = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ authFetch }));

afterEach(() => authFetch.mockReset());

it("keys an artist on case and outer spaces only, like the backend", () => {
  expect(artistKeyOf("  ROB ")).toBe("rob");
  expect(artistKeyOf("Rob  Roy")).toBe("rob  roy");
});

it("reads the artist labels and refuses a failed or malformed answer", async () => {
  authFetch.mockResolvedValueOnce(
    new Response(JSON.stringify([{ artistKey: "rob", artist: "Rob", labelId: "l1" }])),
  );
  await expect(fetchArtistLabels()).resolves.toEqual([
    { artistKey: "rob", artist: "Rob", labelId: "l1" },
  ]);
  expect(authFetch).toHaveBeenCalledWith("/artist-labels");
  authFetch.mockResolvedValueOnce(new Response("{}", { status: 503 }));
  await expect(fetchArtistLabels()).rejects.toThrow("HTTP 503");
  authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ not: "a list" })));
  await expect(fetchArtistLabels()).rejects.toThrow("Invalid artist labels response");
});

it("sends the artist and the label, or null to remove the link", async () => {
  authFetch.mockResolvedValue(new Response("{}"));
  await saveArtistLabel("Rob", "l1");
  await saveArtistLabel("Rob", null);
  const bodies = authFetch.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
  expect(bodies).toEqual([
    { artist: "Rob", labelId: "l1" },
    { artist: "Rob", labelId: null },
  ]);
  expect(authFetch.mock.calls[0][1].method).toBe("PUT");
});

it("reports why a save was refused, or the status when there is no reason", async () => {
  authFetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ message: "The label does not exist for this team" }), { status: 400 }),
  );
  await expect(saveArtistLabel("Rob", "x")).rejects.toThrow("The label does not exist for this team");
  authFetch.mockResolvedValueOnce(new Response("not json", { status: 500 }));
  await expect(saveArtistLabel("Rob", "x")).rejects.toThrow("HTTP 500");
});
