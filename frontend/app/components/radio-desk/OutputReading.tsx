import { AlertTriangle, Radio } from "lucide-react";
import { useOutputUnverified } from "./useOutputUnverified";

/** The output confidence heading and its reading. Its own component, so the freshness tick renders only this. */
export function OutputReading({ output }: { output: { state: string; lastSampleAt: string | null } | null }) {
  const unverified = useOutputUnverified(output);
  const tone =
    output?.state === "silent" || output?.state === "unavailable"
      ? "live"
      : output?.state === "audible" && !unverified
        ? "ready"
        : "warning";
  const label = unverified
    ? "Output unverified"
    : output?.state === "audible"
      ? "Engine audio detected"
      : output?.state === "silent"
        ? "Expected audio is silent"
        : output?.state === "unavailable"
          ? "Output unavailable"
          : output?.state === "idle"
            ? "Output idle"
            : output?.state === "checking"
              ? "Checking output"
              : "Output unverified";
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="console-eyebrow">Output confidence</span>
        {tone === "live" ? <AlertTriangle size={14} /> : <Radio size={14} />}
      </div>
      <span role="status" className="console-status mt-2" data-tone={tone}>
        {label}
      </span>
    </>
  );
}
