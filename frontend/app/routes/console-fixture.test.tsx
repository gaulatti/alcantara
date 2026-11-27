import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import ConsoleFixture from "./console-fixture";

// gaulatti/alcantara#187, group G4: the console's visual fixture route. The
// components it composes have their own specs, so each is a stand-in that
// shows what the route hands it and calls back the way the real one would.

const show = (value: unknown) => JSON.stringify(value);
function Box({
  name,
  data,
  actions,
}: {
  name: string;
  data: unknown;
  actions?: Record<string, () => unknown>;
}) {
  return (
    <section aria-label={name}>
      <output>{show(data)}</output>
      {Object.entries(actions ?? {}).map(([label, run]) => (
        <button key={label} type="button" onClick={() => void run()}>
          {`${name}: ${label}`}
        </button>
      ))}
    </section>
  );
}

vi.mock("../components/BroadcastSwitcherDeck", () => ({
  BroadcastSwitcherDeck: (p: any) => (
    <Box
      name="deck"
      data={{
        active: p.activeScene?.name ?? null,
        staged: p.stagedScene?.name ?? null,
        transition: p.transitionId,
        connected: p.realtimeConnected,
        busy: p.takeBusy,
        error: p.takeError,
        ftb: p.fadeToBlack,
        workspace: p.workspace,
        scenes: p.scenes.length,
      }}
      actions={{
        "stage 1": () => p.onStageScene(1),
        "stage 2": () => p.onStageScene(2),
        "stage unknown": () => p.onStageScene(99),
        take: () => p.onTake(),
        cut: () => p.onCut(),
        ftb: () => p.onFadeToBlack(),
        "audio workspace": () => p.onWorkspaceChange("audio"),
        "director workspace": () => p.onWorkspaceChange("director"),
        transition: () => p.onTransitionChange("wipe"),
      }}
    />
  ),
}));
vi.mock("../components/RadioPanel", () => ({
  RadioPanel: (p: any) => (
    <Box
      name="radio"
      data={{
        sampleAgeMs: Date.now() - Date.parse(p.fixtureData.output.lastSampleAt),
        stream: p.fixtureData.stream.running,
        palazzo: p.fixtureData.palazzo.connection,
        playout: p.fixtureData.palazzo.playout,
        output: p.fixtureData.output.state,
        expected: p.fixtureData.output.expectedAudio,
        rms: p.fixtureData.output.outputRms,
        skipped: p.fixtureData.logs.flatMap((log: any) =>
          (log.cueOutcomes ?? []).map((outcome: any) => outcome.cueId),
        ),
        active: p.fixtureData.logs.map((log: any) => log.activeItemId),
        recovery: {
          prepared: p.fixtureData.recovery.preparedVersion,
          bound: p.fixtureData.recovery.automation?.filler.ready === true,
        },
        logs: p.fixtureData.logs.map((log: any) =>
          log.items
            .map(
              (item: any) =>
                `${item.isFiller ? "F" : "S"}${item.clockOffsetSeconds ?? ""}`,
            )
            .join(","),
        ),
        songs: p.songSequence.items.length,
        mode: p.songSequence.mode,
        queue: p.songQueue.map((entry: any) => entry.itemId),
        catalog: p.songCatalog
          .map((song: any) => `${song.id}:${song.durationMs}`)
          .slice(0, 2),
        playback: p.programSongPlayback && {
          token: p.programSongPlayback.token,
          title: p.programSongPlayback.title,
          stale: p.programSongPlayback.telemetryStale,
        },
        error: p.playoutError,
        instants: p.instants.length,
        search: p.instantSearch,
        playing: Object.keys(p.instantPlayback),
        mixer: p.mixer,
        instantError: p.instantError,
        instantsLoadError: p.instantsLoadError,
        songLoadError: p.songCatalogLoadError,
      }}
      actions={{
        save: () => p.onSaveSongSequence({ ...p.songSequence, items: [] }),
        queue: () => p.onQueueSong("fixture-song-3"),
        "remove first": () => p.onRemoveQueuedSong(p.songQueue[0].id),
        reverse: () =>
          p.onReorderSongQueue(
            p.songQueue.map((entry: any) => entry.id).reverse(),
          ),
        "off air": () => p.onTakeOffAir(),
        search: () => p.onInstantSearchChange("news"),
        trigger: () => p.onTriggerInstant(2),
        "stop all": () => p.onStopAllInstants(),
        "song volume": () => p.onSongVolumeChange(0.5),
        "instant volume": () => p.onInstantVolumeChange(0.25),
        "main volume": () => p.onMainVolumeChange(0.6),
        "mute song": () => p.onToggleSongMuted(),
        "mute instants": () => p.onToggleInstantMuted(),
        "retry songs": () => p.onRetrySongCatalog(),
        "retry instants": () => p.onRetryInstants(),
      }}
    />
  ),
}));
vi.mock("../components/PlayNextQueue", () => ({
  PlayNextQueue: (p: any) => (
    <Box
      name="queue"
      data={{
        queue: p.queue.map((entry: any) => entry.id),
        active: p.activeQueueEntryId,
        songs: p.sequence.items.length,
      }}
      actions={{
        "remove first": () => p.onRemove(p.queue[0].id),
        "reverse with an unknown id": () =>
          p.onReorder([
            "missing",
            ...p.queue.map((entry: any) => entry.id).reverse(),
          ]),
      }}
    />
  ),
}));
vi.mock("../components/TvAudioWorkspace", () => ({
  TvAudioWorkspace: (p: any) => (
    <Box
      name="audio"
      data={{
        channels: p.mixer.channels.map((channel: any) => ({
          id: channel.id,
          volume: channel.volume,
          muted: channel.muted,
          solo: channel.solo,
          presets: channel.presets ?? null,
          meter: channel.meter ? channel.meter.fill : null,
          controls: [
            "onToggleMuted",
            "onToggleSolo",
            "onCommitPreset",
            "onTake",
          ].filter((name) => name in channel),
        })),
        fade: p.mixer.fadeMs,
        loading: p.mixer.loading,
        error: p.mixer.error,
        songs: p.music.sequence.items.length,
        instants: p.cartwall.instants.length,
        search: p.cartwall.search,
        playing: Object.keys(p.cartwall.playback),
      }}
      actions={{
        "music volume": () => p.mixer.channels[0].onVolumeChange(0.3),
        "main volume": () => p.mixer.channels[4].onVolumeChange(0.7),
        "mute music": () => p.mixer.channels[0].onToggleMuted(),
        "solo music": () => p.mixer.channels[0].onToggleSolo(),
        "preset a -10": () => p.mixer.channels[0].onCommitPreset("a", "-10"),
        "preset b invalid": () =>
          p.mixer.channels[0].onCommitPreset("b", "loud"),
        "take a": () => p.mixer.channels[0].onTake("a"),
        "take b": () => p.mixer.channels[0].onTake("b"),
        "fade 2s": () => p.mixer.onFadeChange(2000),
        "music change": () =>
          p.music.onChange({
            ...p.music.sequence,
            items: p.music.sequence.items.slice(0, 1),
          }),
        "music take": () =>
          p.music.onTakeSelection({
            ...p.music.sequence,
            items: p.music.sequence.items.slice(0, 1),
          }),
        "add songs": () => p.music.onAddSongs(),
        "cart search": () => p.cartwall.onSearchChange("sting"),
        "cart trigger": () => p.cartwall.onTrigger(4),
        "cart stop": () => p.cartwall.onStopAll(),
      }}
    />
  ),
}));
vi.mock("../components/PlaybackBar", () => ({
  PlaybackBar: (p: any) => (
    <Box
      name="playback"
      data={{
        songs: p.sequence.items.length,
        active: p.sequence.activeItemId,
        mode: p.sequence.mode,
        token: p.programSongPlayback?.token ?? null,
        stale: p.programSongPlayback?.telemetryStale ?? null,
      }}
      actions={{
        change: () =>
          p.onChange({ ...p.sequence, items: p.sequence.items.slice(0, 1) }),
        take: () =>
          p.onTakeSelection({ ...p.sequence, activeItemId: "fixture-song-2" }),
        "off air": () => p.onTakeOffAir(),
        "stop instants": () => p.onStopAllInstants(),
      }}
    />
  ),
}));
vi.mock("../components/editors", () => ({
  ProgramSongSequenceEditor: (p: any) => (
    <Box
      name="editor"
      data={{ songs: p.sequence.items.length, view: p.view }}
      actions={{ change: () => p.onChange({ ...p.sequence, items: [] }) }}
    />
  ),
}));
vi.mock("../components/SimulcastStatusRail", () => ({
  SimulcastStatusRail: (p: any) => <Box name="simulcast" data={p} />,
}));
vi.mock("../components/ScenePreparationFixture", () => ({
  ScenePreparationFixture: (p: any) => <Box name="prepare" data={p} />,
}));
vi.mock("../components/AppLoading", () => ({
  AppLoading: () => <Box name="loading" data={null} />,
}));
vi.mock("../components/RecipeEditorFixture", () => ({
  RecipeEditorFixture: () => <Box name="rundown recipes" data={null} />,
}));
vi.mock("../components/RundownRecipeFixture", () => ({
  RundownRecipeFixture: () => <Box name="rundown recipe" data={null} />,
}));
vi.mock("../components/RundownFixture", () => ({
  RundownFixture: () => <Box name="rundown desk" data={null} />,
}));
vi.mock("../components/ReturnCallersFixture", () => ({
  ProgramReturnFixture: () => <Box name="program return" data={null} />,
  CallerDeskFixture: () => <Box name="caller desk" data={null} />,
}));
vi.mock("../components/RundownFillers", () => ({
  RundownFillers: (p: any) => (
    <Box
      name="fillers"
      data={{
        program: p.programId,
        rundown: p.rundown.name,
        items: p.items.length,
        labels: p.fixtureLabels,
      }}
      actions={{ filled: () => p.onFilled() }}
    />
  ),
}));

