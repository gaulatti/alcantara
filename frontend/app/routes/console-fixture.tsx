import { useState } from "react";
import { useSearchParams } from "react-router";
import {
  BroadcastSwitcherDeck,
  type ConsoleWorkspace,
} from "../components/BroadcastSwitcherDeck";
import type { Scene } from "../models/broadcast";
import { SimulcastStatusRail } from "../components/SimulcastStatusRail";
import { PlaybackBar } from "../components/PlaybackBar";
import type { ProgramSongSequence } from "../utils/programSequence";

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

export default function ConsoleFixture() {
  const [params] = useSearchParams();
  const fixture = params.get("state") || "normal";
  const mode = params.get("mode") || "tv";
  const [workspace, setWorkspace] = useState<ConsoleWorkspace>(
    fixture === "audio"
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
  const [songs, setSongs] = useState(playbackSequence);
  const [playbackOnAir, setPlaybackOnAir] = useState(true);
  const isPlaybackFixture =
    fixture === "playback-live" || fixture === "playback-stale";

  return (
    <main className="min-h-screen bg-zinc-950" data-visual-fixture={fixture}>
      {mode === "both" ? <SimulcastStatusRail programId="fixture" /> : null}
      {isPlaybackFixture ? (
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
          activeScene={programScene}
          stagedScene={staged}
          scenes={[previewScene, programScene]}
          transitionId={transition}
          realtimeConnected={fixture !== "disconnected"}
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
          onTake={() => undefined}
          onCut={() => undefined}
          onFadeToBlack={() => setFtb((current) => !current)}
        />
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
