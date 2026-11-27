import { TooltipButton } from "./BleeckerButtons";
import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router";
import { AppLoading } from "./AppLoading";
import type { ProgramType } from "../utils/appNavigation";
import { useGlobalProgramId } from "../utils/globalProgram";
import { useFeatures } from "../hooks/useFeatures";
const ScheduledRundown = lazy(() => import("./ScheduledRundown"));
const ManualRundown = lazy(() => import("./ManualRundown"));
const RecipeEditor = lazy(() => import("./RecipeEditor"));

export function RundownWorkspace({
  programType,
}: {
  programType: ProgramType | null;
}) {
  const [programId] = useGlobalProgramId();
  const [dirty, setDirty] = useState(false);
  const [search, setSearch] = useSearchParams();
  const { hasPermission } = useFeatures();
  if (!programType) return <AppLoading />;
  const scheduled =
    programType === "radio" ||
    (programType === "both" && search.get("view") !== "operator");
  // Recipes belong to operator sequences, so they sit beside the operator cues (gaulatti/alcantara#426).
  const canReadRecipes = hasPermission("alcantara:flight:read");
  const canManageRecipes = hasPermission("alcantara:flight:manage");
  const showRecipes = !scheduled && canReadRecipes && search.get("tab") === "recipes";
  const timingNav = programType === "both" ? (
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
  ) : null;
  return (
    <>
      {!scheduled && timingNav}
      {!scheduled && canReadRecipes && (
        <nav
          aria-label="Operator rundown tabs"
          className="flex gap-2 border-b border-border-subtle bg-dark-sand px-6 py-3"
        >
          {[
            { tab: "cues", label: "Cues" },
            { tab: "recipes", label: "Recipes" },
          ].map(({ tab, label }) => (
            <TooltipButton
              key={tab}
              type="button"
              aria-pressed={showRecipes === (tab === "recipes")}
              className="rounded-lg border border-border-subtle px-4 py-2 text-sm text-text-primary aria-pressed:border-accent-blue aria-pressed:bg-accent-blue/15"
              onClick={() => {
                const next = new URLSearchParams(search);
                if (tab === "recipes") next.set("tab", "recipes");
                else next.delete("tab");
                setSearch(next);
              }}
            >
              {label}
            </TooltipButton>
          ))}
        </nav>
      )}
      <Suspense fallback={<AppLoading />}>
        {showRecipes ? (
          <RecipeEditor key={programId} programId={programId} canManage={canManageRecipes} />
        ) : scheduled ? (
          <ScheduledRundown key={programId} onDirtyChange={setDirty} viewSwitch={timingNav} />
        ) : (
          <ManualRundown key={programId} />
        )}
      </Suspense>
    </>
  );
}
