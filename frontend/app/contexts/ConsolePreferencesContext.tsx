import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSelector } from "react-redux";
import { currentUser, isLoaded as isAuthLoaded } from "../state/selectors/auth";
import { getApiBaseUrl } from "../utils/apiBaseUrl";

export type DeviceClass = "desktop" | "tablet" | "phone";
export type ConsoleWorkspace = "director" | "audio" | "graphics" | "compact";
export interface ConsoleProfile {
  workspace: ConsoleWorkspace;
  dockWidth?: number;
  touchMode: boolean;
  shortcutsEnabled: boolean;
  selectedProgramId: string;
  transitions: Record<string, string>;
}
type SyncState = "loading" | "synced" | "saving" | "degraded" | "conflict";
interface ConflictState {
  local: ConsoleProfile;
  authoritative: ConsoleProfile;
  version: number;
}

interface ConsolePreferencesValue {
  deviceClass: DeviceClass;
  detectedDeviceClass: DeviceClass;
  profile: ConsoleProfile;
  version: number;
  syncState: SyncState;
  conflict: ConflictState | null;
  updateProfile(update: Partial<ConsoleProfile>): void;
  setDeviceClassOverride(value: DeviceClass | null): void;
  resetCurrent(): Promise<void>;
  resetAll(): Promise<void>;
  useAuthoritative(): void;
  retryLocal(): void;
  adoptAcknowledged(version: number, profile: ConsoleProfile): void;
}

const Context = createContext<ConsolePreferencesValue | null>(null);
const OVERRIDE_KEY = "alcantara.console.deviceClassOverride";

export function detectDeviceClass(
  scope?: Pick<Window, "innerWidth" | "navigator">,
): DeviceClass {
  if (!scope) {
    if (typeof window === "undefined") return "desktop";
    scope = window;
  }
  const ua = scope.navigator.userAgent.toLowerCase();
  if (/iphone|ipod|android.+mobile/.test(ua) || scope.innerWidth < 768)
    return "phone";
  if (
    /ipad|tablet/.test(ua) ||
    (scope.navigator.platform === "MacIntel" &&
      scope.navigator.maxTouchPoints > 1) ||
    scope.innerWidth < 1180
  )
    return "tablet";
  return "desktop";
}

export function defaultConsoleProfile(
  deviceClass: DeviceClass,
): ConsoleProfile {
  return {
    workspace: deviceClass === "desktop" ? "director" : "compact",
    ...(deviceClass === "phone"
      ? {}
      : { dockWidth: deviceClass === "desktop" ? 320 : 300 }),
    touchMode: deviceClass !== "desktop",
    shortcutsEnabled: deviceClass === "desktop",
    selectedProgramId: "main",
    transitions: { main: "crescendo-prism" },
  };
}

function readOverride(): DeviceClass | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(OVERRIDE_KEY);
  return value === "desktop" || value === "tablet" || value === "phone"
    ? value
    : null;
}

function cacheKey(subject: string, deviceClass: DeviceClass): string {
  return `alcantara.console.acknowledged.${encodeURIComponent(subject)}.${deviceClass}`;
}

function readCache(
  subject: string,
  deviceClass: DeviceClass,
): { version: number; profile: ConsoleProfile } | null {
  try {
    const value = JSON.parse(
      window.localStorage.getItem(cacheKey(subject, deviceClass)) ?? "null",
    ) as { version?: unknown; profile?: unknown } | null;
    if (
      !value ||
      !Number.isSafeInteger(value.version) ||
      !value.profile ||
      typeof value.profile !== "object"
    )
      return null;
    return value as { version: number; profile: ConsoleProfile };
  } catch {
    return null;
  }
}

