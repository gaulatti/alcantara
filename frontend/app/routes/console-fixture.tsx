import { useState } from "react";
import { Button, IconButton } from "@gaulatti/bleecker";
import { TooltipButton } from "../components/BleeckerButtons";
import { useSearchParams } from "react-router";
import {
  BroadcastSwitcherDeck,
  type ConsoleWorkspace,
} from "../components/BroadcastSwitcherDeck";
import type { Scene } from "../models/broadcast";
import { SimulcastStatusRail } from "../components/SimulcastStatusRail";
import { PlaybackBar } from "../components/PlaybackBar";
import { PlayNextQueue } from "../components/PlayNextQueue";
import type { ProgramSongSequence } from "../utils/programSequence";
import type { ProgramSongQueueEntry } from "../models/broadcast";
import { ProgramSongSequenceEditor } from "../components/editors";
import { ScenePreparationFixture } from "../components/ScenePreparationFixture";
import { AppLoading } from "../components/AppLoading";
import { RundownFixture } from "../components/RundownFixture";
import { RundownFillers } from "../components/RundownFillers";
import {
  TvAudioWorkspace,
  type TvAudioChannel,
} from "../components/TvAudioWorkspace";
import { dbToFader } from "../utils/audioTaper";
import { normalizeTakeVolumePresetDb } from "../utils/broadcast";
import { RadioPanel } from "../components/RadioPanel";

const layout = {
  id: 1,
  name: "Fixture layout",
  componentType: "full-screen",
  settings: "{}",
};
const previewScene: Scene = {
  id: 1,
  name: "Wide camera",
  layoutId: 1,
  layout,
  chyronText: null,
  metadata: '{"full-screen":{"text":"PREVIEW FIXTURE"}}',
};
const programScene: Scene = {
  id: 2,
  name: "Anchor desk",
  layoutId: 1,
  layout,
  chyronText: null,
  metadata: '{"full-screen":{"text":"PROGRAM FIXTURE"}}',
};
const playbackSequence: ProgramSongSequence = {
  mode: "shuffle",
  loop: true,
  activeItemId: "fixture-song-1",
  startedAt: Date.now() - 42_000,
  items: [
    {
      id: "fixture-song-1",
      kind: "preset",
      artist: "The Test Signals",
      title: "Authoritative Feedback",
      coverUrl: "",
      audioUrl: "https://example.test/fixture-song-1.mp3",
      durationMs: 180_000,
      highRotation: true,
    },
    {
      id: "fixture-song-2",
      kind: "preset",
      artist: "Control Room",
      title: "No Repeat",
      coverUrl: "",
      audioUrl: "https://example.test/fixture-song-2.mp3",
      durationMs: 210_000,
    },
  ],
};

const consoleSongs: ProgramSongSequence = {
  ...playbackSequence,
  items: [
    ...playbackSequence.items,
    ...[
      "City Lights",
      "Late Summer",
      "Golden Hour",
      "After the Rain",
      "Midnight Signal",
      "Coastline",
      "Open Road",
      "Morning Blue",
      "Satellite",
      "Last Train",
    ].map((title, index) => ({
      id: `fixture-song-${index + 3}`,
      kind: "preset" as const,
      artist: ["North Avenue", "The Frequencies", "Studio Eight"][index % 3],
      title,
      audioUrl: `https://example.test/fixture-song-${index + 3}.mp3`,
      coverUrl: "",
      durationMs: 175_000 + index * 8_000,
      highRotation: index === 2,
    })),
  ],
};
const consoleInstants = [
  "Station ID",
  "News opener",
  "Weather bed",
  "Morning sting",
  "Sponsor tag",
  "Traffic intro",
  "Top of hour",
  "Music sweep",
].map((name, index) => ({
  id: index + 1,
  name,
  audioUrl: `https://example.test/clip-${index + 1}.mp3`,
  volume: 1,
  enabled: index !== 5,
  position: index,
}));

