import { Input } from "@gaulatti/bleecker";
import type { FlightCue } from "../models/broadcast";

type NumberField =
  | "voiceTrackInstantId"
  | "voiceDuckGain"
  | "voiceFadeInSeconds"
  | "voiceFadeOutSeconds"
  | "sceneId";

const NUMBER_FIELDS: Array<{
  field: NumberField;
  label: string;
  min: number;
  max?: number;
  step: string;
}> = [
  {
    field: "voiceTrackInstantId",
    label: "Voice track clip id",
    min: 1,
    step: "1",
  },
  {
    field: "voiceDuckGain",
    label: "Music under voice (0–1)",
    min: 0,
    max: 1,
    step: "0.05",
  },
  {
    field: "voiceFadeInSeconds",
    label: "Voice fade in (s)",
    min: 0,
    step: "0.1",
  },
  {
    field: "voiceFadeOutSeconds",
    label: "Voice fade out (s)",
    min: 0,
    step: "0.1",
  },
  { field: "sceneId", label: "Scene id", min: 1, step: "1" },
];

/**
 * The raw cue parameters, behind Advanced (gaulatti/alcantara#299): the
 * stored FlightCue fields the timeline does not draw. An empty field removes
 * the parameter. metadataPatch and mixerChange are shown as stored and are
 * edited only through the API.
 */
export function RundownAdvanced({
  cue,
  disabled,
  onChange,
}: {
  cue: FlightCue;
  disabled: boolean;
  onChange: (patch: Partial<FlightCue>) => void;
}) {
  return (
    <details className="rundown-advanced">
      <summary>Advanced</summary>
      <div className="rundown-advanced-body">
        {NUMBER_FIELDS.map(({ field, label, min, max, step }) => (
          <label key={field}>
            {label}
            <Input
              aria-label={label}
              type="number"
              min={String(min)}
              max={max === undefined ? undefined : String(max)}
              step={step}
              value={cue[field] ?? ""}
              disabled={disabled}
              onChange={(event) =>
                onChange({
                  [field]:
                    event.target.value === ""
                      ? undefined
                      : Number(event.target.value),
                })
              }
            />
          </label>
        ))}
        <label>
          Transition id
          <Input
            aria-label="Transition id"
            value={cue.transitionId ?? ""}
            disabled={disabled}
            onChange={(event) =>
              onChange({ transitionId: event.target.value || undefined })
            }
          />
        </label>
        <label className="rundown-advanced-check">
          <input
            type="checkbox"
            checked={!!cue.isFiller}
            disabled={disabled}
            onChange={(event) =>
              onChange({ isFiller: event.target.checked || undefined })
            }
          />
          Filler (may be cut at the next fixed start)
        </label>
        <pre aria-label="Cue as stored">{JSON.stringify(cue, null, 2)}</pre>
      </div>
    </details>
  );
}