afterEach(cleanup);

function open(query = "") {
  return render(
    <MemoryRouter initialEntries={[`/console-fixture${query}`]}>
      <ConsoleFixture />
    </MemoryRouter>,
  );
}
const data = (name: string) =>
  JSON.parse(
    within(screen.getByRole("region", { name })).getByRole("status")
      .textContent!,
  );
const press = (label: string) =>
  fireEvent.click(screen.getByRole("button", { name: label }));

it("opens the director's desk by default and takes, cuts and fades to black", () => {
  open();
  const main = screen.getByRole("main");
  expect(main).toHaveAttribute("data-visual-fixture", "normal");
  expect(main.className).not.toContain("flex-col");
  expect(screen.queryByRole("region", { name: "simulcast" })).toBeNull();
  expect(data("deck")).toEqual({
    active: "Anchor desk",
    staged: "Wide camera",
    transition: "crescendo-prism",
    connected: true,
    busy: false,
    error: null,
    ftb: false,
    workspace: "director",
    scenes: 2,
  });
  press("deck: take");
  expect(data("deck")).toMatchObject({
    active: "Wide camera",
    staged: "Anchor desk",
  });
  press("deck: cut");
  expect(data("deck")).toMatchObject({
    active: "Anchor desk",
    staged: "Wide camera",
  });
  press("deck: stage unknown");
  expect(data("deck")).toMatchObject({ staged: null });
  press("deck: take");
  expect(data("deck")).toMatchObject({ active: "Anchor desk", staged: null });
  press("deck: stage 2");
  expect(data("deck")).toMatchObject({ staged: "Anchor desk" });
  press("deck: stage 1");
  expect(data("deck")).toMatchObject({ staged: "Wide camera" });
  press("deck: ftb");
  expect(data("deck")).toMatchObject({ ftb: true });
  press("deck: transition");
  expect(data("deck")).toMatchObject({ transition: "wipe" });
  press("deck: director workspace");
  expect(screen.queryByRole("region", { name: "audio" })).toBeNull();
});

