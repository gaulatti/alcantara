import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button, IconButton } from "@gaulatti/bleecker";
import {
  Expand,
  Keyboard,
  MonitorPlay,
  PanelRight,
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
        <div className="absolute right-0 top-10 z-50 max-h-[min(38rem,calc(100vh-5rem))] w-[min(24rem,calc(100vw-1rem))] space-y-4 overflow-y-auto rounded-[var(--radius-card)] border border-border-subtle bg-surface-elevated p-4 shadow-[var(--shadow-overlay)]">
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
      className={`min-w-0 overflow-hidden border bg-black ${preview ? "border-amber-400/80" : "border-red-500/90"}`}
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
        className="relative h-[clamp(84px,16vh,210px)] overflow-hidden bg-[radial-gradient(circle_at_center,#202631_0%,#08090b_72%)]"
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
  onStageScene: (sceneId: number | null) => Promise<void> | void;
  onTake: () => void;
  onCut: () => void;
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
  const ftbArmTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (ftbArmTimerRef.current !== null) {
        window.clearTimeout(ftbArmTimerRef.current);
      }
    };
  }, []);

  const stageScene = (sceneId: number | null) => {
    const pending = Promise.resolve(props.onStageScene(sceneId));
    pendingStageRef.current = pending;
    return pending;
  };
  const takeStagedScene = async () => {
    await pendingStageRef.current;
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );
    latestPropsRef.current.onTake();
  };
  const cutStagedScene = async () => {
    await pendingStageRef.current;
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );
    latestPropsRef.current.onCut();
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

  const sourceBank = (
    <div
      className="order-3 col-span-2 max-h-32 overflow-y-auto rounded-[var(--radius-ui)] border border-zinc-800 bg-zinc-950 p-2 md:order-4 md:col-span-3 md:max-h-36"
      aria-label="Assigned scenes"
    >
      <div
        className={`grid gap-2 ${touchMode ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5" : "grid-cols-3 sm:grid-cols-5 lg:grid-cols-8"}`}
      >
        {props.scenes.map((scene) => {
          const isPreview = scene.id === props.stagedScene?.id;
          const isProgram = scene.id === props.activeScene?.id;
          return (
            <button
              key={scene.id}
              type="button"
              onClick={() => void stageScene(scene.id)}
              className={`min-h-12 rounded-[var(--radius-button)] border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${isProgram ? "border-red-500 bg-red-950/70" : isPreview ? "border-amber-400 bg-amber-950/60" : "border-zinc-700 bg-zinc-900 hover:border-zinc-500"}`}
            >
              <span className="block truncate font-semibold">{scene.name}</span>
              <span
                className={`text-[10px] font-bold uppercase tracking-wider ${isProgram ? "text-red-400" : isPreview ? "text-amber-300" : "text-zinc-500"}`}
              >
                {isProgram ? "PGM" : isPreview ? "PVW" : "Stage"}
              </span>
            </button>
          );
        })}
        {props.scenes.length === 0 ? (
          <p className="col-span-full px-2 py-3 text-xs text-zinc-500">
            No scenes are assigned to this show.
          </p>
        ) : null}
      </div>
    </div>
  );

  return (
    <section
      className={`shrink-0 border-b border-zinc-700 bg-zinc-950 text-zinc-100 ${touchMode ? "text-base" : "text-sm"}`}
      data-console-workspace={workspace}
      data-touch-mode={touchMode}
    >
      <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <div className="mr-2 flex items-center gap-2 font-semibold">
          {props.realtimeConnected ? (
            <Wifi size={16} className="text-emerald-400" />
          ) : (
            <WifiOff size={16} className="text-amber-400" />
          )}
          <span>{props.programId}</span>
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
        <div className="ml-auto flex items-center gap-2">
          <ConsolePreferenceControls programId={props.programId} />
          <IconButton
            type="button"
            size="sm"
            variant={shortcutsEnabled ? "subtle" : "ghost"}
            aria-label="Toggle keyboard shortcuts"
            aria-pressed={shortcutsEnabled}
            onClick={toggleShortcuts}
            title="Shortcuts: Space TAKE, C CUT, Escape clears Preview, press Alt+B twice for FTB"
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
            onClick={() => void document.documentElement.requestFullscreen?.()}
          >
            <Expand size={17} />
          </IconButton>
        </div>
      </div>

      <div
        className={
          workspace === "audio"
            ? "grid gap-2 p-2 md:grid-cols-[minmax(280px,420px)_minmax(0,1fr)]"
            : "grid grid-cols-2 gap-2 p-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_var(--dock-width)]"
        }
        style={{ "--dock-width": `${dockWidth}px` } as CSSProperties}
      >
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
          <div className="hidden min-w-0 items-center rounded-[var(--radius-ui)] border border-zinc-800 bg-zinc-900 px-5 text-sm text-zinc-400 md:flex">
            Program confidence remains visible while the full mixer, playlist,
            and soundboard use the workspace below.
          </div>
        ) : (
          sourceBank
        )}
        {workspace !== "audio" && (
          <aside className="order-4 col-span-2 min-w-0 rounded-[var(--radius-ui)] border border-zinc-700 bg-zinc-900 p-2.5 md:order-3 md:col-span-1 md:p-3">
            <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-zinc-400">
              <PanelRight size={15} />
              Switcher
            </div>
            <label className="block text-xs text-zinc-400">
              Transition
              <select
                value={props.transitionId}
                onChange={(event) =>
                  props.onTransitionChange(event.target.value)
                }
                className="mt-1 w-full rounded border border-zinc-600 bg-zinc-950 px-2 py-2 text-zinc-100"
              >
                {SCENE_TRANSITIONS.map((transition) => (
                  <option key={transition.id} value={transition.id}>
                    {transition.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <BroadcastAction
                kind="cut"
                disabled={!props.stagedScene}
                onClick={() => void cutStagedScene()}
              >
                CUT{" "}
                <span className="hidden text-xs font-normal sm:inline">
                  (C)
                </span>
              </BroadcastAction>
              <BroadcastAction
                kind="take"
                disabled={!props.stagedScene}
                onClick={() => void takeStagedScene()}
              >
                TAKE{" "}
                <span className="hidden text-xs font-normal sm:inline">
                  (Space)
                </span>
              </BroadcastAction>
            </div>
            <BroadcastAction
              kind={props.fadeToBlack ? "restore" : "danger"}
              fullWidth
              aria-pressed={props.fadeToBlack}
              title={
                props.fadeToBlack
                  ? "Restore Program"
                  : "Press twice within three seconds to fade Program to black"
              }
              onClick={requestFadeToBlack}
              className="mt-2"
            >
              {props.fadeToBlack
                ? "RESTORE PROGRAM"
                : ftbArmed
                  ? "CONFIRM FADE TO BLACK"
                  : "ARM FADE TO BLACK"}{" "}
              {!props.fadeToBlack ? (
                <span className="hidden text-xs font-normal sm:inline">
                  (Alt+B twice)
                </span>
              ) : null}
            </BroadcastAction>
            <label className="mt-4 hidden text-xs text-zinc-500 md:block">
              Dock width
              <input
                type="range"
                min={260}
                max={520}
                value={dockWidth}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  preferences.updateProfile({ dockWidth: next });
                }}
                className="mt-1 w-full"
              />
            </label>
          </aside>
        )}
      </div>
    </section>
  );
}
