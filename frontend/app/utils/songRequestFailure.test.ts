import { describe, expect, it } from "vitest";
import { songRequestFailureNotice } from "./songRequestFailure";

describe("songRequestFailureNotice", () => {
  it("names the song, the artist and a timeout", () => {
    expect(
      songRequestFailureNotice({
        type: "song_request_failed",
        title: "Track 01",
        artist: "Artist 1",
        reason: "timeout",
      }),
    ).toBe(
      "“Track 01” by Artist 1 did not play: it took too long to load. The next song played instead.",
    );
  });

  it("covers any other reason and missing names", () => {
    expect(
      songRequestFailureNotice({ type: "song_request_failed", title: " ", reason: "other" }),
    ).toBe("“A song” did not play: it could not be loaded. The next song played instead.");
  });

  it("ignores every other event", () => {
    expect(songRequestFailureNotice(null)).toBeNull();
    expect(songRequestFailureNotice("x")).toBeNull();
    expect(songRequestFailureNotice({ type: "song_off_air" })).toBeNull();
  });
});
