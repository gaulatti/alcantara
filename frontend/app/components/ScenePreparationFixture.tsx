import { useState } from "react";
import { SceneAttributesPanel } from "./panels/SceneAttributesPanel";

const type = "modoitaliano-giorgia-podcast-player";
export function ScenePreparationFixture() {
  const [player, setPlayer] = useState({
    show: false,
    episodeTitle: "Local rehearsal",
    showName: "Giorgia",
    audioUrl: "",
    coverUrl: "",
  });
  return (
    <section className="mx-auto max-w-4xl bg-dark-sand p-6 text-text-primary">
      <h1 className="mb-4 text-lg font-semibold">Prepare · Giorgia player</h1>
      <SceneAttributesPanel
        selectedScene={1}
        scenes={[]}
        stagedIsOnAir={false}
        isSavingSceneAttributes={false}
        sceneAttributeSaveError={null}
        editableSceneComponentEntries={[[type, player]]}
        componentTypes={[{ type, name: "Giorgia player", description: "" }]}
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
        mediaLabels={[]}
        isLoadingMediaLabels={false}
        onBlurCapture={() => undefined}
        onSave={() => undefined}
        onCommitComponentProps={async () => undefined}
        onUpdateProp={(_, key, value) =>
          setPlayer((current) => ({ ...current, [key]: value }))
        }
        onReplaceProps={(_, next) => setPlayer(next)}
        onSyncComponentProps={(_, next) => setPlayer(next)}
        onTakeSceneInstant={async () => undefined}
        onStopSceneInstant={async () => undefined}
      />
    </section>
  );
}
