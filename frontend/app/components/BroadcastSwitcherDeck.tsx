import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button, IconButton, Input } from "@gaulatti/bleecker";
import {
  Expand,
  Keyboard,
  MonitorPlay,
  Settings2,
  Smartphone,
  Wifi,
  WifiOff,
} from "lucide-react";
import type { Scene } from "../models/broadcast";
import { SCENE_TRANSITIONS } from "../utils/sceneTransitions";
import {
  useConsolePreferences,
  type ConsoleWorkspace,
} from "../contexts/ConsolePreferencesContext";
import { getApiBaseUrl } from "../utils/apiBaseUrl";
import { useFeatures } from "../hooks/useFeatures";
import { BroadcastAction } from "./BroadcastAction";

export type { ConsoleWorkspace } from "../contexts/ConsolePreferencesContext";

const WORKSPACES: Array<{ id: ConsoleWorkspace; label: string }> = [
  { id: "director", label: "Director" },
  { id: "audio", label: "Audio" },
  { id: "compact", label: "Remote" },
];

function blocksBroadcastShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, button, a, [contenteditable="true"], [role="button"], [role="slider"], [role="dialog"]',
    ),
  );
}

interface SharedLayout {
  id: string;
  name: string;
  description: string | null;
  sourceDeviceClass: string;
  version: number;
}