it("opens each desk state from the query", () => {
  const states: [string, Record<string, unknown>][] = [
    ["?state=empty-preview", { staged: null }],
    ["?state=on-air", { staged: "Anchor desk" }],
    ["?state=ftb", { ftb: true }],
    ["?state=disconnected", { connected: false }],
    ["?state=taking", { busy: true }],
    [
      "?state=take-failed",
      { error: "Scene save failed. Program has not changed." },
    ],
    ["?state=remote", { workspace: "compact" }],
  ];
  for (const [query, expected] of states) {
    open(query);
    expect(data("deck")).toMatchObject(expected);
    cleanup();
  }
  // A failed take leaves Program as it was.
  open("?state=take-failed");
  press("deck: take");
  expect(data("deck")).toMatchObject({
    active: "Anchor desk",
    staged: "Wide camera",
  });
  cleanup();
  open("?mode=both");
  expect(data("simulcast")).toEqual({ programId: "fixture" });
});

it("opens the single-component fixtures", () => {
  open("?state=rundown-fillers");
  expect(screen.getByRole("heading", { name: "Rundown" })).toBeInTheDocument();
  expect(data("fillers")).toEqual({
    program: "radio-demo",
    rundown: "Fixture hour",
    items: 1,
    labels: [{ id: "fixture-music", name: "Music rotation" }],
  });
  press("fillers: filled");
  cleanup();

  open("?state=rundown-library-empty");
  expect(screen.getByRole("link", { name: "Media" })).toHaveAttribute("href", "/media");
  expect(screen.getByText(/No audio clips yet/)).toBeInTheDocument();
  // The fixture's library adds nothing: the Stop still double-clicks without effect.
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  fireEvent.doubleClick(screen.getByRole("option", { name: /Stop program audio/ }));
  expect(screen.getByRole("option", { name: /Stop program audio/ })).toBeInTheDocument();
  cleanup();

  // #688: plain links in the app and in a console, for the global focus-visible ring.
  open("?state=focus-ring");
  for (const name of ["App link", "App route link", "Console link", "Configure"]) {
    const link = screen.getByRole("link", { name });
    expect(link.className).not.toMatch(/outline-none|focus-visible:/);
  }
  expect(screen.getByRole("link", { name: "Configure" }).closest(".broadcast-console")).not.toBeNull();
  expect(screen.getByRole("link", { name: "App link" }).closest(".broadcast-console")).toBeNull();
  cleanup();

  open("?state=button-help");
  expect(
    screen.getByRole("heading", { name: "Button help" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Open Media library" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "TAKE" })).toBeDisabled();
  cleanup();

  const single: [string, string, unknown][] = [
    ["?state=rundown-desk", "rundown desk", null],
    ["?state=rundown-recipes", "rundown recipes", null],
    ["?state=rundown-recipe", "rundown recipe", null],
    ["?state=program-return", "program return", null],
    ["?state=caller-desk", "caller desk", null],
    ["?state=loading", "loading", null],
    ["?state=hidden-component", "prepare", {}],
    ["?state=prepare-timezone", "prepare", { timezone: true }],
    [
      "?state=prepare-clock",
      "prepare",
      { clock: true, error: false, saving: false },
    ],
    [
      "?state=prepare-error",
      "prepare",
      { clock: true, error: true, saving: false },
    ],
    [
      "?state=prepare-saving",
      "prepare",
      { clock: true, error: false, saving: true },
    ],
  ];
  for (const [query, name, expected] of single) {
    open(query);
    expect(data(name)).toEqual(expected);
    cleanup();
  }
});

it("edits the high-rotation playlist and reorders the Play Next queue", () => {
  open("?state=high-rotation");
  expect(data("editor")).toEqual({ songs: 2, view: "queue" });
  press("editor: change");
  expect(data("editor")).toEqual({ songs: 0, view: "queue" });
  cleanup();

  open("?state=play-next");
  expect(data("queue")).toEqual({
    queue: ["fixture-queue-1", "fixture-queue-2"],
    active: "fixture-queue-1",
    songs: 2,
  });
  press("queue: reverse with an unknown id");
  expect(data("queue")).toMatchObject({
    queue: ["fixture-queue-2", "fixture-queue-1"],
  });
  press("queue: remove first");
  expect(data("queue")).toMatchObject({ queue: ["fixture-queue-1"] });
});

it("drives the playback bar fixture on and off air", () => {
  open("?state=playback-live");
  expect(screen.getByText("Playback control fixture")).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "deck" })).toBeNull();
  expect(data("playback")).toEqual({
    songs: 2,
    active: "fixture-song-1",
    mode: "shuffle",
    token: "fixture-song-1:https://example.test/fixture-song-1.mp3",
    stale: false,
  });
  press("playback: off air");
  expect(data("playback")).toEqual({
    songs: 2,
    active: null,
    mode: "manual",
    token: null,
    stale: null,
  });
  press("playback: take");
  expect(data("playback")).toMatchObject({
    active: "fixture-song-2",
    token: "fixture-song-2:https://example.test/fixture-song-1.mp3",
  });
  press("playback: change");
  expect(data("playback")).toMatchObject({ songs: 1 });
  press("playback: stop instants");
  cleanup();
  open("?state=playback-stale");
  expect(data("playback")).toMatchObject({ stale: true });
});

