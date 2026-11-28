import type { Dispatch, SetStateAction } from "react";
import { Button, Input, Select } from "@gaulatti/bleecker";
import { Plus, Trash2 } from "lucide-react";
import type { RadioLogRules } from "../services/flight";

/** The tagged music blocks of radio log rules, edited the same way for one rundown and for a clock. */
export function TagBlockFields({
  rules,
  onChange,
  labels,
  disabled,
}: {
  rules: RadioLogRules;
  onChange: Dispatch<SetStateAction<RadioLogRules>>;
  labels: { id: string; name: string }[];
  disabled: boolean;
}) {
  const patchSlot = (
    index: number,
    patch: Partial<RadioLogRules["slots"][number]>,
  ) =>
    onChange((current) => ({
      ...current,
      slots: current.slots.map((slot, row) =>
        row === index ? { ...slot, ...patch } : slot,
      ),
    }));
  return (
    <>
        {rules.slots.map((slot, index) => (
          <div
            key={index}
            className="space-y-2 border-b border-border-subtle pb-3"
          >
            <div className="flex items-center justify-between">
              <span className="console-eyebrow">Block {index + 1}</span>
              {index > 0 && (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  aria-label={`Remove block ${index + 1}`}
                  onClick={() =>
                    onChange((current) => ({
                      ...current,
                      slots: current.slots.filter((_, row) => row !== index),
                    }))
                  }
                >
                  <Trash2 size={12} />
                </Button>
              )}
            </div>
            <Select
              aria-label={`Tag for block ${index + 1}`}
              value={slot.labelId}
              disabled={disabled}
              onChange={(value) => patchSlot(index, { labelId: value })}
              options={[
                { value: "", label: "Choose a Library tag" },
                ...labels.map((label) => ({
                  value: label.id,
                  label: label.name,
                })),
              ]}
            />
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs">
                Songs
                <Input
                  aria-label={`Song count for block ${index + 1}`}
                  type="number"
                  min="1"
                  max="120"
                  value={slot.count}
                  onChange={(event) =>
                    patchSlot(index, { count: Number(event.target.value) })
                  }
                />
              </label>
              <label className="text-xs">
                Fixed start (+sec)
                <Input
                  aria-label={`Fixed start for block ${index + 1}`}
                  type="number"
                  min="0"
                  placeholder="Follows"
                  disabled={index === 0}
                  value={slot.clockOffsetSeconds ?? ""}
                  onChange={(event) =>
                    patchSlot(index, {
                      clockOffsetSeconds:
                        event.target.value === ""
                          ? undefined
                          : Number(event.target.value),
                    })
                  }
                />
              </label>
            </div>
          </div>
        ))}
        <Button
          type="button"
          size="xs"
          variant="secondary"
          onClick={() =>
            onChange((current) => ({
              ...current,
              slots: [...current.slots, { labelId: "", count: 1 }],
            }))
          }
          disabled={rules.slots.length >= 120}
        >
          <Plus size={13} /> Music block
        </Button>
        <label className="block text-xs">
          Songs between the same artist
          <Input
            aria-label="Artist separation"
            type="number"
            min="0"
            max="20"
            value={rules.artistSeparation}
            onChange={(event) =>
              onChange((current) => ({
                ...current,
                artistSeparation: Number(event.target.value),
              }))
            }
          />
        </label>
    </>
  );
}
