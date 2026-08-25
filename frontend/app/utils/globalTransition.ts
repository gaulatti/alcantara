import { useCallback } from "react";
import { useConsolePreferences } from "../contexts/ConsolePreferencesContext";

export function useGlobalTransitionId(programId = "main") {
  const { profile, updateProfile } = useConsolePreferences();
  const normalizedProgramId = programId.trim() || "main";
  const transitionId =
    profile.transitions[normalizedProgramId] || "crescendo-prism";
  const setTransitionId = useCallback(
    (value: string) => {
      updateProfile({
        transitions: {
          ...profile.transitions,
          [normalizedProgramId]: value.trim() || "crescendo-prism",
        },
      });
    },
    [normalizedProgramId, profile.transitions, updateProfile],
  );
  return [transitionId, setTransitionId] as const;
}