// gaulatti/alcantara#706: the unverified fixture hands the desk audible output whose last sample is 10 s old.
it("hands the radio desk audible output with a stale sample for the unverified state", () => {
  open("?state=radio-unverified");
  const unverified = data("radio");
  expect(unverified.output).toBe("audible");
  expect(unverified.sampleAgeMs).toBeGreaterThanOrEqual(10_000);
  cleanup();
  open("?state=radio-live");
  expect(data("radio").sampleAgeMs).toBeLessThan(6_000);
});

it("hands the radio desk its fixture data for every radio state", () => {
  open("?state=radio-live");
  const live = data("radio");
  expect(live).toMatchObject({
    stream: true,
    palazzo: "connected",
    output: "audible",
    expected: true,
    rms: 0.08,
    songs: 12,
    queue: ["fixture-song-2", "fixture-song-1"],
    catalog: ["1:180000", "2:210000"],
    playback: {
      token: "fixture-song-1:playback",
      title: "Authoritative Feedback",
      stale: false,
    },
    error: null,
    instants: 8,
    search: "",
    playing: [],
    mixer: {
      song: { volume: 0.75, peak: 0.3, muted: false },
      instants: { volume: 0.8, peak: 0, muted: false },
      main: { volume: 0.9, peak: 0.4 },
      saving: false,
      error: null,
    },
  });
  expect(live.logs).toEqual(["S0,F,F,F,F,F,S1440,S,S,S,S,S"]);
  expect(screen.queryByRole("region", { name: "audio" })).toBeNull();
  cleanup();

  const states: [string, Record<string, unknown>][] = [
    [
      "?state=radio-offline",
      { stream: false, palazzo: "unavailable", output: "unavailable" },
    ],
    ["?state=radio-not-configured", { palazzo: "unavailable" }],
    ["?state=radio-playout-down", { palazzo: "connected", playout: "down" }],
    ["?state=radio-continuous", { logs: [] }],
    ["?state=radio-audio-off-rundown", { logs: [], playback: null, output: "audible" }],
    ["?state=radio-manual-off-air", { logs: [], playback: null, mode: "manual" }],
    [
      "?state=radio-skipped",
      { skipped: ["fixture-cue-2"], active: ["fixture-cue-3"] },
    ],
    [
      "?state=radio-stale",
      {
        playback: {
          token: "fixture-song-1:playback",
          title: "Authoritative Feedback",
          stale: true,
        },
      },
    ],
    [
      "?state=radio-external",
      {
        playback: {
          token: "external:playback",
          title: "External live track",
          stale: false,
        },
      },
    ],
    [
      "?state=radio-song-failed",
      {
        error:
          "“Harbor Light” by The Lighthouse Keepers did not play: it took too long to load. The next song played instead.",
      },
    ],
    [
      "?state=radio-empty",
      {
        output: "idle",
        expected: false,
        rms: 0,
        songs: 0,
        queue: [],
        playback: null,
        instants: 0,
        logs: [],
        mixer: expect.objectContaining({
          song: { volume: 0.75, peak: 0, muted: false },
          main: { volume: 0.9, peak: 0 },
        }),
      },
    ],
  ];
  for (const [query, expected] of states) {
    open(query);
    expect(data("radio")).toMatchObject(expected);
    cleanup();
  }
});

