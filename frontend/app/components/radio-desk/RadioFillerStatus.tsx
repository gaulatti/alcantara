import { useCallback, useEffect, useState } from "react";
import type { FillerLegState, FillerVersionSummary, ProgramFillerState } from "../../models/filler";
import { apiUrl } from "../../utils/apiBaseUrl";

type Load =
  | { state: "loading" }
  | { state: "absent" }
  | { state: "unavailable" }
  | { state: "read"; leg: FillerLegState };

/** A version as the desk names it: its id, and its status when it is not ready. */
function versionLabel(version: FillerVersionSummary): string {
  return version.status === "ready" ? version.version : `${version.version} (${version.status})`;
}

/** One line per pointer of the program's radio filler leg, in the operator's words. */
export function radioFillerLines(leg: FillerLegState): string[] {
  if (leg.needsPreparing)
    return ["No program filler is prepared since the show was renamed: prepare one in Configure."];
  if (!leg.active && !leg.pending) return ["No program filler: the recovery playlist applies."];
  const lines: string[] = [];
  if (leg.active) lines.push(`On air: ${versionLabel(leg.active)}.`);
  if (leg.pending)
    lines.push(
      leg.active
        ? `Prepared next: ${versionLabel(leg.pending)}, used from the next Start with fallback.`
        : `Prepared: ${versionLabel(leg.pending)}, used at the next Start with fallback.`,
    );
  return lines;
}

/** The lines for a leg the desk already holds (the console fixture's). */
export function RadioFillerLines({ leg }: { leg: FillerLegState }) {
  return (
    <div className="console-recovery-filler" aria-label="Program filler">
      {radioFillerLines(leg).map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

/**
 * The program's radio filler on the desk (gaulatti/alcantara#126): which version is on air and which is prepared for
 * the next fallback start, from the filler read endpoint. Shows nothing for a program with no radio filler leg, a
 * backend without the endpoint, or a caller who may not read it. Read again whenever `refreshKey` changes, so a Start
 * or Stop with fallback shows at once.
 */
export function RadioFillerStatus({ programId, refreshKey }: { programId: string; refreshKey?: string }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });

  const read = useCallback(async () => {
    try {
      const response = await fetch(apiUrl(`/broadcast/programs/${encodeURIComponent(programId)}/fillers`));
      if (response.status === 403 || response.status === 404) {
        setLoad({ state: "absent" });
        return;
      }
      if (!response.ok) throw new Error(`filler status ${response.status}`);
      const body = (await response.json()) as ProgramFillerState;
      setLoad(body.legs?.radio ? { state: "read", leg: body.legs.radio } : { state: "absent" });
    } catch {
      setLoad({ state: "unavailable" });
    }
  }, [programId]);

  useEffect(() => {
    void read();
  }, [read, refreshKey]);

  if (load.state === "loading" || load.state === "absent") return null;
  if (load.state === "read") return <RadioFillerLines leg={load.leg} />;
  return (
    <div className="console-recovery-filler" aria-label="Program filler">
      <p>Program filler status unavailable.</p>
    </div>
  );
}
