import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as flight from "./flight";
import * as program from "./program";
import * as scenes from "./scenes";

type Case = { name: string; call: () => Promise<unknown>; path: string; method?: string; body?: unknown; failMessage: (status: number) => string };

const fetchMock = vi.fn();
const reply = (status: number, body: unknown = { ok: true }) =>
  fetchMock.mockResolvedValue({ ok: status < 400, status, json: async () => body });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const rundown = (s: number) => `Rundown request failed (${s})`;
const http = (s: number) => `HTTP ${s}`;
const P = "my%20prog";
const cue = [{ id: "c" }] as any;
const flightCases: Case[] = [
  { name: "fetchFlightSequences", call: () => flight.fetchFlightSequences("my prog"), path: `/program/${P}/flight`, failMessage: rundown },
  { name: "createFlightSequence", call: () => flight.createFlightSequence("my prog", { name: "N", items: cue, loop: true }), path: `/program/${P}/flight`, method: "POST", body: { name: "N", items: cue, loop: true }, failMessage: rundown },
  { name: "updateFlightSequence", call: () => flight.updateFlightSequence("my prog", 4, { name: "M", revision: 2 }), path: `/program/${P}/flight/4`, method: "PUT", body: { name: "M", revision: 2 }, failMessage: rundown },
  { name: "deleteFlightSequence", call: () => flight.deleteFlightSequence("my prog", 4), path: `/program/${P}/flight/4`, method: "DELETE", failMessage: rundown },
  { name: "activateFlightSequence", call: () => flight.activateFlightSequence("my prog", 4), path: `/program/${P}/flight/4/activate`, method: "POST", failMessage: rundown },
  { name: "deactivateFlightSequence", call: () => flight.deactivateFlightSequence("my prog"), path: `/program/${P}/flight/deactivate`, method: "POST", failMessage: rundown },
  { name: "startFlight", call: () => flight.startFlight("my prog"), path: `/program/${P}/flight/start`, method: "POST", failMessage: rundown },
  { name: "stopFlight", call: () => flight.stopFlight("my prog"), path: `/program/${P}/flight/stop`, method: "POST", failMessage: rundown },
  { name: "goFlight", call: () => flight.goFlight("my prog"), path: `/program/${P}/flight/go`, method: "POST", failMessage: rundown },
  { name: "resetFlight", call: () => flight.resetFlight("my prog"), path: `/program/${P}/flight/reset`, method: "POST", failMessage: rundown },
  { name: "preflightFlightSequence", call: () => flight.preflightFlightSequence("my prog", 4), path: `/program/${P}/flight/4/preflight`, failMessage: rundown },
  { name: "publishFlightSequence", call: () => flight.publishFlightSequence("my prog", 4, 9), path: `/program/${P}/flight/4/publish`, method: "POST", body: { revision: 9 }, failMessage: rundown },
  { name: "fillRundown", call: () => flight.fillRundown("my prog", 4, 9, cue, { labelId: "l", artistSeparation: 3 }), path: `/program/${P}/flight/4/fill`, method: "POST", body: { revision: 9, items: cue, rules: { labelId: "l", artistSeparation: 3 } }, failMessage: rundown },
  { name: "generateTaggedLog", call: () => flight.generateTaggedLog("my prog", 4, 9, { slots: [], artistSeparation: 2 }), path: `/program/${P}/flight/4/generate`, method: "POST", body: { revision: 9, rules: { slots: [], artistSeparation: 2 } }, failMessage: rundown },
];
const programCases: Case[] = [
  { name: "fetchProgramState", call: () => program.fetchProgramState("my prog"), path: `/program/${P}/control/state`, failMessage: http },
  { name: "fetchProgramAudioBusSettings", call: () => program.fetchProgramAudioBusSettings("my prog"), path: `/program/${P}/control/audio-bus`, failMessage: http },
  { name: "persistMixerSettings", call: () => program.persistMixerSettings("my prog", { mainMasterVolume: 1, mixerChannels: [] }), path: `/program/${P}/audio-bus`, method: "PUT", body: { mixerSettings: { mainMasterVolume: 1, mixerChannels: [] } }, failMessage: http },
  { name: "saveProgramAudioBusSongSequence", call: () => program.saveProgramAudioBusSongSequence("my prog", [1, 2]), path: `/program/${P}/audio-bus`, method: "PUT", body: { songSequence: [1, 2] }, failMessage: http },
  { name: "fetchProgramAudioMeter", call: () => program.fetchProgramAudioMeter("my prog"), path: `/program/${P}/audio-meter`, failMessage: http },
  { name: "fetchProgramSongPlayback", call: () => program.fetchProgramSongPlayback("my prog"), path: `/program/${P}/song-playback`, failMessage: http },
  { name: "takeSongOffAir", call: () => program.takeSongOffAir("my prog"), path: `/program/${P}/song/off-air`, method: "POST", failMessage: http },
  { name: "fetchSceneInstantPlayback", call: () => program.fetchSceneInstantPlayback("my prog"), path: `/program/${P}/scene-instant`, failMessage: http },
  { name: "takeSceneInstant", call: () => program.takeSceneInstant("my prog", 3, null), path: `/program/${P}/scene-instant/take`, method: "POST", body: { sceneId: 3, instantId: null }, failMessage: http },
  { name: "stopSceneInstant", call: () => program.stopSceneInstant("my prog"), path: `/program/${P}/scene-instant/stop`, method: "POST", failMessage: http },
  { name: "assignSceneToProgram", call: () => program.assignSceneToProgram("my prog", 3), path: `/program/${P}/scenes`, method: "POST", body: { sceneId: 3 }, failMessage: http },
  { name: "stageSceneForProgram", call: () => program.stageSceneForProgram("my prog", null), path: `/program/${P}/stage`, method: "POST", body: { sceneId: null }, failMessage: http },
  { name: "fetchMediaGroups", call: () => program.fetchMediaGroups("my prog"), path: `/program/${P}/media-groups`, failMessage: http },
];
const sceneCases: Case[] = [
  { name: "fetchScenes", call: () => scenes.fetchScenes(), path: "/scenes", failMessage: http },
  { name: "fetchLayouts", call: () => scenes.fetchLayouts(), path: "/layouts", failMessage: http },
  { name: "createScene", call: () => scenes.createScene({ name: "S", layoutId: 1, metadata: {} }), path: "/scenes", method: "POST", body: { name: "S", layoutId: 1, metadata: {} }, failMessage: http },
  { name: "updateScene", call: () => scenes.updateScene(5, { name: "T" }), path: "/scenes/5", method: "PUT", body: { name: "T" }, failMessage: http },
  { name: "persistSceneAttributes", call: () => scenes.persistSceneAttributes(5, { a: 1 } as any), path: "/scenes/5", method: "PUT", body: { metadata: { a: 1 } }, failMessage: http },
  { name: "deleteScene", call: () => scenes.deleteScene(5), path: "/scenes/5", method: "DELETE", failMessage: http },
];

