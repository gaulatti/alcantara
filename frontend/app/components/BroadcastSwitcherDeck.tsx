import { getDesktopHost } from "../platform/desktopHost";
import { TooltipButton } from "./BleeckerButtons";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArmTake,
  Button,
  IconButton,
  Input,
  Select,
  Fader,
  StatePill,
  type StatePillTone,
} from "@gaulatti/bleecker";
import {
  Expand,
  Headphones,
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
  RETURN_STATE_LABEL,
  behindLabel,
  returnState,
  sinceLabel,
  type ReturnSource,
  type ReturnState,
} from "../utils/programReturn";
import {
  useConsolePreferences,
  type ConsoleWorkspace,
} from "../contexts/ConsolePreferencesContext";
import { getApiBaseUrl } from "../utils/apiBaseUrl";
import { useFeatures } from "../hooks/useFeatures";
import { BroadcastAction } from "./BroadcastAction";
import { ConsoleClock } from "./ConsoleSurface";

export type { ConsoleWorkspace } from "../contexts/ConsolePreferencesContext";

const WORKSPACES: Array<{ id: ConsoleWorkspace; label: string }> = [
  { id: "director", label: "Director" },
  { id: "audio", label: "Audio" },
  { id: "compact", label: "Remote" },
];

/** How long a fade to black stays armed for its second press. The button and the Alt+B arm share it, so an expired arm can never take. */
const FTB_ARM_MS = 3_000;

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

/** How each preference sync state reads as a state pill. */
const SYNC_TONE: Record<string, StatePillTone> = {
  synced: "ok",
  conflict: "bad",
};

const DEVICE_CLASSES = [
  { value: "desktop", label: "Desktop" },
  { value: "tablet", label: "Tablet" },
  { value: "phone", label: "Phone" },
];

