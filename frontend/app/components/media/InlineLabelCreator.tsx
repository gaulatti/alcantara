import { Button, Input, showAlert } from "@gaulatti/bleecker";
import { Plus } from "lucide-react";
import { useState, type FormEvent } from "react";

interface InlineLabelCreatorProps {
  onCreate: (name: string) => Promise<void>;
}

export function InlineLabelCreator({ onCreate }: InlineLabelCreatorProps) {
  const [name, setName] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedName = name.trim();
    if (!normalizedName) return;

    setIsCreating(true);
    try {
      await onCreate(normalizedName);
      setName("");
    } catch (error) {
      showAlert(
        error instanceof Error ? error.message : "Failed to create label.",
        "error",
      );
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-2 rounded-xl border border-dashed border-sand/40 p-3 sm:flex-row"
      onSubmit={(event) => void submit(event)}
    >
      <Input
        aria-label="New label name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="New label name"
      />
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        disabled={isCreating || !name.trim()}
      >
        <Plus size={14} />
        {isCreating ? "Creating…" : "Create and select"}
      </Button>
    </form>
  );
}
