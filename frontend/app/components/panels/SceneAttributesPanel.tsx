import { Button, Select, Tabs } from '@gaulatti/bleecker';
import { useEffect, useMemo, useState } from 'react';
import type { InstantItem, MediaGroup, Scene, SceneInstantPlaybackState, SongCatalogItem } from '../../models/broadcast';
import { normalizeSceneInstantId } from '../../utils/broadcast';
import { ComponentPropsFields, ZIndexField } from '../editors';

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
  selectedSceneInstant: InstantItem | null | undefined;
  sceneInstantPlayback: SceneInstantPlaybackState;
  activeProgramId: string;
  instants: InstantItem[];
  songCatalog: SongCatalogItem[];
  mediaGroups: MediaGroup[];
  isLoadingMediaGroups: boolean;
  onBlurCapture: (event: React.FocusEvent<HTMLDivElement>) => void;
  onSave: () => void;
  onCommitComponentProps: (componentType: string, props: any) => Promise<void>;
  onUpdateProp: (componentType: string, propName: string, value: any) => void;
  onReplaceProps: (componentType: string, newProps: any) => void;
  onTakeSceneInstant: (sceneId: number | null, instantId: number | null) => Promise<void>;
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
  selectedSceneInstant,
  sceneInstantPlayback,
  activeProgramId,
  instants,
  songCatalog,
  mediaGroups,
  isLoadingMediaGroups,
  onBlurCapture,
  onSave,
  onCommitComponentProps,
  onUpdateProp,
  onReplaceProps,
  onTakeSceneInstant,
  onStopSceneInstant
}: SceneAttributesPanelProps) {
  const [activeAttributeTab, setActiveAttributeTab] = useState<string>('');

  const attributeTabs = useMemo(
    () => [
      { id: '__scene', label: 'Scene' },
      ...editableSceneComponentEntries.map(([componentType]) => {
        const compInfo = componentTypes.find((ct) => ct.type === componentType);
        return {
          id: componentType,
          label: compInfo?.name || componentType
        };
      })
    ],
    [componentTypes, editableSceneComponentEntries]
  );

  useEffect(() => {
    const hasActive = attributeTabs.some((tab) => tab.id === activeAttributeTab);
    if (!hasActive) {
      setActiveAttributeTab(attributeTabs[0]?.id ?? '');
    }
  }, [activeAttributeTab, attributeTabs]);

  const activeComponentEntry = useMemo(() => {
    if (activeAttributeTab === '__scene' || editableSceneComponentEntries.length === 0) {
      return null;
    }

    const fallback = editableSceneComponentEntries[0];
    return editableSceneComponentEntries.find(([componentType]) => componentType === activeAttributeTab) ?? fallback;
  }, [activeAttributeTab, editableSceneComponentEntries]);

  if (!selectedScene) {
    return <p className='text-sm text-text-secondary dark:text-text-secondary'>Stage a scene above to edit its attributes before taking it live.</p>;
  }

  return (
    <div className='flex h-full min-h-0 flex-col overflow-hidden' onBlurCapture={onBlurCapture}>
      <div className='shrink-0 border-b border-sand/20 pb-2 dark:border-sand/40'>
        <Tabs tabs={attributeTabs} activeTab={activeAttributeTab} onChange={(id) => setActiveAttributeTab(id)} className='overflow-x-auto' />
      </div>

      <div className='flex-1 min-h-0 overflow-y-auto py-3'>
        <div className='space-y-3 rounded-xl border border-sand/20 p-4 dark:border-sand/40'>
          {activeProgramId === 'fifthbell' && (
            <p className='text-xs text-text-secondary dark:text-text-secondary'>
              FifthBell runtime settings are stored per component metadata (`fifthbell-content`, `fifthbell-marquee`, `fifthbell-clock` / `toni-clock`).
            </p>
          )}

          {activeAttributeTab === '__scene' ? (
            <div className='space-y-3'>
              <div className='flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between'>
                <div className='flex-1'>
                  <label className='mb-1 block text-xs text-text-secondary'>Scene Background Instant</label>
                  <Select
                    value={selectedSceneInstantId ? String(selectedSceneInstantId) : ''}
                    onChange={(value) => {
                      const nextInstantId = normalizeSceneInstantId(value);
                      const currentSceneInstantProps =
                        sceneEditorProps?.sceneInstant && typeof sceneEditorProps.sceneInstant === 'object' ? sceneEditorProps.sceneInstant : {};
                      void onCommitComponentProps('sceneInstant', {
                        ...currentSceneInstantProps,
                        instantId: nextInstantId
                      });
                    }}
                    className='w-full rounded border border-sand/40 px-3 py-2 text-sm focus:ring-2 focus:ring-sea/50'
                    options={[
                      { value: '', label: 'No background instant' },
                      ...instants
                        .filter((instant) => instant.enabled)
                        .map((instant) => ({
                          value: String(instant.id),
                          label: instant.name
                        }))
                    ]}
                  />
                </div>
                <div className='flex flex-wrap gap-2'>
                  <Button
                    size='sm'
                    onClick={() => onTakeSceneInstant(selectedScene, selectedSceneInstantId)}
                    disabled={!selectedScene || selectedSceneInstantId === null || !selectedSceneInstant}
                  >
                    TAKE BG
                  </Button>
                  <Button size='sm' variant='secondary' onClick={() => onStopSceneInstant()} disabled={!sceneInstantPlayback.isPlaying}>
                    STOP BG
                  </Button>
                </div>
              </div>
              <p className='text-xs text-text-secondary dark:text-text-secondary'>
                {sceneInstantPlayback.isPlaying
                  ? `Playing: ${sceneInstantPlayback.instantName || 'Scene instant'}`
                  : selectedSceneInstant
                    ? `Ready: ${selectedSceneInstant.name}`
                    : 'Select an instant, then press SAVE (or TAKE BG).'}
              </p>
            </div>
          ) : activeComponentEntry ? (
            <div>
              <h4 className='mb-2 text-md font-semibold text-text-primary dark:text-text-primary'>
                {attributeTabs.find((tab) => tab.id === activeComponentEntry[0])?.label || activeComponentEntry[0]}
              </h4>
              <ComponentPropsFields
                componentType={activeComponentEntry[0]}
                props={activeComponentEntry[1]}
                updateProp={onUpdateProp}
                replaceProps={onReplaceProps}
                commitProps={onCommitComponentProps}
                songCatalog={songCatalog}
                mediaGroups={mediaGroups}
                isLoadingMediaGroups={isLoadingMediaGroups}
                scenes={scenes}
                programId={activeProgramId}
              />
              <ZIndexField componentType={activeComponentEntry[0]} props={activeComponentEntry[1]} updateProp={onUpdateProp} />
            </div>
          ) : (
            <p className='text-sm text-text-secondary dark:text-text-secondary'>No configurable component attributes for this scene.</p>
          )}
        </div>
      </div>

      <div className='shrink-0 border-t border-sand/20 pt-3 dark:border-sand/40'>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          {isSavingSceneAttributes ? (
            <p className='text-xs text-text-secondary dark:text-text-secondary'>Autosaving scene attributes…</p>
          ) : sceneAttributeSaveError ? (
            <p className='text-xs text-terracotta'>{sceneAttributeSaveError}</p>
          ) : (
            <span />
          )}
          <Button size='sm' variant='secondary' onClick={() => onSave()} disabled={!selectedScene || isSavingSceneAttributes}>
            {isSavingSceneAttributes ? 'SAVING…' : 'SAVE'}
          </Button>
        </div>
      </div>
    </div>
  );
}
