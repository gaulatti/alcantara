import { useCallback } from "react";
import { useConsolePreferences } from "../contexts/ConsolePreferencesContext";

export function useGlobalProgramId() {
  const { profile, updateProfile } = useConsolePreferences();
  const setProgramId = useCallback(
    (value: string) => {
      updateProfile({ selectedProgramId: value.trim() || "main" });
    },
    [updateProfile],
  );
  return [profile.selectedProgramId, setProgramId] as const;
}
