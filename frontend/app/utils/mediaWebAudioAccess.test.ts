import { describe, expect, it } from "vitest";
import { canRouteMediaThroughWebAudio } from "./mediaWebAudioAccess";

const media = (
  src: string,
  crossOrigin: string | null = null,
  currentSrc = "",
) => ({ src, currentSrc, crossOrigin }) as unknown as HTMLMediaElement;

describe("whether Web Audio may take over a media element", () => {
  const page = "tauri://localhost/control";

  it("refuses a cross-origin source loaded without CORS (Web Audio would output silence)", () => {
    expect(
      canRouteMediaThroughWebAudio(
        media("https://bucket.example.test/song.mp3"),
        page,
      ),
    ).toBe(false);
    expect(
      canRouteMediaThroughWebAudio(
        media("https://bucket.example.test/song.mp3"),
        "https://console.example.test/",
      ),
    ).toBe(false);
  });

  it("allows a source loaded in CORS mode, same-origin, blob: and data: sources", () => {
    expect(
      canRouteMediaThroughWebAudio(
        media("https://bucket.example.test/song.mp3", "anonymous"),
        page,
      ),
    ).toBe(true);
    expect(
      canRouteMediaThroughWebAudio(
        media("https://bucket.example.test/song.mp3", "use-credentials"),
        page,
      ),
    ).toBe(true);
    expect(
      canRouteMediaThroughWebAudio(
        media("/media/song.mp3"),
        "https://console.example.test/control",
      ),
    ).toBe(true);
    expect(
      canRouteMediaThroughWebAudio(
        media("blob:https://console.example.test/1234"),
        page,
      ),
    ).toBe(true);
    expect(
      canRouteMediaThroughWebAudio(media("data:audio/wav;base64,AAAA"), page),
    ).toBe(true);
  });

  it("reads the element's current source first, and refuses no source or an unreadable address", () => {
    expect(
      canRouteMediaThroughWebAudio(
        media("/media/song.mp3", null, "https://bucket.example.test/song.mp3"),
        "https://console.example.test/",
      ),
    ).toBe(false);
    expect(canRouteMediaThroughWebAudio(media(""), page)).toBe(false);
    expect(canRouteMediaThroughWebAudio(media("http://[bad"), page)).toBe(
      false,
    );
  });

  it("uses the window's address by default", () => {
    expect(
      canRouteMediaThroughWebAudio(
        media(`${window.location.origin}/media/song.mp3`),
      ),
    ).toBe(true);
    expect(
      canRouteMediaThroughWebAudio(
        media("https://bucket.example.test/song.mp3"),
      ),
    ).toBe(false);
  });
});