it("takes the radio desk's commands into its fixture state", () => {
  vi.spyOn(Date, "now").mockReturnValue(7);
  open("?state=radio-live");
  press("radio: queue");
  expect(data("radio").queue).toEqual([
    "fixture-song-2",
    "fixture-song-1",
    "fixture-song-3",
  ]);
  press("radio: reverse");
  expect(data("radio").queue).toEqual([
    "fixture-song-3",
    "fixture-song-1",
    "fixture-song-2",
  ]);
  press("radio: remove first");
  expect(data("radio").queue).toEqual(["fixture-song-1", "fixture-song-2"]);
  press("radio: search");
  press("radio: trigger");
  expect(data("radio")).toMatchObject({ search: "news", playing: ["2"] });
  press("radio: stop all");
  expect(data("radio").playing).toEqual([]);
  for (const label of [
    "song volume",
    "instant volume",
    "main volume",
    "mute song",
    "mute instants",
  ])
    press(`radio: ${label}`);
  expect(data("radio").mixer).toMatchObject({
    song: { volume: 0.5, muted: true },
    instants: { volume: 0.25, muted: true },
    main: { volume: 0.6 },
  });
  press("radio: save");
  expect(data("radio").songs).toBe(0);
  press("radio: off air");
  expect(data("radio").playback).toBeNull();
  vi.restoreAllMocks();
});

