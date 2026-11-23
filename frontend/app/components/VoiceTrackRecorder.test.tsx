import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VoiceTrackRecorder } from "./VoiceTrackRecorder";
import { uploadFileToMediaBucket } from "../services/uploads";

vi.mock("../services/uploads", () => ({ uploadFileToMediaBucket: vi.fn() }));

/** A browser recorder: captures what the page records and when it stops. */
class FakeRecorder {
  static supported = ["audio/webm", "audio/mp4"];
  static last: FakeRecorder | null = null;
  static isTypeSupported(type: string) {
    return FakeRecorder.supported.includes(type);
  }
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  stopCalls = 0;
  constructor(
    readonly stream: unknown,
    readonly options: { mimeType: string },
  ) {
    FakeRecorder.last = this;
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.stopCalls += 1;
    this.state = "inactive";
  }
  /** The browser delivers data and then the stop event. */
  finish(...parts: string[]) {
    for (const part of parts) this.ondataavailable?.({ data: new Blob([part]) });
    this.onstop?.();
  }
}

const track = () => ({ stop: vi.fn() });
let tracks: ReturnType<typeof track>[];
let getUserMedia: ReturnType<typeof vi.fn>;
let play: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn>;
const createdAudio: { src: string; volume: number }[] = [];

beforeEach(() => {
  FakeRecorder.supported = ["audio/webm", "audio/mp4"];
  FakeRecorder.last = null;
  tracks = [track()];
  getUserMedia = vi.fn(async () => ({ getTracks: () => tracks }));
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  // jsdom has no object URLs; the browser's are stood in for here.
  Object.assign(URL, {
    createObjectURL: vi.fn(() => "blob:take"),
    revokeObjectURL: vi.fn(),
  });
  play = vi.fn(async () => {});
  pause = vi.fn();
  createdAudio.length = 0;
  vi.stubGlobal(
    "Audio",
    class {
      volume = 1;
      constructor(readonly src: string) {
        createdAudio.push(this);
      }
      play = play;
      pause = pause;
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(uploadFileToMediaBucket).mockReset();
});

const props = () => ({
  songTitle: "Fictional song",
  songUrl: "https://media.example.test/song.mp3",
  onAttach: vi.fn(async () => {}),
  onClose: vi.fn(),
});

async function recordTake(...parts: string[]) {
  fireEvent.click(screen.getByRole("button", { name: "Record" }));
  await screen.findByRole("status");
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  act(() => FakeRecorder.last!.finish(...parts));
}

it("records a take from the microphone, previews it and stops the microphone", async () => {
  render(<VoiceTrackRecorder {...props()} />);
  expect(screen.getByText("Fictional song")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Use this take" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Record" }));
  expect(await screen.findByRole("status")).toHaveTextContent("RECORDING");
  expect(getUserMedia).toHaveBeenCalledWith({
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  expect(FakeRecorder.last!.options).toEqual({ mimeType: "audio/webm" });
  expect(screen.getByRole("button", { name: "Record" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(FakeRecorder.last!.stopCalls).toBe(1);
  expect(screen.queryByRole("status")).toBeNull();
  act(() => FakeRecorder.last!.finish("", "voice"));

  expect(screen.getByLabelText("Recorded voice track")).toHaveAttribute(
    "src",
    "blob:take",
  );
  expect(tracks[0].stop).toHaveBeenCalled();
  const recorded = vi.mocked(URL.createObjectURL).mock.calls[0][0] as File;
  expect(recorded.name).toMatch(/^voice-track-\d+\.webm$/);
  expect(recorded.type).toBe("audio/webm");
  expect(screen.getByRole("button", { name: "Use this take" })).toBeEnabled();
});

it("records m4a where the browser only supports mp4", async () => {
  FakeRecorder.supported = ["audio/mp4"];
  render(<VoiceTrackRecorder {...props()} />);
  await recordTake("voice");
  const recorded = vi.mocked(URL.createObjectURL).mock.calls[0][0] as File;
  expect(recorded.name).toMatch(/\.m4a$/);
  expect(recorded.type).toBe("audio/mp4");
});

it("asks to record again when the take is empty", async () => {
  render(<VoiceTrackRecorder {...props()} />);
  await recordTake();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "The recording was empty. Please record again.",
  );
  expect(screen.queryByLabelText("Recorded voice track")).toBeNull();
});

it("explains why recording could not start", async () => {
  FakeRecorder.supported = [];
  const view = render(<VoiceTrackRecorder {...props()} />);
  fireEvent.click(screen.getByRole("button", { name: "Record" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This browser cannot record a supported audio format.",
  );
  expect(getUserMedia).not.toHaveBeenCalled();
  view.unmount();

  FakeRecorder.supported = ["audio/webm"];
  getUserMedia.mockRejectedValueOnce("denied");
  render(<VoiceTrackRecorder {...props()} />);
  fireEvent.click(screen.getByRole("button", { name: "Record" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Microphone access failed.",
  );
});

it("releases a microphone still held when a later start fails", async () => {
  render(<VoiceTrackRecorder {...props()} />);
  fireEvent.click(screen.getByRole("button", { name: "Record" }));
  await screen.findByRole("status");
  // Stop before the browser delivers the stop event: the microphone is held.
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  getUserMedia.mockRejectedValueOnce(new Error("Device busy"));
  fireEvent.click(screen.getByRole("button", { name: "Record" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Device busy");
  expect(tracks[0].stop).toHaveBeenCalled();
});

it("does not stop a recorder that is no longer recording", async () => {
  render(<VoiceTrackRecorder {...props()} />);
  fireEvent.click(screen.getByRole("button", { name: "Record" }));
  await screen.findByRole("status");
  FakeRecorder.last!.state = "inactive";
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(FakeRecorder.last!.stopCalls).toBe(0);
  expect(screen.queryByRole("status")).toBeNull();
});

it("previews the take over the ducked song, replacing an earlier preview", async () => {
  render(<VoiceTrackRecorder {...props()} />);
  await recordTake("voice");
  fireEvent.change(screen.getByLabelText("Song under voice (0–1)"), {
    target: { value: "0.5" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview over song" }));
  await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
  expect(createdAudio).toEqual([
    expect.objectContaining({
      src: "https://media.example.test/song.mp3",
      volume: 0.5,
    }),
    expect.objectContaining({ src: "blob:take" }),
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Preview over song" }));
  await waitFor(() => expect(play).toHaveBeenCalledTimes(4));
  expect(pause).toHaveBeenCalledTimes(2);

  play.mockRejectedValueOnce(new Error("NotAllowedError"));
  fireEvent.click(screen.getByRole("button", { name: "Preview over song" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Segue preview could not play. Check browser audio permissions.",
  );
});

it("uploads the take as an audio clip, attaches it with the mix and closes", async () => {
  vi.mocked(uploadFileToMediaBucket).mockResolvedValue({
    key: "instant/take.webm",
    url: "https://media.example.test/take.webm",
    bucket: "media",
    contentType: "audio/webm",
    sizeBytes: 5,
  });
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ id: 42 }), { status: 201 }));
  const handlers = props();
  let finishAttach!: () => void;
  handlers.onAttach.mockImplementation(
    () => new Promise<void>((done) => (finishAttach = done)),
  );
  render(<VoiceTrackRecorder {...handlers} />);
  await recordTake("voice");
  fireEvent.change(screen.getByLabelText("Fade in (seconds)"), {
    target: { value: "1" },
  });
  fireEvent.change(screen.getByLabelText("Fade out (seconds)"), {
    target: { value: "2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Use this take" }));
  expect(
    await screen.findByRole("button", { name: "Saving link…" }),
  ).toBeDisabled();
  await waitFor(() =>
    expect(handlers.onAttach).toHaveBeenCalledWith(42, {
      duckGain: 0.35,
      fadeInSeconds: 1,
      fadeOutSeconds: 2,
    }),
  );
  expect(uploadFileToMediaBucket).toHaveBeenCalledWith(
    "instant",
    expect.any(File),
  );
  const [, init] = transport.mock.calls[0];
  expect(transport.mock.calls[0][0]).toEqual(expect.stringContaining("/instants"));
  expect(JSON.parse(String(init!.body))).toEqual({
    name: "Voice link: Fictional song",
    audioUrl: "https://media.example.test/take.webm",
    volume: 1,
    enabled: true,
  });
  await act(async () => finishAttach());
  expect(handlers.onClose).toHaveBeenCalledTimes(1);
});

it("deletes the new clip when attaching fails, even if that cleanup fails", async () => {
  vi.mocked(uploadFileToMediaBucket).mockResolvedValue({
    key: "k",
    url: "https://media.example.test/take.webm",
    bucket: "media",
    contentType: "audio/webm",
    sizeBytes: 5,
  });
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 7 }), { status: 201 }))
    .mockRejectedValueOnce(new Error("cleanup offline"));
  const handlers = props();
  handlers.onAttach.mockRejectedValueOnce(new Error("Rundown changed"));
  render(<VoiceTrackRecorder {...handlers} />);
  await recordTake("voice");
  fireEvent.click(screen.getByRole("button", { name: "Use this take" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Rundown changed");
  expect(transport).toHaveBeenLastCalledWith(
    expect.stringContaining("/instants/7"),
    { method: "DELETE" },
  );
  expect(handlers.onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Use this take" })).toBeEnabled();
});

it("reports a clip the server refused, and an unnamed upload failure, without cleanup", async () => {
  vi.mocked(uploadFileToMediaBucket).mockResolvedValue({
    key: "k",
    url: "https://media.example.test/take.webm",
    bucket: "media",
    contentType: "audio/webm",
    sizeBytes: 5,
  });
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}", { status: 500 }));
  render(<VoiceTrackRecorder {...props()} />);
  await recordTake("voice");
  fireEvent.click(screen.getByRole("button", { name: "Use this take" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Audio clip creation failed (500)",
  );
  expect(transport).toHaveBeenCalledTimes(1);

  vi.mocked(uploadFileToMediaBucket).mockRejectedValueOnce("quota");
  fireEvent.click(screen.getByRole("button", { name: "Use this take" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Voice track could not be attached.",
  );
  expect(transport).toHaveBeenCalledTimes(1);
});

it("only accepts a mix inside its documented ranges", async () => {
  render(<VoiceTrackRecorder {...props()} />);
  await recordTake("voice");
  const use = screen.getByRole("button", { name: "Use this take" });
  const cases: [string, string][] = [
    ["Song under voice (0–1)", "-0.1"],
    ["Song under voice (0–1)", "1.1"],
    ["Fade in (seconds)", "-1"],
    ["Fade in (seconds)", "6"],
    ["Fade out (seconds)", "-1"],
    ["Fade out (seconds)", "6"],
  ];
  for (const [label, value] of cases) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    expect(use).toBeDisabled();
    fireEvent.change(screen.getByLabelText(label), { target: { value: "0.5" } });
    expect(use).toBeEnabled();
  }
});

it("cancels through onClose", () => {
  const handlers = props();
  render(<VoiceTrackRecorder {...handlers} />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(handlers.onClose).toHaveBeenCalledTimes(1);
});

it("stops recording, the microphone and any preview when it closes", async () => {
  const view = render(<VoiceTrackRecorder {...props()} />);
  await recordTake("voice");
  fireEvent.click(screen.getByRole("button", { name: "Preview over song" }));
  await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Record" }));
  await screen.findByRole("status");
  const live = FakeRecorder.last!;
  view.unmount();
  expect(live.stopCalls).toBe(1);
  expect(tracks[0].stop).toHaveBeenCalled();
  expect(pause).toHaveBeenCalledTimes(2);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:take");
});

it("closes cleanly when nothing was recorded", () => {
  render(<VoiceTrackRecorder {...props()} />).unmount();
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
});
