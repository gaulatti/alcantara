import { useState } from "react";
import { Button, Input } from "@gaulatti/bleecker";
import { Save, Trash2 } from "lucide-react";
import type { RadioClock } from "../services/dayparts";
import type { RadioLogRules } from "../services/flight";
import { TagBlockFields } from "./TagBlockFields";

const emptyRules = (): RadioLogRules => ({
  slots: [{ labelId: "", count: 1, clockOffsetSeconds: 0 }],
  artistSeparation: 2,
});

/** One clock's name and music blocks; `clock` null is a new one. */
export function ClockEditor({
  clock,
  labels,
  busy,
  onSave,
  onDelete,
}: {
  clock: RadioClock | null;
  labels: { id: string; name: string }[];
  busy: boolean;
  onSave: (value: { name: string; rules: RadioLogRules }) => void;
  onDelete: (clock: RadioClock) => void;
}) {
  const [name, setName] = useState(clock?.name ?? "");
  const [rules, setRules] = useState<RadioLogRules>(
    () => clock?.rules ?? emptyRules(),
  );
  return (
    <fieldset
      disabled={busy}
      className="space-y-3"
      aria-label={clock ? `Clock ${clock.name}` : "New clock"}
    >
      <label className="block text-xs">
        Clock name
        <Input
          aria-label="Clock name"
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <TagBlockFields
        rules={rules}
        onChange={setRules}
        labels={labels}
        disabled={busy}
      />
      <div className="flex justify-between gap-2">
        <Button
          type="button"
          onClick={() => onSave({ name: name.trim(), rules })}
          disabled={!name.trim() || rules.slots.some((slot) => !slot.labelId)}
        >
          <Save size={13} /> Save clock
        </Button>
        {clock && (
          <Button type="button" variant="ghost" onClick={() => onDelete(clock)}>
            <Trash2 size={13} /> Delete clock
          </Button>
        )}
      </div>
    </fieldset>
  );
}
