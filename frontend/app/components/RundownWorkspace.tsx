import { TooltipButton } from "./BleeckerButtons";
import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router";
import { AppLoading } from "./AppLoading";
import type { ProgramType } from "../utils/appNavigation";
import { useGlobalProgramId } from "../utils/globalProgram";
const ScheduledRundown = lazy(() => import("./ScheduledRundown"));
const ManualRundown = lazy(() => import("./ManualRundown"));

export function RundownWorkspace({
  programType,
}: {
  programType: ProgramType | null;
}) {
  const [programId] = useGlobalProgramId();
  const [dirty, setDirty] = useState(false);
  const [search, setSearch] = useSearchParams();
  if (!programType) return <AppLoading />;
  const scheduled =
    programType === "radio" ||
    (programType === "both" && search.get("view") !== "operator");
  return (
    <>
      {programType === "both" && (
        <nav
          aria-label="Rundown timing"
          className="flex gap-2 border-b border-border-subtle bg-dark-sand px-6 py-3"
        >
          {[
            { view: "scheduled", label: "Timed blocks" },
            { view: "operator", label: "Operator cues" },
          ].map(({ view, label }) => (
            <TooltipButton
              key={view}
              type="button"
              disabled={dirty}
              title={
                dirty
                  ? "Save or discard changes before switching views"
                  : undefined
              }
              aria-pressed={scheduled === (view === "scheduled")}
              className="rounded-lg border border-border-subtle px-4 py-2 text-sm text-text-primary aria-pressed:border-accent-blue aria-pressed:bg-accent-blue/15 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => setSearch({ view })}
            >
              {label}
            </TooltipButton>
          ))}
        </nav>
      )}
      <Suspense fallback={<AppLoading />}>
        {scheduled ? (
          <ScheduledRundown key={programId} onDirtyChange={setDirty} />
        ) : (
          <ManualRundown key={programId} />
        )}
      </Suspense>
    </>
  );
}