function ConsolePreferenceControls({ programId }: { programId: string }) {
  const preferences = useConsolePreferences();
  const { context } = useFeatures();
  const [open, setOpen] = useState(false);
  const [layouts, setLayouts] = useState<SharedLayout[]>([]);
  const [message, setMessage] = useState("");
  const [scope, setScope] = useState<"program" | "team">("program");
  const [layoutName, setLayoutName] = useState("");
  const teamId = context?.authorization?.teamId;
  const scopeId = scope === "program" ? programId : String(teamId ?? "");

  const refresh = async () => {
    if (!scopeId) {
      setLayouts([]);
      return;
    }
    const response = await fetch(
      `${getApiBaseUrl()}/operator-preferences/shared?scope=${scope}&scopeId=${encodeURIComponent(scopeId)}`,
    );
    if (!response.ok)
      throw new Error(`Console presets failed (${response.status})`);
    setLayouts((await response.json()) as SharedLayout[]);
  };

  useEffect(() => {
    if (!open) return;
    void refresh().catch((error: unknown) =>
      setMessage(
        error instanceof Error ? error.message : "Console presets unavailable",
      ),
    );
  }, [open, scope, scopeId]);

  const publish = async () => {
    const name = layoutName.trim();
    if (!name) return;
    const response = await fetch(
      `${getApiBaseUrl()}/operator-preferences/shared`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          scope,
          scopeId,
          sourceDeviceClass: preferences.deviceClass,
          profile: preferences.profile,
        }),
      },
    );
    if (!response.ok) {
      setMessage(
        response.status === 403
          ? "You do not have permission to publish console presets."
          : `Publish failed (${response.status})`,
      );
      return;
    }
    setMessage("Console preset published.");
    setLayoutName("");
    await refresh();
  };

  const load = async (layout: SharedLayout) => {
    const response = await fetch(
      `${getApiBaseUrl()}/operator-preferences/shared/${layout.id}/load`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceClass: preferences.deviceClass,
          version: preferences.version,
        }),
      },
    );
    if (!response.ok) {
      setMessage(
        response.status === 409
          ? "This preset targets another device class or your profile changed. Refresh and try again."
          : `Load failed (${response.status})`,
      );
      return;
    }
    const result = (await response.json()) as {
      preference: { version: number; profile: typeof preferences.profile };
    };
    preferences.adoptAcknowledged(
      result.preference.version,
      result.preference.profile,
    );
    setMessage(`Loaded ${layout.name}.`);
  };

  const retire = async (layout: SharedLayout) => {
    if (!window.confirm(`Retire the “${layout.name}” console preset?`)) return;
    const response = await fetch(
      `${getApiBaseUrl()}/operator-preferences/shared/${layout.id}`,
      { method: "DELETE" },
    );
    if (!response.ok) {
      setMessage(
        response.status === 403
          ? "You do not have permission to retire console presets."
          : `Retire failed (${response.status})`,
      );
      return;
    }
    setMessage(`Retired ${layout.name}.`);
    await refresh();
  };

  return (
    <div className="relative flex items-center gap-2">
      <span
        className={`rounded px-2 py-1 text-[10px] font-bold uppercase ${preferences.syncState === "synced" ? "bg-emerald-950 text-emerald-300" : preferences.syncState === "conflict" ? "bg-red-950 text-red-300" : "bg-amber-950 text-amber-300"}`}
      >
        {preferences.syncState}
      </span>
      <Button
        type="button"
        size="xs"
        variant="secondary"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {preferences.deviceClass} preferences
      </Button>
      {open ? (
        <div className="absolute right-0 top-10 z-50 max-h-[min(38rem,calc(100vh-5rem))] w-[min(24rem,calc(100vw-1rem))] space-y-4 overflow-y-auto rounded-[var(--radius-card)] border border-sand/30 bg-dark-sand p-4 shadow-[var(--shadow-overlay)]">
          <label className="block text-xs text-zinc-400">
            Device class override
            <select
              value={preferences.deviceClass}
              onChange={(event) =>
                preferences.setDeviceClassOverride(
                  event.target.value as "desktop" | "tablet" | "phone",
                )
              }
              className="mt-1 w-full rounded bg-zinc-900 p-2"
            >
              <option value="desktop">Desktop</option>
              <option value="tablet">Tablet</option>
              <option value="phone">Phone</option>
            </select>
          </label>
          <Button
            type="button"
            size="xs"
            variant="link"
            onClick={() => preferences.setDeviceClassOverride(null)}
          >
            Use detected {preferences.detectedDeviceClass}
          </Button>
          {preferences.conflict ? (
            <div className="rounded border border-red-800 p-2 text-xs">
              A newer profile exists.
              <div className="mt-2 flex gap-2">
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  onClick={preferences.useAuthoritative}
                >
                  Use server
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="destructive"
                  onClick={preferences.retryLocal}
                >
                  Retry mine
                </Button>
              </div>
            </div>
          ) : null}
          <div className="flex gap-2 text-xs">
            <Button
              type="button"
              size="xs"
              variant="secondary"
              onClick={() => void preferences.resetCurrent()}
            >
              Reset class
            </Button>
            <Button
              type="button"
              size="xs"
              variant="secondary"
              onClick={() => void preferences.resetAll()}
            >
              Reset all
            </Button>
          </div>
          <div className="border-t border-zinc-800 pt-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase text-zinc-400">
                Console presets
              </span>
            </div>
            <label className="mt-2 block text-xs text-zinc-400">
              Visibility
              <select
                value={scope}
                onChange={(event) => {
                  setScope(event.target.value as "program" | "team");
                  setMessage("");
                }}
                className="mt-1 w-full rounded bg-zinc-900 p-2"
              >
                <option value="program">This program</option>
                {teamId ? <option value="team">My team</option> : null}
              </select>
            </label>
            <div className="mt-2 flex gap-2">
              <input
                aria-label={`New ${scope} console preset name`}
                value={layoutName}
                onChange={(event) => setLayoutName(event.target.value)}
                placeholder="Preset name"
                className="min-w-0 flex-1 rounded bg-zinc-900 p-2 text-xs"
              />
              <Button
                type="button"
                size="xs"
                variant="primary"
                disabled={!layoutName.trim() || !scopeId}
                onClick={() => void publish()}
              >
                Publish
              </Button>
            </div>
            <div className="mt-2 space-y-1">
              {layouts.map((layout) => (
                <div
                  key={layout.id}
                  className="flex items-center gap-2 rounded bg-zinc-900 p-2 text-xs"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {layout.name} · v{layout.version} ·{" "}
                    {layout.sourceDeviceClass}
                  </span>
                  <Button
                    type="button"
                    size="xs"
                    variant="link"
                    onClick={() => void load(layout)}
                  >
                    Load
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="destructive"
                    onClick={() => void retire(layout)}
                  >
                    Retire
                  </Button>
                </div>
              ))}
              {!layouts.length ? (
                <p className="text-xs text-zinc-500">No published presets.</p>
              ) : null}
            </div>
          </div>
          {message ? <p className="text-xs text-amber-300">{message}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function ConfidenceMonitor({
  label,
  tone,
  scene,
  src,
}: {
  label: string;
  tone: "preview" | "program";
  scene: Scene | null;
  src: string;
}) {
  const monitorRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0);

  useEffect(() => {
    const monitor = monitorRef.current;
    if (!monitor) return;
    const update = () => {
      const bounds = monitor.getBoundingClientRect();
      setScale(Math.min(bounds.width / 1920, bounds.height / 1080));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(monitor);
    return () => observer.disconnect();
  }, []);

  const preview = tone === "preview";
  return (
    <section
      className={`min-w-0 overflow-hidden border bg-black md:order-2 ${preview ? "border-amber-400/80" : "border-red-500/90"}`}
    >
      <header
        className={`flex h-8 items-center gap-2 px-2 sm:px-3 ${preview ? "bg-amber-400 text-zinc-950" : "bg-red-600 text-white"}`}
      >
        <span className="shrink-0 text-xs font-black tracking-[0.12em] sm:tracking-[0.18em]">
          {label}
        </span>
        <span className="min-w-0 flex-1 truncate text-right text-xs font-semibold">
          {scene?.name || (preview ? "Preview is clear" : "Program is clear")}
        </span>
      </header>
      <div
        ref={monitorRef}
        className="relative h-[clamp(84px,13vh,210px)] sm:h-[clamp(84px,16vh,210px)] overflow-hidden bg-[radial-gradient(circle_at_center,#202631_0%,#08090b_72%)]"
      >
        {scene ? (
          <iframe
            title={`${label} confidence monitor`}
            src={src}
            tabIndex={-1}
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-1/2 border-0"
            style={{
              width: 1920,
              height: 1080,
              transform: `translate(-50%, -50%) scale(${scale})`,
              transformOrigin: "center",
              visibility: scale > 0 ? "visible" : "hidden",
            }}
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-600">
            <MonitorPlay size={30} strokeWidth={1.4} />
            <span className="mt-2 text-xs font-semibold uppercase tracking-widest">
              No scene selected
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

interface Props {
  programId: string;
  activeScene: Scene | null;
  stagedScene: Scene | null;
  scenes: Scene[];
  transitionId: string;
  realtimeConnected: boolean;
  fadeToBlack: boolean;
  workspace: ConsoleWorkspace;
  onWorkspaceChange: (workspace: ConsoleWorkspace) => void;
  onTransitionChange: (transitionId: string) => void;
  onStageScene: (
    sceneId: number | null,
  ) => Promise<void | boolean> | void | boolean;
  onTake: () => Promise<void> | void;
  onCut: () => Promise<void> | void;
  takeBusy?: boolean;
  takeError?: string | null;
  onFadeToBlack: () => void;
}

export function BroadcastSwitcherDeck(props: Props) {
  const preferences = useConsolePreferences();
  const latestPropsRef = useRef(props);
  latestPropsRef.current = props;
  const { touchMode, shortcutsEnabled } = preferences.profile;
  const dockWidth = preferences.profile.dockWidth ?? 300;
  const pendingStageRef = useRef<Promise<void>>(Promise.resolve());
  const [ftbArmed, setFtbArmed] = useState(false);
  const [sourceSearch, setSourceSearch] = useState("");
  const stageFailedRef = useRef(false);
  const [stageError, setStageError] = useState<string | null>(null);
  const ftbArmTimerRef = useRef<number | null>(null);
  useEffect(() => {
    stageFailedRef.current = false;
    setStageError(null);
  }, [props.programId]);

  useEffect(() => {
    return () => {
      if (ftbArmTimerRef.current !== null) {
        window.clearTimeout(ftbArmTimerRef.current);
      }
    };
  }, []);

  const stageScene = (sceneId: number | null) => {
    stageFailedRef.current = false;
    setStageError(null);
    const pending = Promise.resolve()
      .then(() => props.onStageScene(sceneId))
      .then((result) => {
        if (result === false)
          throw new Error(
            "Could not prepare Preview. Program has not changed.",
          );
      })
      .catch((error: unknown) => {
        stageFailedRef.current = true;
        setStageError(
          error instanceof Error ? error.message : "Could not prepare Preview.",
        );
      });
    pendingStageRef.current = pending;
    return pending;
  };
  const takeStagedScene = async () => {
    await pendingStageRef.current;
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );
    if (!stageFailedRef.current && !latestPropsRef.current.takeBusy)
      await latestPropsRef.current.onTake();
  };
  const cutStagedScene = async () => {
    await pendingStageRef.current;
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );
    if (!stageFailedRef.current && !latestPropsRef.current.takeBusy)
      await latestPropsRef.current.onCut();
  };
  const requestFadeToBlack = () => {
    if (props.fadeToBlack || ftbArmed) {
      if (ftbArmTimerRef.current !== null) {
        window.clearTimeout(ftbArmTimerRef.current);
        ftbArmTimerRef.current = null;
      }
      setFtbArmed(false);
      latestPropsRef.current.onFadeToBlack();
      return;
    }

    setFtbArmed(true);
    ftbArmTimerRef.current = window.setTimeout(() => {
      setFtbArmed(false);
      ftbArmTimerRef.current = null;
    }, 3_000);
  };

  useEffect(() => {
    if (!shortcutsEnabled) return;
    const handleShortcut = (event: KeyboardEvent) => {
      if (blocksBroadcastShortcut(event.target)) return;
      if (event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        requestFadeToBlack();
      } else if (
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        event.code === "Space"
      ) {
        event.preventDefault();
        void takeStagedScene();
      } else if (
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "c"
      ) {
        event.preventDefault();
        void cutStagedScene();
      } else if (event.key === "Escape") {
        event.preventDefault();
        void stageScene(null);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [
    props.onCut,
    props.onFadeToBlack,
    props.onStageScene,
    props.onTake,
    ftbArmed,
    props.fadeToBlack,
    shortcutsEnabled,
  ]);

  const selectWorkspace = (workspace: ConsoleWorkspace) => {
    preferences.updateProfile({ workspace });
    props.onWorkspaceChange(workspace);
  };
  const toggleTouch = () => {
    const next = !touchMode;
    preferences.updateProfile({ touchMode: next });
  };
  const toggleShortcuts = () => {
    const next = !shortcutsEnabled;
    preferences.updateProfile({ shortcutsEnabled: next });
  };

  const workspace =
    props.workspace === "graphics" ? "director" : props.workspace;

  const filteredScenes = props.scenes.filter((scene) =>
    scene.name.toLocaleLowerCase().includes(sourceSearch.toLocaleLowerCase()),
  );
  const sourceBank = (
    <aside
      className="order-3 col-span-2 flex min-h-0 flex-col rounded-[var(--radius-ui)] border border-sand/30 bg-dark-sand p-3 md:order-1 md:col-span-1 md:row-span-2"
      aria-label="Assigned scenes"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-xs font-bold uppercase tracking-wider text-text-secondary">
          Sources
        </h2>
        <span className="text-xs text-text-secondary">
          {props.scenes.length}
        </span>
      </div>
      <Input
        aria-label="Search scenes"
        placeholder="Find a scene…"
        value={sourceSearch}
        onChange={(event) => setSourceSearch(event.target.value)}
      />
      <div className="mt-2 grid max-h-24 gap-1.5 overflow-y-auto sm:grid-cols-2 md:max-h-[23rem] md:grid-cols-1">
        {filteredScenes.map((scene) => {
          const isPreview = scene.id === props.stagedScene?.id;
          const isProgram = scene.id === props.activeScene?.id;
          return (
            <button
              key={scene.id}
              type="button"
              onClick={() => void stageScene(scene.id)}
              aria-pressed={isPreview}
              className={`flex min-h-12 items-center justify-between gap-2 rounded-[var(--radius-button)] border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue ${isPreview ? "border-accent-yellow bg-accent-yellow/10" : isProgram ? "border-terracotta/50 bg-terracotta/10" : "border-sand/30 bg-dark-sand hover:bg-sand/10"}`}
            >
              <span className="min-w-0 truncate text-sm font-semibold">
                {scene.name}
              </span>
              <span
                className={`shrink-0 text-[10px] font-bold uppercase ${isPreview ? "text-accent-yellow" : isProgram ? "text-terracotta" : "text-text-secondary"}`}
              >
                {isPreview && isProgram
                  ? "Preview · Program"
                  : isPreview
                    ? "Preview"
                    : isProgram
                      ? "Program"
                      : "Stage"}
              </span>
            </button>
          );
        })}
        {!filteredScenes.length && (
          <p className="col-span-full px-2 py-3 text-xs text-text-secondary">
            {props.scenes.length
              ? "No scenes match your search."
              : "No scenes assigned. Add scenes from the Library."}
          </p>
        )}
      </div>
      <p className="mt-2 text-[11px] text-text-secondary">
        Select a source to prepare it in Preview.
      </p>
    </aside>
  );

  return (
    <section
      className={`shrink-0 border-b border-sand/30 bg-dark-sand text-text-primary ${touchMode ? "text-base" : "text-sm"}`}
      data-console-workspace={workspace}
      data-touch-mode={touchMode}
    >
      <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-sand/30 px-3 py-2">
        <div
          className="mr-2 flex items-center gap-2 font-semibold"
          title={
            props.realtimeConnected
              ? "Live updates connected"
              : "Live updates disconnected"
          }
        >
          {props.realtimeConnected ? (
            <Wifi size={16} className="text-sea" />
          ) : (
            <WifiOff size={16} className="text-accent-yellow" />
          )}
          <span>Live desk</span>
        </div>
        {WORKSPACES.map((option) => (
          <Button
            key={option.id}
            type="button"
            size="sm"
            variant={option.id === workspace ? "primary" : "ghost"}
            onClick={() => selectWorkspace(option.id)}
            aria-pressed={workspace === option.id}
          >
            {option.label}
          </Button>
        ))}
        <details className="relative ml-auto">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-[var(--radius-button)] px-2 py-1 text-xs text-text-secondary">
            <Settings2 size={15} />
            Workspace options
          </summary>
          <div className="absolute right-0 top-full z-40 mt-2 w-72 rounded-[var(--radius-ui)] border border-sand/30 bg-dark-sand p-3 shadow-xl">
            <div className="flex flex-wrap gap-2">
              <ConsolePreferenceControls programId={props.programId} />
              <IconButton
                type="button"
                size="sm"
                variant={shortcutsEnabled ? "subtle" : "ghost"}
                aria-label="Toggle keyboard shortcuts"
                aria-pressed={shortcutsEnabled}
                onClick={toggleShortcuts}
                title="Space: TAKE · C: CUT · Escape: clear Preview"
              >
                <Keyboard size={17} />
              </IconButton>
              <IconButton
                type="button"
                size="sm"
                variant={touchMode ? "subtle" : "ghost"}
                aria-label="Toggle touch mode"
                aria-pressed={touchMode}
                onClick={toggleTouch}
              >
                <Smartphone size={17} />
              </IconButton>
              <IconButton
                type="button"
                size="sm"
                variant="ghost"
                aria-label="Enter fullscreen"
                onClick={() =>
                  void document.documentElement.requestFullscreen?.()
                }
              >
                <Expand size={17} />
              </IconButton>
            </div>
            <label className="mt-3 block text-xs text-text-secondary">
              Source panel width
              <input
                type="range"
                min={260}
                max={520}
                value={dockWidth}
                onChange={(event) =>
                  preferences.updateProfile({
                    dockWidth: Number(event.target.value),
                  })
                }
                className="mt-1 w-full"
              />
            </label>
          </div>
        </details>
      </div>
      <div
        className={
          workspace === "audio"
            ? "grid gap-3 p-3 md:grid-cols-[minmax(280px,420px)_minmax(0,1fr)]"
            : "grid grid-cols-2 gap-3 p-3 md:grid-cols-[var(--source-width)_minmax(0,1fr)_minmax(0,1fr)]"
        }
        style={
          { "--source-width": `min(${dockWidth}px, 30vw)` } as CSSProperties
        }
      >
        {workspace !== "audio" && sourceBank}
        {workspace !== "audio" && (
          <ConfidenceMonitor
            label="PREVIEW"
            tone="preview"
            scene={props.stagedScene}
            src={`/program/${encodeURIComponent(props.programId)}?confidence=preview`}
          />
        )}
        <ConfidenceMonitor
          label="PROGRAM"
          tone="program"
          scene={props.activeScene}
          src={`/program/${encodeURIComponent(props.programId)}?confidence=program`}
        />
        {workspace === "audio" ? (
          <div className="hidden items-center rounded-[var(--radius-ui)] border border-sand/30 bg-dark-sand px-5 text-sm text-text-secondary md:flex">
            Program stays visible while you operate audio below.
          </div>
        ) : (
          <div className="order-4 col-span-2 rounded-[var(--radius-ui)] border border-sand/30 bg-dark-sand p-3 md:order-4">
            <div className="flex flex-wrap items-end gap-3">
              <label className="w-full min-w-0 text-xs text-text-secondary sm:w-auto sm:flex-1">
                Transition
                <select
                  value={props.transitionId}
                  onChange={(event) =>
                    props.onTransitionChange(event.target.value)
                  }
                  className="mt-1 w-full rounded-[var(--radius-button)] border border-sand/30 bg-dark-sand px-2 py-2 text-text-primary"
                >
                  {SCENE_TRANSITIONS.map((transition) => (
                    <option key={transition.id} value={transition.id}>
                      {transition.name}
                    </option>
                  ))}
                </select>
              </label>
              <BroadcastAction
                kind="cut"
                className="flex-1 sm:flex-none"
                disabled={!props.stagedScene || props.takeBusy}
                onClick={() => void cutStagedScene()}
              >
                CUT
              </BroadcastAction>
              <BroadcastAction
                kind="take"
                className="flex-1 sm:flex-none"
                disabled={!props.stagedScene || props.takeBusy}
                onClick={() => void takeStagedScene()}
              >
                {props.takeBusy ? "TAKING…" : "TAKE TO PROGRAM"}
              </BroadcastAction>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p role="status" className="text-xs text-text-secondary">
                {props.takeBusy
                  ? "Saving Preview and taking it to Program…"
                  : props.stagedScene
                    ? `Ready: ${props.stagedScene.name}`
                    : "Choose a source to prepare the next scene."}
              </p>
              <button
                type="button"
                onClick={requestFadeToBlack}
                aria-pressed={props.fadeToBlack}
                className={`rounded-[var(--radius-button)] border px-3 py-2 text-xs font-semibold ${props.fadeToBlack || ftbArmed ? "border-terracotta text-terracotta" : "border-sand/30 text-text-secondary hover:text-text-primary"}`}
              >
                {props.fadeToBlack
                  ? "RESTORE PROGRAM"
                  : ftbArmed
                    ? "CONFIRM FADE TO BLACK"
                    : "ARM FADE TO BLACK"}
              </button>
            </div>
            {(props.takeError || stageError) && (
              <p
                role="alert"
                className="mt-2 rounded-[var(--radius-button)] border border-terracotta/40 bg-terracotta/10 px-3 py-2 text-sm text-terracotta"
              >
                {props.takeError || stageError}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
