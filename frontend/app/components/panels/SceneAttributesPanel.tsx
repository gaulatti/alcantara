import { Button, Card, Select, Tabs } from "@gaulatti/bleecker";
import { Button as HelpButton } from "../BleeckerButtons";
import { useFeatures } from "../../hooks/useFeatures";
import { useEffect, useId, useMemo, useState } from "react";
import type {
  BackgroundAudioAsset,
  MediaGroup,
  MediaLabel,
  Scene,
  SceneInstantPlaybackState,
  SongCatalogItem,
} from "../../models/broadcast";
import { ComponentPropsFields, ZIndexField } from "../editors";

interface SceneAttributesPanelProps {
  selectedScene: number | null;
  scenes: Scene[];
  stagedIsOnAir: boolean;
  isSavingSceneAttributes: boolean;
  sceneAttributeSaveError: string | null;
  editableSceneComponentEntries: [string, any][];
  componentTypes: { type: string; name: string; description: string }[];
  sceneEditorProps: Record<string, any>;
  selectedSceneInstantId: number | null;
  selectedBackgroundAudioAssetId: string | null;
  selectedBackgroundAudioAsset: BackgroundAudioAsset | null;
  sceneInstantPlayback: SceneInstantPlaybackState;
  activeProgramId: string;
  backgroundAudioAssets: BackgroundAudioAsset[];
  isLoadingBackgroundAudio: boolean;
  songCatalog: SongCatalogItem[];
  mediaGroups: MediaGroup[];
  isLoadingMediaGroups: boolean;
  mediaLabels: MediaLabel[];
  isLoadingMediaLabels: boolean;
  onBlurCapture: (event: React.FocusEvent<HTMLDivElement>) => void;
  onSave: () => void;
  onCommitComponentProps: (componentType: string, props: any) => Promise<void>;
  onUpdateProp: (componentType: string, propName: string, value: any) => void;
  onReplaceProps: (componentType: string, newProps: any) => void;
  onSyncComponentProps: (componentType: string, newProps: any) => void;
  onTakeSceneInstant: (
    sceneId: number | null,
    instantId: number | null,
    mediaAssetId: string | null,
  ) => Promise<void>;
  onStopSceneInstant: () => Promise<void>;
}

