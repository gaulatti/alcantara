import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSongPreview } from "./useSongPreview";

// gaulatti/alcantara#404 (group C): the song preview player, against a stand-in for the browser's
// audio element that raises the events a real one does.

class FakeAudio extends EventTarget {
  static last: FakeAudio;
  paused = true;
  currentTime = 0;
  duration = 0;
  preload = "";
  private source: string | null = null;
  playResult: Promise<void> | void = undefined;
  play = vi.fn(() => {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
    return this.playResult;
  });
  pause = vi.fn(() => {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  });
  constructor() {
    super();
    FakeAudio.last = this;
  }
  set src(value: string) {
    this.source = value;
  }
  getAttribute(name: string) {
    return name === "src" ? this.source : null;
  }
  removeAttribute() {
    this.source = null;
  }
  emit(type: string) {
    this.dispatchEvent(new Event(type));
  }
}

beforeEach(() => vi.stubGlobal("Audio", FakeAudio));
afterEach(() => vi.unstubAllGlobals());

const song = { id: 1, audioUrl: "https://media.example.test/a.mp3" };

it("starts a song, shows it playing, and pauses it on a second press", () => {
  const { result } = renderHook(() => useSongPreview());
  act(() => result.current.toggle(song));
  expect(result.current).toMatchObject({ currentId: 1, playing: true, error: null });
  expect(FakeAudio.last.preload).toBe("none");
  act(() => result.current.toggle(song));
  expect(result.current.playing).toBe(false);
  expect(FakeAudio.last.pause).toHaveBeenCalled();
});

it("follows the element's position, length and end", () => {
  const { result } = renderHook(() => useSongPreview());
  act(() => result.current.toggle(song));
  const audio = FakeAudio.last;
  act(() => {
    audio.currentTime = 12.5;
    audio.emit("timeupdate");
  });
  expect(result.current.position).toBe(12.5);
  act(() => {
    audio.duration = 200;
    audio.emit("loadedmetadata");
  });
  expect(result.current.length).toBe(200);
  act(() => {
    audio.duration = Number.POSITIVE_INFINITY;
    audio.emit("loadedmetadata");
  });
  expect(result.current.length).toBeNull();
  act(() => audio.emit("ended"));
  expect(result.current.playing).toBe(false);
});

it("switches to another song, stopping the first and starting from the top", () => {
  const { result } = renderHook(() => useSongPreview());
  act(() => result.current.toggle(song));
  act(() => result.current.toggle({ id: 2, audioUrl: "https://media.example.test/b.mp3" }));
  expect(result.current.currentId).toBe(2);
  expect(result.current.position).toBe(0);
  expect(FakeAudio.last.getAttribute("src")).toBe("https://media.example.test/b.mp3");
  expect(FakeAudio.last.pause).toHaveBeenCalled();
});

it("reloads the same song when its source was cleared, and clears with a null song", () => {
  const { result } = renderHook(() => useSongPreview());
  act(() => result.current.toggle(song));
  act(() => result.current.load(null));
  expect(result.current).toMatchObject({ currentId: null, playing: false, position: 0, length: null });
  expect(FakeAudio.last.getAttribute("src")).toBeNull();
  act(() => result.current.toggle(song));
  expect(FakeAudio.last.getAttribute("src")).toBe(song.audioUrl);
  expect(result.current.currentId).toBe(1);
});

it("says a song cannot be previewed when the browser refuses to play it or fails to load it", async () => {
  const { result } = renderHook(() => useSongPreview());
  act(() => result.current.toggle(song));
  act(() => result.current.toggle(song));
  FakeAudio.last.playResult = Promise.reject(new Error("NotSupported"));
  await act(async () => result.current.toggle(song));
  expect(result.current.error).toBe("This song cannot be previewed in the browser.");
  expect(result.current.playing).toBe(false);
  act(() => result.current.load(song));
  expect(result.current.error).toBeNull();
  act(() => FakeAudio.last.emit("error"));
  expect(result.current.error).toBe("This song cannot be previewed in the browser.");
  // An error with no source (the element was cleared) is not reported.
  act(() => result.current.load(null));
  act(() => FakeAudio.last.emit("error"));
  expect(result.current.error).toBeNull();
});

it("seeks to a position, and pauses a playing song when the page is left", () => {
  const { result, unmount } = renderHook(() => useSongPreview());
  act(() => result.current.toggle(song));
  act(() => result.current.seek(30));
  expect(FakeAudio.last.currentTime).toBe(30);
  expect(result.current.position).toBe(30);
  const audio = FakeAudio.last;
  audio.pause.mockClear();
  unmount();
  expect(audio.pause).toHaveBeenCalledTimes(1);
});

it("leaves a paused song alone when the page is left, and does nothing when nothing was played", () => {
  const untouched = renderHook(() => useSongPreview());
  untouched.unmount();
  const { result, unmount } = renderHook(() => useSongPreview());
  act(() => result.current.toggle(song));
  act(() => result.current.toggle(song));
  FakeAudio.last.pause.mockClear();
  unmount();
  expect(FakeAudio.last.pause).not.toHaveBeenCalled();
});