it("shows the radio desk's refused instant and failed loads, and clears each on retry", () => {
  open("?state=radio-live");
  expect(data("radio")).toMatchObject({ instantError: null, instantsLoadError: null, songLoadError: null });
  cleanup();
  open("?state=radio-refused");
  expect(data("radio")).toMatchObject({
    instantError: "Could not play News sting: Instant is disabled for this program",
    instantsLoadError: "Fictional library is offline",
    songLoadError: "HTTP 503",
  });
  press("radio: retry songs");
  expect(data("radio")).toMatchObject({ songLoadError: null, instantsLoadError: "Fictional library is offline" });
  // A retry clears only its own list's error; the refusal stays until the
  // next instant starts.
  press("radio: retry instants");
  expect(data("radio")).toMatchObject({
    instantsLoadError: null,
    instantError: "Could not play News sting: Instant is disabled for this program",
  });
  press("radio: trigger");
  expect(data("radio").instantError).toBeNull();
  cleanup();
  open("?state=radio-refused");
  press("radio: stop all");
  expect(data("radio").instantError).toBeNull();
});

it("opens the audio workspace with its mixer, music, cartwall and transport", () => {
  open("?state=audio");
  const main = screen.getByRole("main");
  expect(main.className).toContain("flex flex-col overflow-y-auto");
  const audio = data("audio");
  expect(
    audio.channels.map((channel: any) => [
      channel.id,
      channel.volume,
      channel.meter,
      channel.controls.length,
    ]),
  ).toEqual([
    ["song", 0.8, 0.45, 4],
    ["stream", 0.8, null, 4],
    ["instants", 0.8, 0, 4],
    ["sceneInstant", 0.8, 0, 4],
    ["main", 1, 0.45, 0],
  ]);
  expect(audio.channels[4].presets).toBeNull();
  expect(audio).toMatchObject({
    fade: 5000,
    loading: false,
    error: null,
    songs: 12,
    instants: 8,
  });
  expect(data("playback")).toMatchObject({ songs: 12, token: null });

  press("audio: music volume");
  press("audio: main volume");
  press("audio: mute music");
  press("audio: solo music");
  press("audio: preset a -10");
  press("audio: preset b invalid");
  expect(data("audio").channels[0]).toMatchObject({
    volume: 0.3,
    muted: true,
    solo: true,
    presets: { aDb: -10, bDb: -30 },
  });
  expect(data("audio").channels[4].volume).toBe(0.7);
  press("audio: take a");
  const takeA = data("audio").channels[0].volume;
  press("audio: take b");
  expect(data("audio").channels[0].volume).toBeLessThan(takeA);
  press("audio: fade 2s");
  expect(data("audio").fade).toBe(2000);

  press("audio: music change");
  expect(data("audio").songs).toBe(1);
  press("audio: add songs");
  expect(data("audio").songs).toBe(12);
  press("audio: music take");
  expect(data("audio").songs).toBe(1);
  press("audio: add songs");
  press("audio: cart search");
  press("audio: cart trigger");
  expect(data("audio")).toMatchObject({ search: "sting", playing: ["4"] });
  press("audio: cart stop");
  expect(data("audio").playing).toEqual([]);

  press("playback: take");
  expect(data("playback").active).toBe("fixture-song-2");
  press("playback: change");
  expect(data("playback").songs).toBe(1);
  press("playback: off air");
  expect(data("playback")).toMatchObject({ active: null, mode: "manual" });
  press("audio: cart trigger");
  press("playback: stop instants");
  expect(data("audio").playing).toEqual([]);
});

it("opens the audio workspace's loading, error and empty states", () => {
  const states: [string, Record<string, unknown>][] = [
    ["?state=audio-loading", { loading: true }],
    [
      "?state=audio-error",
      { error: "Mixer change was not applied to Palazzo. Try again." },
    ],
    ["?state=audio-empty", { songs: 0, instants: 0 }],
  ];
  for (const [query, expected] of states) {
    open(query);
    expect(data("audio")).toMatchObject(expected);
    cleanup();
  }
  // The director can open the audio workspace from the desk.
  open();
  press("deck: audio workspace");
  expect(data("audio").songs).toBe(2);
});

// gaulatti/alcantara#694: the dead-air fixture hands the desk a silent output with a song expected, and a recovery
// playlist prepared but not bound, so the strip's dead-air chip and the "then Start with fallback" action show.
it("hands the radio desk a dead-air output with a prepared, unbound recovery playlist", () => {
  open("?state=radio-dead-air");
  expect(data("radio")).toMatchObject({
    output: "silent",
    expected: true,
    rms: 0,
    recovery: { prepared: "fixture-filler", bound: false },
  });
  cleanup();
  open("?state=radio-live");
  expect(data("radio")).toMatchObject({
    output: "audible",
    recovery: { prepared: "fixture-filler", bound: true },
  });
});
