import {
  Button,
  Card,
  LoadingSpinner,
  SectionHeader,
} from "@gaulatti/bleecker";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { AppPage } from "../components/AppPage";
import { RadioOutputPlayer } from "../components/RadioOutputPlayer";
import { apiUrl } from "../utils/apiBaseUrl";
import { useGlobalProgramId } from "../utils/globalProgram";

export default function RadioOutput() {
  const { programId = "" } = useParams();
  const [, setSelectedProgram] = useGlobalProgramId();
  const [listenerUrl, setListenerUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setListenerUrl(null);
    setError(null);
    void fetch(apiUrl(`/radio/${encodeURIComponent(programId)}/settings`), {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            `Radio monitor settings could not be loaded (${response.status}).`,
          );
        const settings = await response.json();
        if (!controller.signal.aborted)
          setListenerUrl(settings?.listenerUrl ?? null);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Radio monitor settings could not be loaded.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [programId]);
  return (
    <AppPage className="space-y-6">
      <SectionHeader
        title={`Radio Program · ${programId}`}
        description="Listen to the audio published for your audience."
      />
      <Card>
        {loading ? (
          <div role="status" className="flex items-center gap-3">
            <LoadingSpinner size="sm" /> Loading listener settings…
          </div>
        ) : error ? (
          <p role="alert" className="text-terracotta">
            {error}
          </p>
        ) : listenerUrl ? (
          <RadioOutputPlayer listenerUrl={listenerUrl} />
        ) : (
          <div className="space-y-3">
            <p>No listener stream URL is configured for this station.</p>
            <p className="text-sm text-text-secondary">
              Set its public HTTPS stream URL in Radio distribution.
            </p>
          </div>
        )}
      </Card>
      <div className="flex flex-wrap items-center gap-4">
        <Link to="/" onClick={() => setSelectedProgram(programId)}>
          Back to Radio desk
        </Link>
        <Button
          as="a"
          href="/radio-settings"
          variant="secondary"
          onClick={() => setSelectedProgram(programId)}
        >
          Radio distribution
        </Button>
      </div>
    </AppPage>
  );
}