function ConsolePreferenceControls({ programId }: { programId: string }) {
  const preferences = useConsolePreferences();
  const { context } = useFeatures();
  const [open, setOpen] = useState(false);
  const [layouts, setLayouts] = useState<SharedLayout[]>([]);
  const [message, setMessage] = useState("");
  const [scope, setScope] = useState<"program" | "team">("program");
  const [layoutName, setLayoutName] = useState("");
  const teamId = context?.authorization?.teamId;
  /* v8 ignore next -- the team scope is offered only when the operator has a team, so the empty fallback cannot be reached */
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
      <StatePill
        /* v8 ignore next -- the sync state is a closed union set by the preferences context, so the fallback tone cannot be reached */
        tone={SYNC_TONE[preferences.syncState] ?? "warn"}
        label={`Preferences ${preferences.syncState}`}
      />
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
          <div className="block text-xs text-text-secondary">
            <span id="console-device-class">Device class override</span>
            <Select
              className="mt-1 w-full"
              size="sm"
              aria-label="Device class override"
              value={preferences.deviceClass}
              options={DEVICE_CLASSES}
              onChange={(value) =>
                preferences.setDeviceClassOverride(
                  value as "desktop" | "tablet" | "phone",
                )
              }
            />
          </div>
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
            <div className="mt-2 block text-xs text-text-secondary">
              <span>Visibility</span>
              <Select
                className="mt-1 w-full"
                size="sm"
                aria-label="Preset visibility"
                value={scope}
                options={[
                  { value: "program", label: "This program" },
                  ...(teamId ? [{ value: "team", label: "My team" }] : []),
                ]}
                onChange={(value) => {
                  setScope(value as "program" | "team");
                  setMessage("");
                }}
              />
            </div>
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

export function ConfidenceMonitor({
  label,
  tone,
  scene,
  src,
  state: airState,
  returnSource = { kind: "local" },
  returnMedia,
  programId,
}: {
  label: string;
  tone: "preview" | "program";
  scene: Scene | null;
  src: string;
  /** With a desktop host's program monitor (gaulatti/alcantara#431), PROGRAM shows the program's own picture. */
  programId?: string;
  /** What is going out, shown on the Program monitor: on air, or faded to black. */
  state?: { tone: StatePillTone; label: string; pulse?: boolean };
  /**
   * The program's real return (alcantara#301). Until one exists this stays
   * `local`: the monitor shows the program page rendered again in this browser,
   * silent, and says it is not the output.
   */
  returnSource?: ReturnSource;
  /** The return's own video, once a real return exists. */
  returnMedia?: ReactNode;
}) {
  const monitorRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const preview = tone === "preview";
  const fromReturn = !preview && returnSource.kind === "return";

  useEffect(() => {
    const monitor = monitorRef.current;
    /* v8 ignore next -- the observer effect runs after the monitor element is mounted, so the monitor ref is set here */
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

  // Only a real return has timers (frozen for, lost for) to keep current.
  useEffect(() => {
    if (!fromReturn) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [fromReturn]);

  const state: ReturnState = preview ? "local" : returnState(returnSource, now);
  const behind =
    returnSource.kind === "return" ? behindLabel(returnSource.latencyMs) : null;
  const lastFrameAt =
    returnSource.kind === "return" ? returnSource.lastFrameAt : null;
  const HostMonitor = getDesktopHost()?.programMonitor;
  const nativeMonitor = !preview && !fromReturn && Boolean(programId) && HostMonitor ? HostMonitor : null;
  return (
    <section
      data-tone={tone}
      data-return-state={preview ? undefined : state}
      aria-label={preview ? `${label} monitor` : fromReturn ? "Program return" : nativeMonitor ? `${label} monitor, program source` : `${label} monitor, local render`}
      className={`switcher-monitor min-w-0 overflow-hidden border bg-black md:order-2 ${preview ? "border-amber-400/60 opacity-95" : "border-red-500 shadow-[0_0_0_1px_rgba(239,68,68,0.45),0_12px_32px_-12px_rgba(239,68,68,0.55)]"}`}
    >
      <header
        className={`flex h-8 items-center gap-2 px-2 sm:px-3 ${preview ? "bg-amber-400 text-zinc-950" : "bg-red-600 text-white"}`}
      >
        <span className="shrink-0 text-xs font-black tracking-[0.12em] sm:tracking-[0.18em]">
          {fromReturn && returnSource.kind === "return"
            ? `RETURN · FROM ${returnSource.from.toUpperCase()}`
            : label}
        </span>
        {fromReturn ? (
          <span className="switcher-return-state" data-state={state}>
            {RETURN_STATE_LABEL[state]}
          </span>
        ) : (
          <span className="switcher-return-local">{nativeMonitor ? "program source" : "local render"}</span>
        )}
        {behind && state !== "lost" ? (
          <span className="switcher-return-behind">{behind}</span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-right text-xs font-semibold">
          {scene?.name || (preview ? "Preview is clear" : "Program is clear")}
        </span>
        {airState ? (
          <StatePill
            className="shrink-0 border-white/40 bg-black/30 text-white"
            tone={airState.tone}
            label={airState.label}
            pulse={airState.pulse}
          />
        ) : null}
        {!preview ? (
          <button
            type="button"
            className="switcher-return-listen"
            aria-label="Listen"
            disabled
            title={
              fromReturn
                ? "Return audio is not available yet"
                : "No return audio: the local render is silent"
            }
          >
            <Headphones size={12} aria-hidden="true" /> <span className="switcher-return-listen-label">Listen</span>
          </button>
        ) : null}
      </header>
      <div
        ref={monitorRef}
        className="switcher-monitor-screen relative h-[clamp(84px,13vh,210px)] sm:h-[clamp(84px,16vh,210px)] overflow-hidden bg-[radial-gradient(circle_at_center,#202631_0%,#08090b_72%)]"
      >
        {fromReturn ? (
          (returnMedia ?? (
            // With a frozen or lost overlay centred on the screen, the label moves to the top so the two never overlap.
            <div
              className={`switcher-monitor-empty absolute inset-0 flex justify-center text-xs font-semibold uppercase tracking-widest ${state === "frozen" || state === "lost" ? "items-start pt-2" : "items-center"}`}
            >
              No return picture
            </div>
          ))
        ) : nativeMonitor ? (
          (() => {
            const Monitor = nativeMonitor;
            /* v8 ignore next -- the native monitor is only chosen when programId is set (see nativeMonitor), so the empty-string fallback cannot be reached */
            return <Monitor programId={programId ?? ""} />;
          })()
        ) : scene ? (
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
          <div className="switcher-monitor-empty absolute inset-0 flex flex-col items-center justify-center text-zinc-600">
            <MonitorPlay size={30} strokeWidth={1.4} />
            <span className="mt-2 text-xs font-semibold uppercase tracking-widest">
              No scene selected
            </span>
          </div>
        )}
        {!preview && state === "local" && !nativeMonitor ? (
          <p className="switcher-return-ribbon" role="note">
            Local render · not the output
          </p>
        ) : null}
        {state === "frozen" ? (
          <p className="switcher-return-overlay" data-state="frozen" role="status">
            Frozen · same frame for {sinceLabel(lastFrameAt, now)}
          </p>
        ) : null}
        {state === "lost" ? (
          <p className="switcher-return-overlay" data-state="lost" role="alert">
            Signal lost · {lastFrameAt === null ? "no frame yet" : `${sinceLabel(lastFrameAt, now)} since the last frame`}
          </p>
        ) : null}
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
    }, FTB_ARM_MS);
  };

  useEffect(() => {
    if (!shortcutsEnabled) return;
    const handleShortcut = (event: KeyboardEvent) => {
      if (blocksBroadcastShortcut(event.target)) return;
      const plain =
        !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
      const action =
        event.altKey && event.key.toLowerCase() === "b"
          ? requestFadeToBlack
          : plain && event.code === "Space"
            ? () => void takeStagedScene()
            : plain && event.key.toLowerCase() === "c"
              ? () => void cutStagedScene()
              : event.key === "Escape"
                ? () => void stageScene(null)
                : null;
      if (!action) return;
      event.preventDefault();
      // A held key repeats keydown: only a fresh press acts, so holding Alt+B
      // can never arm and then take, and holding Space or C takes once.
      if (event.repeat) return;
      action();
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
      className="switcher-source-bank order-3 col-span-2 flex min-h-0 flex-col rounded-[var(--radius-ui)] border border-sand/30 bg-dark-sand p-3 md:order-1 md:col-span-1 md:row-span-2"
      aria-label="Assigned scenes"
    >
      <div className="console-panel-heading mb-2 flex items-center justify-between gap-2">
        <h2 className="text-xs font-bold uppercase tracking-wider text-text-secondary">
          Sources
        </h2>
        <span className="text-xs text-text-secondary">
          {props.scenes.length}
        </span>
      </div>
      <div className="switcher-source-search">
        <Input
          aria-label="Search scenes"
          placeholder="Find a scene…"
          value={sourceSearch}
          onChange={(event) => setSourceSearch(event.target.value)}
        />
      </div>
      <div className="switcher-source-list mt-2 grid max-h-24 gap-1.5 overflow-y-auto sm:grid-cols-2 md:max-h-[23rem] md:grid-cols-1">
        {filteredScenes.map((scene) => {
          const isPreview = scene.id === props.stagedScene?.id;
          const isProgram = scene.id === props.activeScene?.id;
          return (
            <TooltipButton
              key={scene.id}
              type="button"
              onClick={() => void stageScene(scene.id)}
              aria-pressed={isPreview}
              className={`switcher-source flex min-h-12 items-center justify-between gap-2 rounded-[var(--radius-button)] border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue ${isPreview ? "border-accent-yellow bg-accent-yellow/10" : isProgram ? "border-terracotta/50 bg-terracotta/10" : "border-sand/30 bg-dark-sand hover:bg-sand/10"}`}
            >
              <span className="switcher-source-index">
                {String(props.scenes.indexOf(scene) + 1).padStart(2, "0")}
              </span>
              <span className="switcher-source-name line-clamp-2 min-w-0 flex-1 break-words text-sm font-semibold">
                {scene.name}
              </span>
              {isProgram ? (
                <StatePill
                  className="shrink-0"
                  tone="live"
                  label={isPreview ? "Preview · Program" : "Program"}
                />
              ) : isPreview ? (
                <StatePill className="shrink-0" tone="arm" label="Preview" />
              ) : (
                <span className="shrink-0 text-xs text-text-secondary">
                  Stage
                </span>
              )}
            </TooltipButton>
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
      <p className="m-3 text-xs text-text-secondary">
        Select a source to prepare it in Preview.
      </p>
    </aside>
  );

  return (
    <section
      className={`broadcast-console switcher-console shrink-0 border-b border-sand/30 bg-dark-sand text-text-primary ${touchMode ? "text-base" : "text-sm"}`}
      data-console-workspace={workspace}
      data-touch-mode={touchMode}
    >
      <div className="console-toolbar">
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
          <span>
            <span className="console-eyebrow">Studio / {props.programId}</span>
            Live control
          </span>
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
        <ConsoleClock />
        <details className="relative ml-auto">
          <summary className="switcher-options-summary flex cursor-pointer list-none items-center gap-1.5 rounded-[var(--radius-button)] px-2 py-1 text-xs text-text-secondary">
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
                title="Space: TAKE · C: CUT · Escape: clear Preview · Alt+B twice: fade to black"
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
            <Fader
              className="mt-3"
              label="Source panel width"
              orientation="horizontal"
              length="100%"
              unit="percent"
              format={(value) => `${Math.round(value)} px`}
              min={260}
              max={520}
              step={10}
              coarseStep={40}
              value={dockWidth}
              onValueChange={(value) =>
                preferences.updateProfile({ dockWidth: value })
              }
            />
          </div>
        </details>
      </div>
      {workspace !== "audio" && (
        <div
          className="switcher-body grid grid-cols-2 gap-3 p-3 md:grid-cols-[var(--source-width)_minmax(0,1fr)_minmax(0,1fr)]"
          style={
            { "--source-width": `min(${dockWidth}px, 30vw)` } as CSSProperties
          }
        >
          {sourceBank}
          <ConfidenceMonitor
            label="PREVIEW"
            tone="preview"
            scene={props.stagedScene}
            src={`/program/${encodeURIComponent(props.programId)}?confidence=preview`}
          />
          <ConfidenceMonitor
            label="PROGRAM"
            tone="program"
            programId={props.programId}
            scene={props.activeScene}
            src={`/program/${encodeURIComponent(props.programId)}?confidence=program`}
            state={
              props.fadeToBlack
                ? { tone: "bad", label: "Faded to black" }
                : props.activeScene
                  ? { tone: "live", label: "On air", pulse: true }
                  : undefined
            }
          />
          <div className="switcher-transports order-4 col-span-2 rounded-[var(--radius-ui)] border border-sand/30 bg-dark-sand p-3 md:order-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-full min-w-0 text-xs text-text-secondary sm:w-auto sm:flex-1">
                <span>Transition</span>
                <Select
                  className="mt-1 w-full"
                  aria-label="Transition"
                  value={props.transitionId}
                  options={SCENE_TRANSITIONS.map((transition) => ({
                    value: transition.id,
                    label: transition.name,
                  }))}
                  onChange={(value) => props.onTransitionChange(value)}
                />
              </div>
              <BroadcastAction
                kind="cut"
                className="switcher-cut flex-1 sm:flex-none"
                disabled={!props.stagedScene || props.takeBusy}
                onClick={() => void cutStagedScene()}
              >
                CUT
              </BroadcastAction>
              <BroadcastAction
                kind="take"
                className="switcher-take flex-1 sm:flex-none"
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
              {props.fadeToBlack ? (
                <TooltipButton
                  type="button"
                  onClick={requestFadeToBlack}
                  aria-pressed
                  className="rounded-[var(--radius-button)] border border-terracotta px-3 py-2 text-xs font-semibold text-terracotta"
                >
                  RESTORE PROGRAM
                </TooltipButton>
              ) : (
                <div className="flex items-center gap-2">
                  {ftbArmed ? (
                    <StatePill
                      tone="arm"
                      label="Fade to black armed: Alt+B again"
                    />
                  ) : null}
                  {/* Hold, or press twice: one stray click never fades the program. Armed, it says the second press
                      fades: it sits under Take to program, so "take" would point at the wrong control (#875). */}
                  <ArmTake
                    label="Fade to black"
                    armedLabel="Press again to fade"
                    armTimeoutMs={FTB_ARM_MS}
                    onTake={() => latestPropsRef.current.onFadeToBlack()}
                  />
                </div>
              )}
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
        </div>
      )}
    </section>
  );
}
