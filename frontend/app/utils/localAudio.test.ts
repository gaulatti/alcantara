import { afterEach, expect, it, vi } from "vitest";
import { holdLocalAudio, onHeadphones, preFadeMuted, resetLocalAudio, setHostMicLive, setOnHeadphones } from "./localAudio";

// gaulatti/alcantara#879: with the host microphone open, anything the desk plays out loud can feed back to air. Safe by
// default; headphones are the operator's explicit word.
const element = () => document.createElement("audio");
afterEach(() => {
  resetLocalAudio();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

it("mutes everything held, from the moment the microphone opens until it is off, by default", () => {
  const before = element();
  holdLocalAudio(before);
  expect(before.muted).toBe(false);
  setHostMicLive(true);
  expect(before.muted).toBe(true);
  const during = element();
  holdLocalAudio(during);
  expect(during.muted).toBe(true);
  setHostMicLive(false);
  expect([before.muted, during.muted]).toEqual([false, false]);
});

it("keeps pre-fade for an operator who says headphones, and remembers it", () => {
  const pad = element();
  holdLocalAudio(pad);
  setHostMicLive(true);
  setOnHeadphones(true);
  expect(pad.muted).toBe(false);
  expect(preFadeMuted()).toBe(false);
  resetLocalAudio();
  expect(onHeadphones()).toBe(true);
  setOnHeadphones(false);
  resetLocalAudio();
  expect(onHeadphones()).toBe(false);
});

it("lets go of an element, and stays safe where nothing can be stored", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  const gone = element();
  holdLocalAudio(gone)();
  setHostMicLive(true);
  expect(gone.muted).toBe(false);
  expect(onHeadphones()).toBe(false);
  setOnHeadphones(true);
  expect(onHeadphones()).toBe(true);
});
