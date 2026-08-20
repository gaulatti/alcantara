import { useState } from "react";
import { useSearchParams } from "react-router";
import {
  BroadcastSwitcherDeck,
  type ConsoleWorkspace,
} from "../components/BroadcastSwitcherDeck";
import type { Scene } from "../models/broadcast";

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

export default function ConsoleFixture() {
  const [params] = useSearchParams();
  const fixture = params.get("state") || "normal";
  const [workspace, setWorkspace] = useState<ConsoleWorkspace>("director");
  const [transition, setTransition] = useState("crescendo-prism");
  const [staged, setStaged] = useState<Scene | null>(
    fixture === "empty-preview"
      ? null
      : fixture === "on-air"
        ? programScene
        : previewScene,
  );
  const [ftb, setFtb] = useState(fixture === "ftb");

  return (
    <main className="min-h-screen bg-zinc-950" data-visual-fixture={fixture}>
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
    </main>
  );
}
