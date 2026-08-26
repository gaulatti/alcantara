import { useEffect, useRef, useState, type CSSProperties } from "react";
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

export type { ConsoleWorkspace } from "../contexts/ConsolePreferencesContext";

const WORKSPACES: Array<{ id: ConsoleWorkspace; label: string }> = [
  { id: "director", label: "Director" },
  { id: "audio", label: "Audio" },
  { id: "graphics", label: "Graphics" },
  { id: "compact", label: "Compact / touch" },
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
      throw new Error(`Shared layouts failed (${response.status})`);
    setLayouts((await response.json()) as SharedLayout[]);
  };

  useEffect(() => {
    if (!open) return;
    void refresh().catch((error: unknown) =>
      setMessage(
        error instanceof Error ? error.message : "Shared layouts unavailable",
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
          ? "You do not have permission to publish layouts."
          : `Publish failed (${response.status})`,
      );
      return;
    }
    setMessage("Layout published.");
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
          ? "This layout targets another device class or your profile changed. Refresh and try again."
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
    const response = await fetch(
      `${getApiBaseUrl()}/operator-preferences/shared/${layout.id}`,
      { method: "DELETE" },
    );
    if (!response.ok) {
      setMessage(
        response.status === 403
          ? "You do not have permission to retire layouts."
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
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="rounded bg-zinc-800 px-2 py-1 text-xs"
      >
        {preferences.deviceClass} prefs
      </button>
      {open ? (
        <div className="absolute right-0 top-9 z-50 w-80 space-y-3 rounded border border-zinc-700 bg-zinc-950 p-3 shadow-2xl">
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
          <button
            type="button"
            onClick={() => preferences.setDeviceClassOverride(null)}
            className="text-xs text-sky-300"
          >
            Use detected {preferences.detectedDeviceClass}
          </button>
          {preferences.conflict ? (
            <div className="rounded border border-red-800 p-2 text-xs">
              A newer profile exists.
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={preferences.useAuthoritative}
                  className="rounded bg-zinc-700 px-2 py-1"
                >
                  Use server
                </button>
                <button
                  type="button"
                  onClick={preferences.retryLocal}
                  className="rounded bg-red-800 px-2 py-1"
                >
                  Retry mine
                </button>
              </div>
            </div>
          ) : null}
          <div className="flex gap-2 text-xs">
            <button
              type="button"
              onClick={() => void preferences.resetCurrent()}
              className="rounded bg-zinc-800 px-2 py-1"
            >
              Reset class
            </button>
            <button
              type="button"
              onClick={() => void preferences.resetAll()}
              className="rounded bg-zinc-800 px-2 py-1"
            >
              Reset all
            </button>
          </div>
          <div className="border-t border-zinc-800 pt-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase text-zinc-400">
                Shared layouts
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
                aria-label={`New ${scope} layout name`}
                value={layoutName}
                onChange={(event) => setLayoutName(event.target.value)}
                placeholder="Layout name"
                className="min-w-0 flex-1 rounded bg-zinc-900 p-2 text-xs"
              />
              <button
                type="button"
                disabled={!layoutName.trim() || !scopeId}
                onClick={() => void publish()}
                className="rounded bg-sky-800 px-2 py-1 text-xs disabled:opacity-40"
              >
                Publish
              </button>
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
                  <button
                    type="button"
                    onClick={() => void load(layout)}
                    className="text-sky-300"
                  >
                    Load
                  </button>
                  <button
                    type="button"
                    onClick={() => void retire(layout)}
                    className="text-red-300"
                  >
                    Retire
                  </button>
                </div>
              ))}
              {!layouts.length ? (
                <p className="text-xs text-zinc-500">No published layouts.</p>
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
        className={`flex h-8 items-center justify-between px-3 ${preview ? "bg-amber-400 text-zinc-950" : "bg-red-600 text-white"}`}
      >
        <span className="text-xs font-black tracking-[0.18em]">{label}</span>
        <span className="max-w-[70%] truncate text-xs font-semibold">
          {scene?.name || (preview ? "Preview is clear" : "Program is clear")}
        </span>
      </header>
      <div
        ref={monitorRef}
        className="relative aspect-video overflow-hidden bg-[radial-gradient(circle_at_center,#202631_0%,#08090b_72%)]"
      >
        {scene ? (
          <iframe
            title={`${label} confidence monitor`}
            src={src}
            tabIndex={-1}
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 border-0"
            style={{
              width: 1920,
              height: 1080,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
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

  useEffect(() => {
    if (!shortcutsEnabled) return;
    const handleShortcut = (event: KeyboardEvent) => {
      if (blocksBroadcastShortcut(event.target)) return;
      if (event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        props.onFadeToBlack();
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

  return (
    <section
      className={`border-b border-zinc-700 bg-zinc-950 text-zinc-100 ${touchMode ? "text-base" : "text-sm"}`}
      data-console-workspace={props.workspace}
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
        {WORKSPACES.map((workspace) => (
          <button
            key={workspace.id}
            type="button"
            onClick={() => selectWorkspace(workspace.id)}
            className={`rounded px-3 py-2 font-semibold ${props.workspace === workspace.id ? "bg-sky-500 text-zinc-950" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`}
          >
            {workspace.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <ConsolePreferenceControls programId={props.programId} />
          <button
            type="button"
            aria-label="Toggle keyboard shortcuts"
            aria-pressed={shortcutsEnabled}
            onClick={toggleShortcuts}
            title="Keyboard shortcuts: Space TAKE, C CUT, Escape clear Preview, Alt+B FTB"
            className={`rounded p-2 ${shortcutsEnabled ? "bg-sky-900 text-sky-200" : "bg-zinc-800 text-zinc-500"}`}
          >
            <Keyboard size={17} />
          </button>
          <button
            type="button"
            aria-label="Toggle touch mode"
            aria-pressed={touchMode}
            onClick={toggleTouch}
            className={`rounded p-2 ${touchMode ? "bg-sky-900 text-sky-200" : "bg-zinc-800 text-zinc-400"}`}
          >
            <Smartphone size={17} />
          </button>
          <button
            type="button"
            aria-label="Enter fullscreen"
            onClick={() => void document.documentElement.requestFullscreen?.()}
            className="rounded bg-zinc-800 p-2 text-zinc-400"
          >
            <Expand size={17} />
          </button>
        </div>
      </div>

      <div
        className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_var(--dock-width)]"
        style={{ "--dock-width": `${dockWidth}px` } as CSSProperties}
      >
        <ConfidenceMonitor
          label="PREVIEW"
          tone="preview"
          scene={props.stagedScene}
          src={`/program/${encodeURIComponent(props.programId)}?confidence=preview`}
        />
        <ConfidenceMonitor
          label="PROGRAM"
          tone="program"
          scene={props.activeScene}
          src={`/program/${encodeURIComponent(props.programId)}?confidence=program`}
        />
        <aside className="min-w-0 border border-zinc-700 bg-zinc-900 p-3">
          <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-zinc-400">
            <PanelRight size={15} />
            Switcher
          </div>
          <label className="block text-xs text-zinc-400">
            Transition
            <select
              value={props.transitionId}
              onChange={(event) => props.onTransitionChange(event.target.value)}
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
            <button
              type="button"
              disabled={!props.stagedScene}
              onClick={() => void cutStagedScene()}
              className="rounded bg-zinc-100 px-3 py-3 font-black text-zinc-950 disabled:opacity-40"
            >
              CUT <span className="text-xs font-normal">(C)</span>
            </button>
            <button
              type="button"
              disabled={!props.stagedScene}
              onClick={() => void takeStagedScene()}
              className="rounded bg-sky-500 px-3 py-3 font-black text-zinc-950 disabled:opacity-40"
            >
              TAKE <span className="text-xs font-normal">(Space)</span>
            </button>
          </div>
          <button
            type="button"
            aria-pressed={props.fadeToBlack}
            onClick={props.onFadeToBlack}
            className={`mt-3 w-full rounded border px-3 py-3 font-black ${props.fadeToBlack ? "border-red-400 bg-red-600 text-white" : "border-zinc-600 bg-black text-zinc-200"}`}
          >
            {props.fadeToBlack ? "FTB ACTIVE" : "FADE TO BLACK"}{" "}
            <span className="text-xs font-normal">(Alt+B)</span>
          </button>
          <label className="mt-4 block text-xs text-zinc-500">
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
      </div>

      <div className="border-t border-zinc-800 px-3 py-3">
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
                className={`min-h-14 rounded border px-3 py-2 text-left ${isProgram ? "border-red-500 bg-red-950/70" : isPreview ? "border-amber-400 bg-amber-950/60" : "border-zinc-700 bg-zinc-900 hover:border-zinc-500"}`}
              >
                <span className="block truncate font-semibold">
                  {scene.name}
                </span>
                <span
                  className={`text-[10px] font-bold uppercase tracking-wider ${isProgram ? "text-red-400" : isPreview ? "text-amber-300" : "text-zinc-500"}`}
                >
                  {isProgram ? "PGM" : isPreview ? "PVW" : "Source"}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