export function ConsolePreferencesProvider({
  children,
}: {
  children: ReactNode;
}) {
  const user = useSelector(currentUser);
  const authLoaded = useSelector(isAuthLoaded);
  const detectedDeviceClass = useMemo(() => detectDeviceClass(), []);
  const [deviceClass, setDeviceClass] = useState<DeviceClass>(
    () => readOverride() ?? detectedDeviceClass,
  );
  const [profile, setProfile] = useState<ConsoleProfile>(() =>
    defaultConsoleProfile(deviceClass),
  );
  const [version, setVersion] = useState(0);
  const [syncState, setSyncState] = useState<SyncState>("loading");
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const dirty = useRef(false);
  const profileRef = useRef(profile);
  const versionRef = useRef(version);
  profileRef.current = profile;
  versionRef.current = version;

  const acknowledge = useCallback(
    (subject: string, nextVersion: number, nextProfile: ConsoleProfile) => {
      setVersion(nextVersion);
      setProfile(nextProfile);
      window.localStorage.setItem(
        cacheKey(subject, deviceClass),
        JSON.stringify({ version: nextVersion, profile: nextProfile }),
      );
    },
    [deviceClass],
  );

  useEffect(() => {
    if (!authLoaded || !user?.id) return;
    dirty.current = false;
    setConflict(null);
    const cached = readCache(user.id, deviceClass);
    if (cached) acknowledge(user.id, cached.version, cached.profile);
    else {
      setProfile(defaultConsoleProfile(deviceClass));
      setVersion(0);
    }
    setSyncState("loading");
    void fetch(`${getApiBaseUrl()}/operator-preferences/${deviceClass}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<{
          version: number;
          profile: ConsoleProfile;
        }>;
      })
      .then((payload) => {
        acknowledge(user.id, payload.version, payload.profile);
        setSyncState("synced");
      })
      .catch(() => setSyncState("degraded"));
  }, [acknowledge, authLoaded, deviceClass, user?.id]);

  const save = useCallback(async () => {
    if (!user?.id || !dirty.current || conflict) return;
    dirty.current = false;
    const local = profileRef.current;
    setSyncState("saving");
    try {
      const response = await fetch(
        `${getApiBaseUrl()}/operator-preferences/${deviceClass}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: versionRef.current, profile: local }),
        },
      );
      if (response.status === 409) {
        const body = (await response.json()) as {
          authoritative: { version: number; profile: ConsoleProfile };
        };
        setConflict({
          local,
          authoritative: body.authoritative.profile,
          version: body.authoritative.version,
        });
        setSyncState("conflict");
        return;
      }
      if (!response.ok) throw new Error(String(response.status));
      const saved = (await response.json()) as {
        version: number;
        profile: ConsoleProfile;
      };
      acknowledge(user.id, saved.version, saved.profile);
      setSyncState("synced");
    } catch {
      dirty.current = true;
      setSyncState("degraded");
    }
  }, [acknowledge, conflict, deviceClass, user?.id]);

  useEffect(() => {
    if (!dirty.current || conflict) return;
    const timer = window.setTimeout(() => void save(), 700);
    return () => window.clearTimeout(timer);
  }, [conflict, profile, save]);

  useEffect(() => {
    if (syncState !== "degraded" || !dirty.current || conflict) return;
    const timer = window.setInterval(() => void save(), 5_000);
    return () => window.clearInterval(timer);
  }, [conflict, save, syncState]);

  useEffect(() => {
    if (
      syncState !== "degraded" ||
      dirty.current ||
      conflict ||
      !user?.id
    )
      return;
    const timer = window.setInterval(() => {
      void fetch(`${getApiBaseUrl()}/operator-preferences/${deviceClass}`)
        .then(async (response) => {
          if (!response.ok) throw new Error(String(response.status));
          return response.json() as Promise<{
            version: number;
            profile: ConsoleProfile;
          }>;
        })
        .then((payload) => {
          acknowledge(user.id, payload.version, payload.profile);
          setSyncState("synced");
        })
        .catch(() => setSyncState("degraded"));
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [acknowledge, conflict, deviceClass, syncState, user?.id]);

  const updateProfile = useCallback((update: Partial<ConsoleProfile>) => {
    dirty.current = true;
    setProfile((current) => ({ ...current, ...update }));
  }, []);

  const setDeviceClassOverride = useCallback(
    (value: DeviceClass | null) => {
      if (value) window.localStorage.setItem(OVERRIDE_KEY, value);
      else window.localStorage.removeItem(OVERRIDE_KEY);
      setDeviceClass(value ?? detectedDeviceClass);
    },
    [detectedDeviceClass],
  );

  const reset = useCallback(
    async (all: boolean) => {
      if (!user?.id) return;
      const response = await fetch(
        `${getApiBaseUrl()}/operator-preferences${all ? "" : `/${deviceClass}`}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error(`Reset failed (${response.status})`);
      if (all) {
        (["desktop", "tablet", "phone"] as DeviceClass[]).forEach((target) =>
          window.localStorage.removeItem(cacheKey(user.id, target)),
        );
      } else {
        window.localStorage.removeItem(cacheKey(user.id, deviceClass));
      }
      acknowledge(user.id, 0, defaultConsoleProfile(deviceClass));
      dirty.current = false;
      setSyncState("synced");
    },
    [acknowledge, deviceClass, user?.id],
  );

  const value: ConsolePreferencesValue = {
    deviceClass,
    detectedDeviceClass,
    profile,
    version,
    syncState,
    conflict,
    updateProfile,
    setDeviceClassOverride,
    resetCurrent: () => reset(false),
    resetAll: () => reset(true),
    useAuthoritative: () => {
      if (!conflict || !user?.id) return;
      acknowledge(user.id, conflict.version, conflict.authoritative);
      setConflict(null);
      setSyncState("synced");
    },
    retryLocal: () => {
      if (!conflict) return;
      setVersion(conflict.version);
      setProfile(conflict.local);
      setConflict(null);
      dirty.current = true;
      setSyncState("degraded");
    },
    adoptAcknowledged: (nextVersion, nextProfile) => {
      if (!user?.id) return;
      dirty.current = false;
      acknowledge(user.id, nextVersion, nextProfile);
      setConflict(null);
      setSyncState("synced");
    },
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useConsolePreferences(): ConsolePreferencesValue {
  const value = useContext(Context);
  if (!value) throw new Error("ConsolePreferencesProvider is missing");
  return value;
}
