import { useEffect, useState } from "react";
import { Button, LoadingSpinner } from "@gaulatti/bleecker";
import { Copy, KeyRound } from "lucide-react";
import {
  fetchRendererKey,
  rotateRendererKey,
  type RendererKeyMetadata,
} from "../services/rendererKey";

const when = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "Never";

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Renderer key unavailable";

/**
 * One show's renderer key: its dates and version, and issuing or rotating it. The new key is held only while this
 * panel is open, shown once, and never stored by the page.
 */
export function RendererKeyPanel({ programId }: { programId: string }) {
  const [metadata, setMetadata] = useState<RendererKeyMetadata | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void fetchRendererKey(programId)
      .then((loaded) => {
        if (mounted) setMetadata(loaded);
      })
      .catch((cause) => {
        if (mounted) setError(message(cause));
      });
    return () => {
      mounted = false;
    };
  }, [programId]);

  const rotate = async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const { key, ...next } = await rotateRendererKey(programId);
      setIssued(key);
      setMetadata(next);
      setConfirming(false);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
    } catch {
      setError("Could not copy. Select the key and copy it by hand.");
    }
  };

  return (
    <div className="space-y-4 text-sm">
      {error && (
        <p role="alert" className="text-terracotta">
          {error}
        </p>
      )}
      {!metadata ? (
        !error && <LoadingSpinner />
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-text-secondary">Version</dt>
            <dd>{metadata.exists ? metadata.version : "No key"}</dd>
            {metadata.exists && (
              <>
                <dt className="text-text-secondary">Issued</dt>
                <dd>{when(metadata.createdAt)}</dd>
                <dt className="text-text-secondary">Rotated</dt>
                <dd>{when(metadata.rotatedAt)}</dd>
                <dt className="text-text-secondary">Last used</dt>
                <dd>{when(metadata.lastUsedAt)}</dd>
              </>
            )}
          </dl>
          {issued && (
            <div className="space-y-2 rounded-xl border border-border-subtle p-3">
              <p className="font-semibold">
                Copy this key now. It is not shown again.
              </p>
              <code
                aria-label="New renderer key"
                className="block select-all break-all"
              >
                {issued}
              </code>
              <Button
                type="button"
                size="xs"
                variant="secondary"
                onClick={() => void copy(issued)}
              >
                <Copy size={13} /> {copied ? "Copied" : "Copy key"}
              </Button>
            </div>
          )}
          {confirming ? (
            <div className="space-y-2">
              <p>
                The current key stops working at once. Anything still using it
                loses calls and the return feed until it has the new one.
              </p>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void rotate()}
                >
                  Replace key
                </Button>
              </div>
            </div>
          ) : (
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                metadata.exists ? setConfirming(true) : void rotate()
              }
            >
              <KeyRound size={13} />{" "}
              {metadata.exists ? "Rotate key" : "Issue key"}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