export function SceneAttributesPanel({
  selectedScene,
  scenes,
  stagedIsOnAir,
  isSavingSceneAttributes,
  sceneAttributeSaveError,
  editableSceneComponentEntries,
  componentTypes,
  sceneEditorProps,
  selectedSceneInstantId,
  selectedBackgroundAudioAssetId,
  selectedBackgroundAudioAsset,
  sceneInstantPlayback,
  activeProgramId,
  backgroundAudioAssets,
  isLoadingBackgroundAudio,
  songCatalog,
  mediaGroups,
  isLoadingMediaGroups,
  mediaLabels,
  isLoadingMediaLabels,
  onBlurCapture,
  onSave,
  onCommitComponentProps,
  onUpdateProp,
  onReplaceProps,
  onSyncComponentProps,
  onTakeSceneInstant,
  onStopSceneInstant,
}: SceneAttributesPanelProps) {
  const panelId = useId();
  const { loading: featuresLoading, hasPermission } = useFeatures();
  const viewOnly = featuresLoading === false && !hasPermission("alcantara:program:operate");
  const viewOnlyHelp = viewOnly ? { title: "Your account can view this show but not take it." } : {};
  const [activeAttributeTab, setActiveAttributeTab] = useState<string>("");

  const sceneTab = useMemo(
    () => ({ id: "__scene", label: "Background audio", panelId }),
    [panelId],
  );
  const componentTabs = useMemo(
    () =>
      editableSceneComponentEntries.map(([componentType]) => {
        const compInfo = componentTypes.find((ct) => ct.type === componentType);
        return {
          id: componentType,
          label: compInfo?.name || componentType,
          panelId,
        };
      }),
    [componentTypes, editableSceneComponentEntries, panelId],
  );
  const attributeTabs = useMemo(
    () => [...componentTabs, sceneTab],
    [componentTabs, sceneTab],
  );

  useEffect(() => {
    const hasActive = attributeTabs.some(
      (tab) => tab.id === activeAttributeTab,
    );
    if (!hasActive) {
      setActiveAttributeTab(componentTabs[0]?.id ?? sceneTab.id);
    }
  }, [activeAttributeTab, attributeTabs, componentTabs, sceneTab.id]);

  const componentTabKey = editableSceneComponentEntries
    .map(([type]) => type)
    .join(",");
  useEffect(() => {
    setActiveAttributeTab(editableSceneComponentEntries[0]?.[0] ?? "__scene");
  }, [selectedScene, componentTabKey]);

  const activeComponentEntry = useMemo(() => {
    if (
      activeAttributeTab === "__scene" ||
      editableSceneComponentEntries.length === 0
    ) {
      return null;
    }

    const fallback = editableSceneComponentEntries[0];
    return (
      editableSceneComponentEntries.find(
        ([componentType]) => componentType === activeAttributeTab,
      ) ?? fallback
    );
  }, [activeAttributeTab, editableSceneComponentEntries]);

  if (!selectedScene) {
    return (
      <Card className="scene-preparation-empty">
        <h2 className="text-base font-semibold">Prepare the next scene</h2>
      </Card>
    );
  }

  return (
    <Card
      padding="none"
      className="console-scene-editor"
      onBlurCapture={onBlurCapture}
    >
      <header className="scene-preparation-heading">
        <h2>
          Prepare ·{" "}
          {scenes.find((scene) => scene.id === selectedScene)?.name ??
            "Selected scene"}
        </h2>
      </header>
      {stagedIsOnAir && (
        <p className="scene-preparation-notice rounded-[var(--radius-button)] border border-accent-yellow/40 bg-accent-yellow/10 px-3 py-2 text-xs text-accent-yellow">
          This scene is on Program. Saved changes appear live.
        </p>
      )}
      {editableSceneComponentEntries
        .filter(
          ([type, props]) =>
            type === activeComponentEntry?.[0] && props.show === false,
        )
        .map(([componentType]) => (
          <div
            key={componentType}
            role="status"
            className="scene-preparation-notice flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-button)] border border-accent-yellow/40 bg-accent-yellow/10 px-3 py-2 text-sm"
          >
            <span>
              {componentTypes.find(
                (component) => component.type === componentType,
              )?.name ?? componentType}{" "}
              is hidden.
            </span>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => onUpdateProp(componentType, "show", true)}
            >
              Show component
            </Button>
          </div>
        ))}
      {/* A single section needs no tab: its name sits beside its control. */}
      {componentTabs.length > 0 && (
        <div className="scene-preparation-tabs">
          <Tabs
            aria-label="Scene components"
            tabs={attributeTabs}
            size="sm"
            variant="enclosed"
            activeTab={activeAttributeTab}
            onChange={(id) => setActiveAttributeTab(id)}
            className="overflow-x-auto"
          />
        </div>
      )}

      <div
        className="scene-preparation-scroll"
        role="tabpanel"
        id={panelId}
        aria-label={
          attributeTabs.find((tab) => tab.id === activeAttributeTab)?.label
        }
      >
        <div className="console-props-body">
          {activeAttributeTab === "__scene" ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="switcher-leg">TV</span>
                {componentTabs.length === 0 ? (
                  <span className="rounded-[var(--radius-button)] border border-sand/30 px-2 py-1 text-sm">
                    Background audio
                  </span>
                ) : null}
                <div className="min-w-0 flex-1 basis-40">
                    <Select
                      aria-label="Audio clip"
                      value={selectedBackgroundAudioAssetId ?? ""}
                      onChange={(value) => {
                        const nextAssetId = value.trim() || null;
                        const currentSceneInstantProps =
                          sceneEditorProps?.sceneInstant &&
                          typeof sceneEditorProps.sceneInstant === "object"
                            ? sceneEditorProps.sceneInstant
                            : {};
                        void onCommitComponentProps("sceneInstant", {
                          ...currentSceneInstantProps,
                          assetId: nextAssetId,
                          instantId: null,
                        });
                      }}
                      options={[
                        { value: "", label: "No background audio" },
                        ...backgroundAudioAssets
                          .filter((asset) => asset.enabled)
                          .map((asset) => ({
                            value: asset.id,
                            label: asset.name,
                          })),
                      ]}
                    />
                  {isLoadingBackgroundAudio ? (
                    <p className="mt-1 text-xs text-text-secondary">
                      Loading background audio…
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <HelpButton
                    size="sm"
                    onClick={() =>
                      onTakeSceneInstant(
                        selectedScene,
                        selectedSceneInstantId,
                        selectedBackgroundAudioAssetId,
                      )
                    }
                    disabled={viewOnly || !selectedScene || !selectedBackgroundAudioAsset}
                    {...viewOnlyHelp}
                  >
                    TAKE BG
                  </HelpButton>
                  <HelpButton
                    size="sm"
                    variant="secondary"
                    onClick={() => onStopSceneInstant()}
                    disabled={viewOnly || !sceneInstantPlayback.isPlaying}
                    {...viewOnlyHelp}
                  >
                    STOP BG
                  </HelpButton>
                </div>
              </div>
              {sceneInstantPlayback.isPlaying ? (
                <p className="text-xs text-text-secondary dark:text-text-secondary">
                  Playing: {sceneInstantPlayback.instantName || "Scene instant"}
                </p>
              ) : null}
            </div>
          ) : activeComponentEntry ? (
            <div>
              <ComponentPropsFields
                componentType={activeComponentEntry[0]}
                props={activeComponentEntry[1]}
                updateProp={onUpdateProp}
                replaceProps={onReplaceProps}
                commitProps={onCommitComponentProps}
                syncProps={onSyncComponentProps}
                songCatalog={songCatalog}
                mediaGroups={mediaGroups}
                isLoadingMediaGroups={isLoadingMediaGroups}
                mediaLabels={mediaLabels}
                isLoadingMediaLabels={isLoadingMediaLabels}
                scenes={scenes}
                programId={activeProgramId}
                sceneId={selectedScene}
              />
              <ZIndexField
                componentType={activeComponentEntry[0]}
                props={activeComponentEntry[1]}
                updateProp={onUpdateProp}
              />
            </div>
          ) : (
            <p className="text-sm text-text-secondary dark:text-text-secondary">
              No configurable component attributes for this scene.
            </p>
          )}
        </div>
      </div>

      <div className="scene-preparation-footer">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {isSavingSceneAttributes ? (
            <p className="text-xs text-text-secondary dark:text-text-secondary">
              Autosaving scene attributes…
            </p>
          ) : sceneAttributeSaveError ? (
            <p role="alert" className="text-xs text-terracotta">
              {sceneAttributeSaveError}
            </p>
          ) : (
            <span />
          )}
          <Button
            size="sm"
            variant="primary"
            onClick={() => onSave()}
            disabled={!selectedScene || isSavingSceneAttributes}
          >
            {isSavingSceneAttributes ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