describe.each([
  ["flight", flightCases],
  ["program", programCases],
  ["scenes", sceneCases],
])("%s requests", (_group, cases) => {
  it.each(cases.map((c) => [c.name, c] as const))("%s sends the documented request and returns the payload", async (_n, c) => {
    reply(200, { marker: 1 });
    await c.call();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(new RegExp(`${c.path.replace(/[/%]/g, (m) => `\\${m}`)}$`));
    expect(init?.method).toBe(c.method);
    if (c.body !== undefined) {
      expect(init.headers).toEqual({ "Content-Type": "application/json" });
      expect(JSON.parse(init.body)).toEqual(c.body);
    }
  });
  it.each(cases.map((c) => [c.name, c] as const))("%s rejects when the server refuses", async (_n, c) => {
    reply(500, null);
    await expect(c.call()).rejects.toThrow(c.failMessage(500));
  });
});

describe("flight error details", () => {
  it("uses a string message from the server", async () => {
    reply(409, { message: "Revision is stale" });
    await expect(flight.startFlight("p")).rejects.toThrow("Revision is stale");
  });
  it("joins a list of messages", async () => {
    reply(400, { message: ["a", "b"] });
    await expect(flight.startFlight("p")).rejects.toThrow("a; b");
  });
  it("falls back to the status for any other body", async () => {
    reply(400, { message: 7 });
    await expect(flight.startFlight("p")).rejects.toThrow("Rundown request failed (400)");
    reply(400, "text");
    await expect(flight.startFlight("p")).rejects.toThrow("Rundown request failed (400)");
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => Promise.reject(new Error("bad json")) });
    await expect(flight.startFlight("p")).rejects.toThrow("Rundown request failed (502)");
  });
});

describe("scene activation", () => {
  it("activates a scene with its transition and returns the program state", async () => {
    reply(200, { id: 1 });
    expect(await program.activateScene("my prog", 3, "cut")).toEqual({ id: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/program\/my%20prog\/activate$/);
    expect(JSON.parse(init.body)).toEqual({ sceneId: 3, transitionId: "cut" });
  });
  it("explains why a scene was not taken", async () => {
    reply(409, { message: "Scene is not assigned" });
    await expect(program.activateScene("p", 3)).rejects.toThrow("Scene is not assigned");
    reply(500, { message: 4 });
    await expect(program.activateScene("p", 3)).rejects.toThrow("The scene was not taken to Program (HTTP 500).");
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => Promise.reject(new Error("x")) });
    await expect(program.activateScene("p", 3)).rejects.toThrow("(HTTP 500)");
  });
  it("completes a countdown without signing in, and explains a refusal", async () => {
    reply(200, { id: 2 });
    expect(await program.completeSceneCountdown("my prog")).toEqual({ id: 2 });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/program\/my%20prog\/countdown\/complete$/);
    expect(fetchMock.mock.calls[0][1]).toEqual({ method: "POST" });
    reply(409, { message: "No next scene" });
    await expect(program.completeSceneCountdown("p")).rejects.toThrow("No next scene");
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => null });
    await expect(program.completeSceneCountdown("p")).rejects.toThrow("The countdown did not switch scenes (HTTP 503).");
  });
});
