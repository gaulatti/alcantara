import { Button } from "@gaulatti/bleecker";

/** The message every rotation surface shows while the rotation has not loaded: nothing it offers is saved. */
export const ROTATION_NOT_LOADED = "The rotation didn't load. Nothing can be changed until it does.";

/** A visible notice that the rotation has not loaded, with a Retry; edits stay disabled until a load succeeds. */
export function RotationLoadNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded border border-terracotta/50 px-3 py-2 text-sm text-terracotta"
    >
      <span>{ROTATION_NOT_LOADED}</span>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
