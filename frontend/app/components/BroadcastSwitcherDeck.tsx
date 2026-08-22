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

export type ConsoleWorkspace = "director" | "audio" | "graphics" | "compact";

const WORKSPACES: Array<{ id: ConsoleWorkspace; label: string }> = [
  { id: "director", label: "Director" },
  { id: "audio", label: "Audio" },
  { id: "graphics", label: "Graphics" },
  { id: "compact", label: "Compact / touch" },
];

const WORKSPACE_KEY = "alcantara.console.workspace";
const DOCK_WIDTH_KEY = "alcantara.console.dockWidth";
const TOUCH_KEY = "alcantara.console.touchMode";
const SHORTCUTS_KEY = "alcantara.console.shortcutsEnabled";

export function readStoredConsoleWorkspace(): ConsoleWorkspace {
  if (typeof window === "undefined") return "director";
  const value = window.localStorage.getItem(WORKSPACE_KEY);
  return WORKSPACES.some((workspace) => workspace.id === value)
    ? (value as ConsoleWorkspace)
    : "director";
}

function blocksBroadcastShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, button, a, [contenteditable="true"], [role="button"], [role="slider"], [role="dialog"]',
    ),
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
  const latestPropsRef = useRef(props);
  latestPropsRef.current = props;
  const [touchMode, setTouchMode] = useState(false);
  const [shortcutsEnabled, setShortcutsEnabled] = useState(true);
  const [dockWidth, setDockWidth] = useState(320);
  const pendingStageRef = useRef<Promise<void>>(Promise.resolve());

  const stageScene = (sceneId: number | null) => {
    const pending = Promise.resolve(props.onStageScene(sceneId));
    pendingStageRef.current = pending;
    return pending;
  };
  const takeStagedScene = async () => {
    await pendingStageRef.current;
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    latestPropsRef.current.onTake();
  };
  const cutStagedScene = async () => {
    await pendingStageRef.current;
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    latestPropsRef.current.onCut();
  };

  useEffect(() => {
    try {
      setTouchMode(
        window.localStorage.getItem(TOUCH_KEY) === "true" ||
          new URLSearchParams(window.location.search).get("surface") ===
            "touch",
      );
      setShortcutsEnabled(
        window.localStorage.getItem(SHORTCUTS_KEY) !== "false",
      );
      const width = Number(window.localStorage.getItem(DOCK_WIDTH_KEY));
      setDockWidth(
        Number.isFinite(width) && width >= 260 && width <= 520 ? width : 320,
      );
    } catch {
      setTouchMode(false);
      setShortcutsEnabled(true);
      setDockWidth(320);
    }
  }, []);

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
    window.localStorage.setItem(WORKSPACE_KEY, workspace);
    props.onWorkspaceChange(workspace);
  };
  const toggleTouch = () => {
    const next = !touchMode;
    setTouchMode(next);
    window.localStorage.setItem(TOUCH_KEY, String(next));
  };
  const toggleShortcuts = () => {
    const next = !shortcutsEnabled;
    setShortcutsEnabled(next);
    window.localStorage.setItem(SHORTCUTS_KEY, String(next));
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
                setDockWidth(next);
                window.localStorage.setItem(DOCK_WIDTH_KEY, String(next));
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