export default function ConsoleFixture() {
  const [params] = useSearchParams();
  const fixture = params.get("state") || "normal";
  const mode = params.get("mode") || "tv";
  const [workspace, setWorkspace] = useState<ConsoleWorkspace>(
    fixture.startsWith("audio")
      ? "audio"
      : fixture === "remote"
        ? "compact"
        : "director",
  );
  const [transition, setTransition] = useState("crescendo-prism");
  const [staged, setStaged] = useState<Scene | null>(
    fixture === "empty-preview"
      ? null
      : fixture === "on-air"
        ? programScene
        : previewScene,
  );
  const [ftb, setFtb] = useState(fixture === "ftb");
  const [onAirScene, setOnAirScene] = useState<Scene | null>(programScene);
  const takeFixtureScene = () => {
    if (!staged || fixture === "take-failed") return;
    setOnAirScene(staged);
    setStaged(onAirScene);
  };
  const [songs, setSongs] = useState(
    fixture.startsWith("radio-") || fixture.startsWith("audio")
      ? fixture === "radio-empty" || fixture === "audio-empty"
        ? { ...consoleSongs, items: [], activeItemId: null }
        : consoleSongs
      : playbackSequence,
  );
  const [cartSearch, setCartSearch] = useState("");
  const [cartPlayback, setCartPlayback] = useState<
    Record<number, { startedAtMs: number; endsAtMs: number | null }>
  >({});
  const [fixtureMixer, setFixtureMixer] = useState({
    song: {
      volume: 0.75,
      peak: fixture === "radio-empty" ? 0 : 0.3,
      muted: false,
    },
    instants: { volume: 0.8, peak: 0, muted: false },
    main: { volume: 0.9, peak: fixture === "radio-empty" ? 0 : 0.4 },
  });
  const [audioFadeMs, setAudioFadeMs] = useState(5000);
  const [audioChannels, setAudioChannels] = useState<TvAudioChannel[]>(
    (["song", "stream", "instants", "sceneInstant", "main"] as const).map(
      (id, index) => ({
        id,
        label: ["Music", "Stream", "Cartwall", "Scene audio", "Main mix"][
          index
        ],
        volume: index === 4 ? 1 : 0.8,
        muted: false,
        solo: false,
        ...(id === "stream"
          ? {}
          : {
              meter: {
                fill: index === 0 || index === 4 ? 0.45 : 0,
                peak: index === 0 || index === 4 ? 0.6 : 0,
                hold: 0.7,
              },
            }),
        ...(id === "main" ? {} : { presets: { aDb: -15, bDb: -30 } }),
        onVolumeChange: () => {},
      }),
    ),
  );
  const updateAudioChannel = (
    id: TvAudioChannel["id"],
    patch: Partial<TvAudioChannel>,
  ) =>
    setAudioChannels((current) =>
      current.map((channel) =>
        channel.id === id ? { ...channel, ...patch } : channel,
      ),
    );
  const interactiveAudioChannels = audioChannels.map((channel) => ({
    ...channel,
    onVolumeChange: (volume: number) =>
      updateAudioChannel(channel.id, { volume }),
    ...(channel.id === "main"
      ? {}
      : {
          onToggleMuted: () =>
            updateAudioChannel(channel.id, { muted: !channel.muted }),
          onToggleSolo: () =>
            updateAudioChannel(channel.id, { solo: !channel.solo }),
          onCommitPreset: (side: "a" | "b", raw: string) => {
            const key = side === "a" ? "aDb" : "bDb";
            const db = normalizeTakeVolumePresetDb(
              Number(raw),
              channel.presets![key],
            );
            updateAudioChannel(channel.id, {
              presets: { ...channel.presets!, [key]: db },
            });
            return db;
          },
          onTake: (side: "a" | "b") =>
            updateAudioChannel(channel.id, {
              volume: dbToFader(channel.presets![side === "a" ? "aDb" : "bDb"]),
            }),
        }),
  }));
  const [playbackOnAir, setPlaybackOnAir] = useState(true);
  const [songQueue, setSongQueue] = useState<ProgramSongQueueEntry[]>(
    fixture === "radio-empty"
      ? []
      : [
          { id: "fixture-queue-1", itemId: "fixture-song-2", enqueuedAt: 1 },
          { id: "fixture-queue-2", itemId: "fixture-song-1", enqueuedAt: 2 },
        ],
  );
  const isPlaybackFixture =
    fixture === "playback-live" || fixture === "playback-stale";

  if (fixture === "rundown-fillers")
    return (
      <main
        data-visual-fixture="rundown-fillers"
        className="broadcast-console bg-dark-sand p-6 text-text-primary"
      >
        <h1 className="mb-4 text-3xl font-semibold">Rundown</h1>
        <div className="max-w-md">
          <RundownFillers
            programId="radio-demo"
            rundown={{
              id: 1,
              name: "Fixture hour",
              revision: 1,
              items: [],
              scheduledAt: new Date().toISOString(),
              publishedAt: null,
              lastStartedAt: null,
              isRunning: false,
              loop: false,
              activeItemId: null,
              createdAt: "",
              updatedAt: "",
            }}
            items={[
              {
                id: "block",
                kind: "playSong",
                songId: 1,
                clockOffsetSeconds: 0,
              },
            ]}
            onFilled={() => undefined}
            fixtureLabels={[{ id: "fixture-music", name: "Music rotation" }]}
          />
        </div>
      </main>
    );
  if (fixture === "button-help")
    return (
      <main
        className="broadcast-console min-h-screen p-8"
        data-visual-fixture="button-help"
      >
        <h1 className="mb-2 text-xl font-semibold">Button help</h1>
        <p className="mb-8 text-sm text-text-secondary">
          Hover or focus a control. Escape closes its Bleecker tooltip.
        </p>
        <div className="flex flex-wrap gap-4">
          <Button title="Choose songs from the Media library for this playlist">
            Add songs
          </Button>
          <IconButton aria-label="Open Media library">
            <span aria-hidden="true">＋</span>
          </IconButton>
          <TooltipButton
            className="rounded border border-sand/30 px-4"
            disabled
            title="Stage a scene before TAKE"
          >
            TAKE
          </TooltipButton>
        </div>
      </main>
    );
  if (fixture === "rundown-desk") return <RundownFixture />;
  if (fixture === "loading") return <AppLoading />;
  if (fixture === "hidden-component") return <ScenePreparationFixture />;

  return (
    <main
      className={`broadcast-console h-full min-h-0 ${workspace === "audio" ? "flex flex-col overflow-y-auto" : ""}`}
      data-visual-fixture={fixture}
    >
      {mode === "both" ? <SimulcastStatusRail programId="fixture" /> : null}
      {fixture === "high-rotation" ? (
        <section className="flex min-h-screen items-center justify-center bg-dark-sand px-6 py-12 text-text-primary">
          <div className="h-[32rem] w-full max-w-3xl overflow-hidden rounded-xl border border-sand/30">
            <ProgramSongSequenceEditor
              sequence={songs}
              view="queue"
              onChange={setSongs}
            />
          </div>
        </section>
      ) : fixture.startsWith("radio-") ? (
        <div className="flex h-full min-h-0">
          <RadioPanel
            programId="fixture"
            fixtureData={{
              stream: { running: fixture !== "radio-offline", uptime: 180_000 },
              palazzo: {
                programId: "fixture",
                programType: "radio",
                palazzoUrl: "http://palazzo:3100",
                instanceId: "fixture",
                connection:
                  fixture === "radio-offline" ? "unavailable" : "connected",
                lastEventAt: new Date().toISOString(),
                lastSnapshotAt: new Date().toISOString(),
                degraded: false,
                detail: null,
              },
              output: {
                state:
                  fixture === "radio-offline"
                    ? "unavailable"
                    : fixture === "radio-empty"
                      ? "idle"
                      : "audible",
                expectedAudio: fixture !== "radio-empty",
                outputRms: fixture === "radio-empty" ? 0 : 0.08,
                lastSampleAt: new Date().toISOString(),
                quietForMs: null,
              },
              recovery: {
                preparedVersion: "fixture-filler",
                connection: "connected",
                automation: {
                  actualState: "ready",
                  filler: { activeVersion: "fixture-filler", ready: true },
                },
              },
              logs:
                fixture === "radio-empty" || fixture === "radio-continuous"
                  ? []
                  : [
                      {
                        id: 1,
                        name: "Evening session",
                        items: consoleSongs.items.map((song, index) => ({
                          id: `fixture-cue-${index + 1}`,
                          kind: "playSong" as const,
                          songId: index + 1,
                          isFiller: index > 0 && index < 6,
                          ...(index === 0 || index === 6
                            ? { clockOffsetSeconds: index * 240 }
                            : {}),
                        })),
                        loop: false,
                        isRunning: true,
                        activeItemId: "fixture-cue-1",
                        scheduledAt: new Date().toISOString(),
                        publishedAt: new Date().toISOString(),
                        lastStartedAt: new Date().toISOString(),
                        revision: 2,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                      },
                    ],
            }}
            songSequence={songs}
            songQueue={songQueue}
            songCatalog={consoleSongs.items
              .filter((item) => item.kind === "preset")
              .map((song, index) => ({
                id: index + 1,
                title: song.title,
                artist: song.artist,
                audioUrl: song.audioUrl!,
                coverUrl: null,
                durationMs: song.durationMs ?? null,
                earoneSongId: null,
                earoneRank: null,
                earoneSpins: null,
                enabled: true,
              }))}
            programSongPlayback={
              playbackOnAir && fixture !== "radio-empty"
                ? {
                    token:
                      fixture === "radio-external"
                        ? "external:playback"
                        : "fixture-song-1:playback",
                    audioUrl:
                      fixture === "radio-external"
                        ? "https://example.test/external.mp3"
                        : "https://example.test/fixture-song-1.mp3",
                    title:
                      fixture === "radio-external"
                        ? "External live track"
                        : "Authoritative Feedback",
                    artist:
                      fixture === "radio-external"
                        ? "External artist"
                        : "The Test Signals",
                    progress: 0.23,
                    currentTimeMs: 42_000,
                    durationMs: 180_000,
                    isPlaying: true,
                    updatedAt: new Date().toISOString(),
                    telemetryStale: fixture === "radio-stale",
                  }
                : null
            }
            onSaveSongSequence={setSongs}
            onQueueSong={async (itemId) =>
              setSongQueue((current) => [
                ...current,
                {
                  id: `fixture-queue-${Date.now()}`,
                  itemId,
                  enqueuedAt: Date.now(),
                },
              ])
            }
            onRemoveQueuedSong={async (id) =>
              setSongQueue((current) =>
                current.filter((entry) => entry.id !== id),
              )
            }
            onReorderSongQueue={async (ids) =>
              setSongQueue((current) =>
                ids.map((id) => current.find((entry) => entry.id === id)!),
              )
            }
            onTakeOffAir={async () => setPlaybackOnAir(false)}
            instants={fixture === "radio-empty" ? [] : consoleInstants}
            instantSearch={cartSearch}
            onInstantSearchChange={setCartSearch}
            onTriggerInstant={(id) =>
              setCartPlayback((current) => ({
                ...current,
                [id]: { startedAtMs: Date.now(), endsAtMs: null },
              }))
            }
            onStopAllInstants={() => setCartPlayback({})}
            instantPlayback={cartPlayback}
            mixer={{ ...fixtureMixer, saving: false, error: null }}
            onSongVolumeChange={(volume) =>
              setFixtureMixer((current) => ({
                ...current,
                song: { ...current.song, volume },
              }))
            }
            onInstantVolumeChange={(volume) =>
              setFixtureMixer((current) => ({
                ...current,
                instants: { ...current.instants, volume },
              }))
            }
            onMainVolumeChange={(volume) =>
              setFixtureMixer((current) => ({
                ...current,
                main: { ...current.main, volume },
              }))
            }
            onToggleSongMuted={() =>
              setFixtureMixer((current) => ({
                ...current,
                song: { ...current.song, muted: !current.song.muted },
              }))
            }
            onToggleInstantMuted={() =>
              setFixtureMixer((current) => ({
                ...current,
                instants: {
                  ...current.instants,
                  muted: !current.instants.muted,
                },
              }))
            }
          />
        </div>
      ) : fixture === "play-next" ? (
        <section className="flex min-h-screen items-center justify-center bg-dark-sand px-6 text-text-primary">
          <div className="w-full max-w-md overflow-hidden rounded-xl border border-sand/30">
            <PlayNextQueue
              queue={songQueue}
              sequence={songs}
              activeQueueEntryId="fixture-queue-1"
              onRemove={(entryId) =>
                setSongQueue((current) =>
                  current.filter((entry) => entry.id !== entryId),
                )
              }
              onReorder={(entryIds) =>
                setSongQueue((current) => {
                  const byId = new Map(
                    current.map((entry) => [entry.id, entry]),
                  );
                  return entryIds.flatMap((id) => {
                    const entry = byId.get(id);
                    return entry ? [entry] : [];
                  });
                })
              }
            />
          </div>
        </section>
      ) : isPlaybackFixture ? (
        <section className="flex min-h-screen items-center justify-center px-6 pb-24 text-center text-text-primary">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-sea">
              Playback control fixture
            </p>
            <h1 className="mt-2 text-2xl">Authoritative Radio feedback</h1>
          </div>
        </section>
      ) : (
        <BroadcastSwitcherDeck
          programId="fixture"
          activeScene={onAirScene}
          stagedScene={staged}
          scenes={[previewScene, programScene]}
          transitionId={transition}
          realtimeConnected={fixture !== "disconnected"}
          takeBusy={fixture === "taking"}
          takeError={
            fixture === "take-failed"
              ? "Scene save failed. Program has not changed."
              : null
          }
          fadeToBlack={ftb}
          workspace={workspace}
          onWorkspaceChange={setWorkspace}
          onTransitionChange={setTransition}
          onStageScene={(sceneId) =>
            setStaged(
              sceneId === previewScene.id
                ? previewScene
                : sceneId === programScene.id
                  ? programScene
                  : null,
            )
          }
          onTake={takeFixtureScene}
          onCut={takeFixtureScene}
          onFadeToBlack={() => setFtb((current) => !current)}
        />
      )}
      {workspace === "audio" &&
        !isPlaybackFixture &&
        !fixture.startsWith("radio-") && (
          <>
            <TvAudioWorkspace
              programId="fixture"
              activeScene={onAirScene}
              mixer={{
                channels: interactiveAudioChannels,
                fadeMs: audioFadeMs,
                onFadeChange: setAudioFadeMs,
                loading: fixture === "audio-loading",
                saving: false,
                error:
                  fixture === "audio-error"
                    ? "Mixer change was not applied to Palazzo. Try again."
                    : null,
              }}
              music={{
                sequence: songs,
                songCatalog: [],
                programSongPlayback: null,
                onChange: setSongs,
                onTakeSelection: (next) => {
                  setSongs(next);
                },
                onAddSongs: () => setSongs(consoleSongs),
              }}
              cartwall={{
                isLoading: false,
                instants: fixture === "audio-empty" ? [] : consoleInstants,
                search: cartSearch,
                onSearchChange: setCartSearch,
                playback: cartPlayback,
                onTrigger: (id) =>
                  setCartPlayback((current) => ({
                    ...current,
                    [id]: { startedAtMs: Date.now(), endsAtMs: null },
                  })),
                onStopAll: () => setCartPlayback({}),
              }}
              recording={
                <details className="console-recording">
                  <summary>Program recording</summary>
                  <p className="p-3 text-xs">
                    Recorder fixture · no external commands
                  </p>
                </details>
              }
            />
            <div className="tv-audio-transport">
              <PlaybackBar
                sequence={songs}
                programSongPlayback={null}
                onChange={setSongs}
                onTakeSelection={(next) => {
                  setSongs(next);
                }}
                onTakeOffAir={() =>
                  setSongs((current) => ({
                    ...current,
                    mode: "manual",
                    activeItemId: null,
                  }))
                }
                onStopAllInstants={() => setCartPlayback({})}
              />
            </div>
          </>
        )}
      {isPlaybackFixture ? (
        <div className="fixed inset-x-0 bottom-0 z-50">
          <PlaybackBar
            sequence={songs}
            programSongPlayback={
              playbackOnAir
                ? {
                    token: `${songs.activeItemId}:https://example.test/fixture-song-1.mp3`,
                    audioUrl: "https://example.test/fixture-song-1.mp3",
                    title: "Authoritative Feedback",
                    artist: "The Test Signals",
                    progress: 0.23,
                    currentTimeMs: 42_000,
                    durationMs: 180_000,
                    isPlaying: true,
                    updatedAt: new Date().toISOString(),
                    telemetryStale: fixture === "playback-stale",
                  }
                : null
            }
            onChange={setSongs}
            onTakeSelection={(next) => {
              setSongs(next);
              setPlaybackOnAir(true);
            }}
            onTakeOffAir={() => {
              setPlaybackOnAir(false);
              setSongs((current) => ({
                ...current,
                mode: "manual",
                activeItemId: null,
              }));
            }}
            onStopAllInstants={() => undefined}
          />
        </div>
      ) : null}
    </main>
  );
}
