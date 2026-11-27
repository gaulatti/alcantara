import { useState } from "react";
import { SceneAttributesPanel } from "./panels/SceneAttributesPanel";
import type { Scene } from "../models/broadcast";

const type = "modoitaliano-giorgia-podcast-player";
export function ScenePreparationFixture({
  clock = false,
  error = false,
  saving = false,
  timezone = false,
}: {
  clock?: boolean;
  error?: boolean;
  saving?: boolean;
  /** A clock widget saved with a zone the browser lists under an alias. */
  timezone?: boolean;
}) {
  const [player, setPlayer] = useState({
    show: false,
    episodeTitle: "Local rehearsal",
    showName: "Giorgia",
    audioUrl: "",
    coverUrl: "",
  });
  const [clockProps, setClockProps] = useState({
    showWorldClocks: true,
    showLogo: true,
    showPlaybackProgress: false,
  });
  const [clockWidget, setClockWidget] = useState({ timezone: "Asia/Kolkata" });
  const [slideshow, setSlideshow] = useState({
    intervalMs: 5000,
    transitionMs: 900,
    labelId: "fixture-images",
    shuffle: false,
    kenBurns: true,
  });
  const name = timezone
    ? "World clock"
    : clock
      ? "Studio clock"
      : "Giorgia player";
  return (
    <section className="broadcast-console min-h-screen bg-dark-sand p-4 text-text-primary">
      <SceneAttributesPanel
        selectedScene={1}
        scenes={[{ id: 1, name } as Scene]}
        stagedIsOnAir={clock}
        isSavingSceneAttributes={saving}
        sceneAttributeSaveError={
          error ? "Changes could not be saved. Retry Save changes." : null
        }
        editableSceneComponentEntries={
          timezone
            ? [["clock-widget", clockWidget]]
            : clock
              ? [
                  ["modoitaliano-giorgia-clock", clockProps],
                  ["slideshow", slideshow],
                  [type, player],
                ]
              : [[type, player]]
        }
        componentTypes={[
          { type, name: "Giorgia player", description: "" },
          {
            type: "modoitaliano-giorgia-clock",
            name: "Modo Italiano Giorgia Clock",
            description: "",
          },
          { type: "slideshow", name: "Slideshow", description: "" },
          { type: "clock-widget", name: "Clock Widget", description: "" },
        ]}
        sceneEditorProps={{ [type]: player }}
        selectedSceneInstantId={null}
        selectedBackgroundAudioAssetId={null}
        selectedBackgroundAudioAsset={null}
        sceneInstantPlayback={{ isPlaying: false } as any}
        activeProgramId="fixture"
        backgroundAudioAssets={[]}
        isLoadingBackgroundAudio={false}
        songCatalog={[]}
        mediaGroups={[]}
        isLoadingMediaGroups={false}
        mediaLabels={[
          { id: "fixture-images", name: "Studio stills", assets: [] } as any,
        ]}
        isLoadingMediaLabels={false}
        onBlurCapture={() => undefined}
        onSave={() => undefined}
        onCommitComponentProps={async () => undefined}
        onUpdateProp={(component, key, value) => {
          const update =
            component === "clock-widget"
              ? setClockWidget
              : component === "modoitaliano-giorgia-clock"
                ? setClockProps
                : component === "slideshow"
                  ? setSlideshow
                  : setPlayer;
          update((current: any) => ({ ...current, [key]: value }));
        }}
        onReplaceProps={(_, next) => setPlayer(next)}
        onSyncComponentProps={(_, next) => setPlayer(next)}
        onTakeSceneInstant={async () => undefined}
        onStopSceneInstant={async () => undefined}
      />
    </section>
  );
}
